#include <jni.h>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>
#include <memory>
#include <functional>
#include <cstring>
#include <android/log.h>

#include "randomx_engine.h"
#include "stratum.h"
#include "solo.h"

#define LOG_TAG "WAM_APK_NATIVE"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

void pipeMessageToAndroidUI(const std::string &message);

namespace wam {
    struct SharedState {
        std::mutex jobMutex;
        StratumJob job;
        std::atomic<uint64_t> jobEpoch{0};
        std::atomic<uint64_t> solvedEpoch{0};
        std::atomic<uint64_t> difficultyBits{0};
        std::atomic<bool> running{true};
        std::atomic<bool> connected{false};
        std::atomic<uint64_t> hashes{0};
        std::atomic<uint64_t> submitted{0};
        std::atomic<uint64_t> accepted{0};
        std::atomic<uint64_t> rejected{0};
        std::atomic<uint64_t> blocksFound{0};
        std::atomic<uint64_t> stale{0};
        std::atomic<uint64_t> lost{0};

        std::function<bool(const StratumJob &, const Bytes &extranonce2, uint32_t nonce,
                           bool isBlock, const uint8_t *hashedHeader)> onSolution;

        void SetDifficulty(double d) {
            uint64_t bits;
            std::memcpy(&bits, &d, sizeof(bits));
            difficultyBits.store(bits);
        }

        double GetDifficulty() const {
            const uint64_t bits = difficultyBits.load();
            double d;
            std::memcpy(&d, &bits, sizeof(d));
            return d > 0 ? d : 1.0;
        }
    };

    void WorkerLoop(int workerId, wam::RandomXEngine &engine, wam::SharedState &state);

    bool PublishJob(wam::RandomXEngine &engine, wam::SharedState &state, int threads,
                    const wam::StratumJob &incoming);
}

// Add a global tracking pointer at the top of your namespace/anonymous block alongside logMethodID:
namespace {
    std::mutex lifecycleMutex;
    std::unique_ptr<wam::RandomXEngine> globalEngine = nullptr;
    std::unique_ptr<wam::StratumClient> globalClient = nullptr;

    wam::SharedState globalSharedState;
    std::vector<std::thread> workerThreads;
    std::thread networkThread;

    std::atomic<bool> isNativeRunning(false);
    int activeCoresAllocated = 1;

    JavaVM *cachedJVM = nullptr;
    jobject cachedServiceRef = nullptr;
    jclass cachedServiceClass = nullptr; // <-- ADD THIS GLOBAL REFERENCE HOOK
    jmethodID logMethodID = nullptr;
}


void wamWorkerLoop(int workerId, wam::RandomXEngine &engine, wam::SharedState &state) {
    while (state.running.load() && !engine.VmsReady()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!state.running.load()) return;

    randomx_vm *vm = engine.Vm(size_t(workerId));
    if (!vm) {
        LOGE("Worker execution thread %d lacked an active VM assignment.", workerId);
        return;
    }

    std::mt19937 rng(uint32_t(std::chrono::steady_clock::now().time_since_epoch().count()) ^
                     uint32_t(workerId * 2654435761u));
    uint64_t seenEpoch = 0;
    wam::StratumJob job;
    uint8_t header[80];
    wam::Bytes en2;
    wam::Target shareTarget{};
    wam::Target blockTarget{};
    uint32_t nonce = rng();
    bool haveWork = false;
    const int kBatch = 64;

    while (state.running.load()) {
        const uint64_t epoch = state.jobEpoch.load();

        if (epoch != seenEpoch) {
            {
                std::lock_guard<std::mutex> lock(state.jobMutex);
                job = state.job;
            }
            seenEpoch = epoch;
            if (!job.valid) {
                haveWork = false;
                continue;
            }

            en2.assign(size_t(job.extranonce2Size), 0);
            for (int i = 0; i < job.extranonce2Size && i < 4; i++) {
                en2[size_t(i)] = uint8_t(uint32_t(workerId) >> (8 * (job.extranonce2Size - 1 - i)));
            }
            job.extranonce2Hex = wam::ToHex(en2);
            wam::BuildHeader(job, en2, header);

            shareTarget = wam::DifficultyToTarget(state.GetDifficulty());
            blockTarget = wam::BitsToTarget(job.nbits);
            haveWork = true;
        }

        if (!haveWork || state.solvedEpoch.load() == seenEpoch) {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
            continue;
        }

        {
            wam::RandomXEngine::HashLock lock(engine);
            wam::WriteLE32(header + 76, nonce);
            randomx_calculate_hash_first(vm, header, 80);

            for (int i = 0; i < kBatch; i++) {
                const uint32_t hashedNonce = nonce;
                nonce++;
                wam::WriteLE32(header + 76, nonce);

                uint8_t out[32];
                randomx_calculate_hash_next(vm, header, 80, out);
                state.hashes.fetch_add(1, std::memory_order_relaxed);

                uint8_t be[32];
                wam::PowHashToBigEndian(out, be);

                const bool isBlock = wam::MeetsTarget(be, blockTarget);
                const bool isShare = wam::MeetsTarget(be, shareTarget);

                if (isBlock || isShare) {
                    uint8_t solved[80];
                    std::memcpy(solved, header, 80);
                    wam::WriteLE32(solved + 76, hashedNonce);

                    state.submitted.fetch_add(1);
                    bool done = true;
                    if (state.onSolution) {
                        done = state.onSolution(job, en2, hashedNonce, isBlock, solved);
                    }
                    if (isBlock && done) {
                        state.solvedEpoch.store(seenEpoch);
                        break;
                    }
                }

                if (state.jobEpoch.load() != seenEpoch || state.solvedEpoch.load() == seenEpoch ||
                    engine.WriterWaiting() || !state.running.load()) {
                    break;
                }
            }

            // FIX FOR HARDWARE THROTTLING / STARVATION:
            // Force a minute scheduler yield at the end of each batch run pass.
            // On Samsung devices, this is ignored silently, but on OnePlus architectures,
            // it keeps the network thread alive by preventing complete core saturation lockup.
            std::this_thread::yield();
        }
    }
}

// =======================================================================
// FIX: Inject the UI piping handler directly inside the job dispatch layer
// =======================================================================
bool wamPublishJob(wam::RandomXEngine &engine, wam::SharedState &state, int threads,
                   const wam::StratumJob &incoming) {
    std::string seedErr;
    const wam::Bytes previous = engine.CurrentSeed();
    if (previous != incoming.seed) {
        if (!previous.empty()) {
            LOGI("RandomX context key rotating... recalculating dataset.");
            pipeMessageToAndroidUI("🔄 RandomX context key rotating... recalculating dataset.");
        } else {
            LOGI("Preparing RandomX allocations (this takes a moment)...");
            pipeMessageToAndroidUI("🧠 Preparing RandomX allocations (this takes a moment)...");
        }
        if (!engine.SetSeed(incoming.seed, seedErr)) {
            LOGE("Dataset error configuration pass dropped: %s", seedErr.c_str());
            pipeMessageToAndroidUI("❌ Dataset error configuration pass dropped: " + seedErr);
            state.running.store(false);
            return false;
        }
    }

    if (!engine.VmsReady()) {
        std::string vmErr;
        if (!engine.CreateVms(threads, vmErr)) {
            LOGE("VM context creation drop: %s", vmErr.c_str());
            pipeMessageToAndroidUI("❌ VM context creation drop: " + vmErr);
            state.running.store(false);
            return false;
        }
    }

    {
        std::lock_guard<std::mutex> lock(state.jobMutex);
        state.job = incoming;
    }
    state.jobEpoch.fetch_add(1);

    // =======================================================================
    // THE FIX: Format and push the text string straight to your UI buffer block
    // =======================================================================
    LOGI("Processing upstream mining job %s on height %lld", incoming.jobId.c_str(),
         (long long) incoming.height);

    std::string uiJobMsg = "🧱 Processing upstream mining job " + incoming.jobId +
                           " on height " + std::to_string(incoming.height);
    pipeMessageToAndroidUI(uiJobMsg);

    return true;
}


extern "C" {
JNIEXPORT jboolean JNICALL
Java_org_vslabs_wam_1miner_MinerNativeService_initializeNativeEngine(JNIEnv *env, jobject thiz,
                                                                     jint threads) {
    std::lock_guard<std::mutex> lock(lifecycleMutex);

    env->GetJavaVM(&cachedJVM);

    if (cachedServiceRef != nullptr) {
        env->DeleteGlobalRef(cachedServiceRef);
    }
    cachedServiceRef = env->NewGlobalRef(thiz);

// FIX: Look up and cache a Global Reference to the Class layout matrix
    if (cachedServiceClass != nullptr) {
        env->DeleteGlobalRef(cachedServiceClass);
    }
    jclass localClass = env->FindClass("org/vslabs/wam_miner/MinerNativeService");
    cachedServiceClass = (jclass) env->NewGlobalRef(localClass);

// Bind MethodID directly against the safely cached Global Class reference
    logMethodID = env->GetMethodID(cachedServiceClass, "dispatchNativeLogToUI",
                                   "(Ljava/lang/String;)V");
    env->DeleteLocalRef(localClass); // Clean up transient local handle safely

    if (globalEngine != nullptr) return JNI_TRUE;

    activeCoresAllocated = (threads > 0) ? threads : 1;
    globalEngine = std::make_unique<wam::RandomXEngine>();
    std::string initializationError;

    bool success = globalEngine->Init(activeCoresAllocated, true, false, initializationError);
    if (!success) {
        globalEngine.reset();
        return JNI_FALSE;
    }

    globalSharedState.running.store(true);
    globalSharedState.hashes.store(0);
    globalSharedState.accepted.store(0);
    globalSharedState.rejected.store(0);

    return JNI_TRUE;
}

JNIEXPORT void JNICALL
Java_org_vslabs_wam_1miner_MinerNativeService_startPoolMining(JNIEnv *env, jobject thiz,
                                                              jstring host_str, jint port,
                                                              jstring user_str, jstring pass_str) {
    std::lock_guard<std::mutex> lock(lifecycleMutex);
    if (isNativeRunning) return;

    const char *rawHost = env->GetStringUTFChars(host_str, nullptr);
    const char *rawUser = env->GetStringUTFChars(user_str, nullptr);
    const char *rawPass = env->GetStringUTFChars(pass_str, nullptr);

    std::string host(rawHost);
    std::string user(rawUser);
    std::string pass(rawPass);

    env->ReleaseStringUTFChars(host_str, rawHost);
    env->ReleaseStringUTFChars(user_str, rawUser);
    env->ReleaseStringUTFChars(pass_str, rawPass);

    isNativeRunning = true;
    globalSharedState.running.store(true);

    globalSharedState.onSolution = [](const wam::StratumJob &job, const wam::Bytes &,
                                      uint32_t nonce, bool, const uint8_t *) -> bool {
        if (globalClient && globalClient->IsConnected()) {
            globalClient->QueueSubmit(job.jobId, job.extranonce2Hex, wam::ToHexBE32(job.ntime),
                                      wam::ToHexBE32(nonce));
        }
        return true;
    };

//    networkThread = std::thread([host, port, user, pass]() {
//        globalClient = std::make_unique<wam::StratumClient>(host, uint16_t(port), user, pass);
//
//        globalClient->onLog = [](const std::string &m) {
//            pipeMessageToAndroidUI("[Stratum]: " + m);
//        };
//        globalClient->onError = [](const std::string &m) {
//            pipeMessageToAndroidUI("[Error]: " + m);
//        };
//
//        globalClient->onDifficulty = [](double d) {
//            globalSharedState.SetDifficulty(d);
//            globalSharedState.jobEpoch.fetch_add(1);
//            pipeMessageToAndroidUI("[Network]: Diff set to " + std::to_string(d));
//        };
//
//        globalClient->onSubmitResult = [](bool accepted, const std::string &reason) {
//            if (accepted) {
//                globalSharedState.accepted.fetch_add(1);
//                pipeMessageToAndroidUI("🚀 Share Accepted!");
//            } else {
//                globalSharedState.rejected.fetch_add(1);
//                pipeMessageToAndroidUI("❌ Share Rejected: " + reason);
//            }
//        };
//
//        globalClient->onJob = [](const wam::StratumJob &incoming) {
//            if (globalEngine) {
//                wamPublishJob(*globalEngine, globalSharedState, activeCoresAllocated, incoming);
//                pipeMessageToAndroidUI(
//                        "🧱 Block Template: Height " + std::to_string(incoming.height));
//            }
//        };
//
//        std::string runtimeConnectError;
//        if (!globalClient->Connect(runtimeConnectError)) {
//            isNativeRunning = false;
//            pipeMessageToAndroidUI("[Error]: Connect failed: " + runtimeConnectError);
//            return;
//        }
//
//        {
//            std::lock_guard<std::mutex> workerLock(lifecycleMutex);
//            workerThreads.clear();
//            for (int i = 0; i < activeCoresAllocated; i++) {
//                workerThreads.emplace_back(wamWorkerLoop, i, std::ref(*globalEngine),
//                                           std::ref(globalSharedState));
//            }
//        }
//
//        while (isNativeRunning) {
//            globalClient->Poll();
//            std::this_thread::sleep_for(std::chrono::milliseconds(200));
//        }
//
//        globalClient->Close();
//    });

    networkThread = std::thread([host, port, user, pass]() {
        // Run a continuous persistent reconnection supervisor container loop
        while (isNativeRunning) {
            globalClient = std::make_unique<wam::StratumClient>(host, uint16_t(port), user, pass);

            globalClient->onLog = [](const std::string &m) {
                pipeMessageToAndroidUI("[Stratum]: " + m);
            };
            globalClient->onError = [](const std::string &m) {
                pipeMessageToAndroidUI("[Error]: " + m);
            };

            globalClient->onDifficulty = [](double d) {
                globalSharedState.SetDifficulty(d);
                globalSharedState.jobEpoch.fetch_add(1);
                pipeMessageToAndroidUI("[Network]: Diff set to " + std::to_string(d));
            };

            globalClient->onSubmitResult = [](bool accepted, const std::string &reason) {
                if (accepted) {
                    globalSharedState.accepted.fetch_add(1);
                    pipeMessageToAndroidUI("🚀 Share Accepted!");
                } else {
                    globalSharedState.rejected.fetch_add(1);
                    pipeMessageToAndroidUI("❌ Share Rejected: " + reason);
                }
            };

            globalClient->onJob = [](const wam::StratumJob &incoming) {
                if (globalEngine) {
                    wamPublishJob(*globalEngine, globalSharedState, activeCoresAllocated, incoming);
                    pipeMessageToAndroidUI(
                            "🧱 Block Template: Height " + std::to_string(incoming.height));
                }
            };

            std::string runtimeConnectError;
            if (!globalClient->Connect(runtimeConnectError)) {
                pipeMessageToAndroidUI(
                        "[Error]: Connect failed: " + runtimeConnectError + ". Retrying in 5s...");
                std::this_thread::sleep_for(std::chrono::seconds(5));
                continue; // Loop back and attempt full socket initialization again
            }

            // Connection succeeded. Spawn workers if they aren't active yet
            {
                std::lock_guard<std::mutex> workerLock(lifecycleMutex);
                if (workerThreads.empty()) {
                    for (int i = 0; i < activeCoresAllocated; i++) {
                        workerThreads.emplace_back(wamWorkerLoop, i, std::ref(*globalEngine),
                                                   std::ref(globalSharedState));
                    }
                }
            }

            // Run client polling. Exit this sub-loop if connection drops or socket disconnects
            while (isNativeRunning && globalClient->IsConnected()) {
                globalClient->Poll();
                std::this_thread::sleep_for(std::chrono::milliseconds(200));
            }

            // If we broke out of the poll loop but the app is still alive, network dropped
            if (isNativeRunning) {
                pipeMessageToAndroidUI(
                        "🔄 Connection lost unexpectedly. Attempting automatic recovery...");
                globalClient->Close();
                std::this_thread::sleep_for(std::chrono::seconds(
                        3)); // Brief cooldown before recycling the socket instance
            }
        }

        if (globalClient != nullptr) {
            globalClient->Close();
        }
    });

}

JNIEXPORT void JNICALL
Java_org_vslabs_wam_1miner_MinerNativeService_terminateNativeEngine(JNIEnv *env, jobject thiz) {
    std::lock_guard<std::mutex> lock(lifecycleMutex);
    if (!isNativeRunning) return;

    isNativeRunning = false;
    globalSharedState.running.store(false);

    if (networkThread.joinable()) networkThread.join();
    for (std::thread &t: workerThreads) { if (t.joinable()) t.join(); }
    workerThreads.clear();

    if (globalClient != nullptr) globalClient.reset();
    if (globalEngine != nullptr) globalEngine.reset();

    // FIX: Clean up both cached global references seamlessly on teardown
    if (cachedServiceRef != nullptr) {
        env->DeleteGlobalRef(cachedServiceRef);
        cachedServiceRef = nullptr;
    }
    if (cachedServiceClass != nullptr) {
        env->DeleteGlobalRef(cachedServiceClass);
        cachedServiceClass = nullptr;
    }
    logMethodID = nullptr;
}

// Memory Accessors for startUIReportingLoop()
JNIEXPORT jlong JNICALL
Java_org_vslabs_wam_1miner_MinerNativeService_getNativeTotalHashes(JNIEnv *env, jobject thiz) {
    return (jlong) globalSharedState.hashes.load(std::memory_order_relaxed);
}

JNIEXPORT jlong JNICALL
Java_org_vslabs_wam_1miner_MinerNativeService_getNativeAcceptedShares(JNIEnv *env, jobject thiz) {
    return (jlong) globalSharedState.accepted.load(std::memory_order_relaxed);
}

JNIEXPORT jlong JNICALL
Java_org_vslabs_wam_1miner_MinerNativeService_getNativeRejectedShares(JNIEnv *env, jobject thiz) {
    return (jlong) globalSharedState.rejected.load(std::memory_order_relaxed);
}

JNIEXPORT void JNICALL
Java_org_vslabs_wam_1miner_MinerNativeActivity_destroyNativeMinerEngine(JNIEnv *env, jobject thiz) {
    LOGI("NativeActivity destroy engine request processed.");
}

} // extern "C"

// Thread-safe pipeline forwarding strings straight to your service class
void pipeMessageToAndroidUI(const std::string &message) {
    if (cachedJVM == nullptr || cachedServiceRef == nullptr || logMethodID == nullptr) return;

    JNIEnv *env = nullptr;
    bool needsDetach = false;
    jint getEnvStat = cachedJVM->GetEnv((void **) &env, JNI_VERSION_1_6);

    if (getEnvStat == JNI_EDETACHED) {
        if (cachedJVM->AttachCurrentThread(&env, nullptr) != 0) return;
        needsDetach = true;
    }

    jstring jmsg = env->NewStringUTF(message.c_str());
    env->CallVoidMethod(cachedServiceRef, logMethodID, jmsg);
    env->DeleteLocalRef(jmsg);

    if (needsDetach) {
        cachedJVM->DetachCurrentThread();
    }
}