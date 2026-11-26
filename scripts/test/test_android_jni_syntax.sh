#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  test_android_jni_syntax.sh -- compile the phone's C++ without an NDK
# ===========================================================================
#
#  WHY THIS EXISTS
#
#  contrib/wam-miner-android/app/src/main/cpp/miner_jni.cpp is the only C++
#  in this project that nothing on a developer's machine compiles. The NDK
#  builds it, in CI or on a machine set up for Android, and everywhere else
#  it is a text file -- so an edit to it is unreviewed by any compiler until
#  a release build runs, and a release build is a late place to learn that
#  a brace is missing.
#
#  That is half of why it drifted. The other half was
#  scripts/check_android_miner.py diffing cpp/src and never cpp/ itself, so
#  the file was neither compiled nor compared. It was missing the desktop's
#  rekey cooldown and still carried an extranonce2 shift that is undefined
#  behaviour at size 8 -- both reported by mpit on 26 November 2026.
#
#  The two headers that only exist in the NDK are stubbed here, just enough
#  to parse: jni.h and android/log.h. Nothing is linked and nothing is run.
#  The question this answers is narrow and worth answering on every machine:
#  does the phone's C++ still compile?
#
#      exit 0  it parses
#      exit 1  it does not
#      exit 2  there is no C++ compiler here, so nothing was checked
# ===========================================================================

set -uo pipefail

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then GRN=; RED=; YLW=; BLD=; OFF=; fi

ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
CPP="$ROOT/contrib/wam-miner-android/app/src/main/cpp"
RANDOMX_INC="$ROOT/build/randomx/src"

printf '\n%s  the phone'"'"'s C++ still compiles%s\n\n' "$BLD" "$OFF"

if [ ! -f "$CPP/miner_jni.cpp" ]; then
    printf '  %sFAIL%s  %s is not there\n\n' "$RED" "$OFF" "$CPP/miner_jni.cpp"
    exit 1
fi

CXX=""
for c in clang++ g++; do
    command -v "$c" >/dev/null 2>&1 && { CXX="$c"; break; }
done
if [ -z "$CXX" ]; then
    printf '  %s!!%s    no C++ compiler here, so nothing was checked\n\n' \
           "$YLW" "$OFF"
    exit 2
fi

if [ ! -f "$RANDOMX_INC/randomx.h" ]; then
    printf '  %s!!%s    randomx.h is not in build/randomx/src, so nothing was\n' \
           "$YLW" "$OFF"
    printf '        checked. scripts/fetch-upstream.sh puts it there.\n\n'
    exit 2
fi

S="$(mktemp -d)"
trap 'rm -rf "$S"' EXIT
mkdir -p "$S/android"

# Just enough JNI to parse. Every signature here is from the NDK's own
# jni.h; where this is wrong the compiler says so and the fix is here, not
# in the file under test.
cat > "$S/jni.h" <<'EOF'
#pragma once
#include <cstdint>
#include <cstdarg>
typedef int32_t jint;
typedef int64_t jlong;
typedef uint8_t jboolean;
typedef void*   jobject;
typedef jobject jstring;
typedef jobject jclass;
typedef jobject jbyteArray;
typedef jobject jobjectArray;
typedef void*   jmethodID;
typedef void*   jfieldID;
typedef struct JNIEnv_ JNIEnv;
typedef struct JavaVM_ JavaVM;
struct JNIEnv_ {
    const char* GetStringUTFChars(jstring, jboolean*) { return ""; }
    void    ReleaseStringUTFChars(jstring, const char*) {}
    jstring NewStringUTF(const char*) { return nullptr; }
    jclass  GetObjectClass(jobject) { return nullptr; }
    jclass  FindClass(const char*) { return nullptr; }
    jmethodID GetMethodID(jclass, const char*, const char*) { return nullptr; }
    jmethodID GetStaticMethodID(jclass, const char*, const char*) { return nullptr; }
    void    CallStaticVoidMethod(jclass, jmethodID, ...) {}
    void    CallVoidMethod(jobject, jmethodID, ...) {}
    jobject NewGlobalRef(jobject) { return nullptr; }
    void    DeleteGlobalRef(jobject) {}
    void    DeleteLocalRef(jobject) {}
    jint    GetJavaVM(JavaVM**) { return 0; }
    jboolean ExceptionCheck() { return 0; }
    void    ExceptionClear() {}
    void    ExceptionDescribe() {}
    jbyteArray NewByteArray(jint) { return nullptr; }
    void    SetByteArrayRegion(jbyteArray, jint, jint, const void*) {}
};
struct JavaVM_ {
    jint AttachCurrentThread(JNIEnv**, void*) { return 0; }
    jint DetachCurrentThread() { return 0; }
    jint GetEnv(void**, jint) { return 0; }
};
#define JNIEXPORT
#define JNICALL
#define JNI_VERSION_1_6 0x00010006
#define JNI_TRUE  1
#define JNI_FALSE 0
#define JNI_OK    0
#define JNI_ERR   (-1)
#define JNI_EDETACHED (-2)
#define JNI_EVERSION  (-3)
EOF

cat > "$S/android/log.h" <<'EOF'
#pragma once
#include <cstdarg>
#define ANDROID_LOG_VERBOSE 2
#define ANDROID_LOG_DEBUG   3
#define ANDROID_LOG_INFO    4
#define ANDROID_LOG_WARN    5
#define ANDROID_LOG_ERROR   6
inline int __android_log_print(int, const char*, const char*, ...) { return 0; }
inline int __android_log_vprint(int, const char*, const char*, va_list) { return 0; }
EOF

log="$S/compile.log"
if "$CXX" -std=c++17 -fsyntax-only \
      -I "$S" -I "$CPP" -I "$CPP/src" -I "$RANDOMX_INC" \
      "$CPP/miner_jni.cpp" >"$log" 2>&1; then
    printf '  %sok%s    miner_jni.cpp parses (%s, stubbed jni.h)\n' \
           "$GRN" "$OFF" "$CXX"
    printf '\n  nothing was linked and nothing was run: this answers whether\n'
    printf '  the phone'"'"'s C++ compiles, which no other check on this machine does\n\n'
    exit 0
fi

printf '  %sFAIL%s  miner_jni.cpp does not compile\n\n' "$RED" "$OFF"
sed -n '1,30p' "$log" | sed 's/^/        /'
printf '\n        If the error names something missing from the stubbed jni.h\n'
printf '        above, widen the stub -- that is this file'"'"'s fault, not the\n'
printf '        phone'"'"'s. Anything else is a real compile error.\n\n'
exit 1
