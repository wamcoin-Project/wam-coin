// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  solo_jobs_test.cpp -- the job a worker is still hashing must still exist
// ===========================================================================
//
//      wamd -regtest -daemon ...
//      g++ -std=c++17 -I../src -o solo_jobs_test solo_jobs_test.cpp
//      ./solo_jobs_test <rpcport> <cookie-path>
//
//  WHY THIS EXISTS, AND WHAT IT COST TO LEARN
//
//  On 2026-09-26 somebody put his machine on this chain, mined alone, and
//  solved height 7838 ninety-nine seconds after starting. The miner refused
//  to send the block:
//
//      error  could not submit the block: job 7838.9 is no longer held, so
//             the transactions it was built from are unknown.
//
//  Nothing was wrong with his node, his address, or his luck. The miner polls
//  getblocktemplate every five seconds, minted a fresh job id for every reply
//  whether or not anything had changed, and kept only the last EIGHT. Forty
//  seconds of memory, against a worker that holds one job until the tip moves
//  -- two minutes. Roughly two blocks in three could not be sent, on the one
//  feature the release was built for.
//
//  The unit test beside this one proves the comparison that decides when work
//  is new. This one proves the consequence against a real node: poll many
//  times with an idle mempool and the job must not change; mine a block and
//  the previous tip's job must still be submittable, because a block solved
//  against the tip that just moved is a competitor at the same height and has
//  won races before; mine another and the one before that may go.
//
//  It needs a node because the failure was never in the arithmetic. Every
//  step agreed with itself. It was in what the miner chose to forget.
// ===========================================================================

#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <chrono>

#include "rpc.h"
#include "solo.h"

using namespace wam;

static int failures = 0;
static int checks   = 0;

static void Ok(bool cond, const char* what)
{
    checks++;
    if (cond) { std::printf("  ok    %s\n", what); return; }
    failures++;
    std::printf("  FAIL  %s\n", what);
}

int main(int argc, char** argv)
{
    // USER AND PASSWORD AS WELL AS THE COOKIE, because a node that has an
    // rpcpassword does not write a cookie at all.
    //
    // This took only a cookie path, which is right for a node started with
    // no credentials. scripts/test/stranger.sh starts its regtest node from
    // a wam.conf carrying rpcuser and rpcpassword -- it has to, because the
    // explorer's RPC client has no cookie support and the pool config names
    // a user and a password -- so there is no cookie on disk for this to
    // read. Both forms are accepted now; neither changes what is asserted.
    //
    //      solo_jobs_test <port> [cookie-path] [user] [password]
    const int port = argc > 1 ? std::atoi(argv[1]) : 29554;
    const std::string cookie = argc > 2 ? argv[2] : std::string();
    const std::string user   = argc > 3 ? argv[3] : std::string();
    const std::string pass   = argc > 4 ? argv[4] : std::string();

    std::printf("\nsolo_jobs_test -- against a node on 127.0.0.1:%d\n", port);

    RpcClient rpc("127.0.0.1", port, user, pass, cookie);
    SoloSession solo(rpc, "wamrt1q9uynnmupf5jl920vgztyef0v3esfjvdzfxfhyt",
                     NetParamsFor("regtest"), "/wam-miner/");

    std::string error;
    if (!solo.Refresh(error)) {
        std::printf("  FAIL  could not reach the node: %s\n", error.c_str());
        return 1;
    }
    const std::string first = solo.Current().job.jobId;
    std::printf("  ..    first job %s\n", first.c_str());

    // TWENTY POLLS, NOTHING HAPPENING. Before the fix this minted twenty job
    // ids and remembered eight of them.
    for (int i = 0; i < 20; i++) {
        if (!solo.Refresh(error)) {
            std::printf("  FAIL  refresh %d failed: %s\n", i, error.c_str());
            return 1;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    Ok(solo.Current().job.jobId == first,
       "twenty polls with an idle mempool are still one job");
    Ok(solo.KnowsJob(first),
       "and a solution for it could still be turned into a block");
    Ok(solo.IssuedCount() == 1,
       "one job is remembered, not twenty");

    // A BLOCK ARRIVES. New work, new id -- and the old one survives, because
    // a worker may still be on it and its block would be a competitor.
    rpc.Call("generatetoaddress",
             "[1,\"wamrt1q9uynnmupf5jl920vgztyef0v3esfjvdzfxfhyt\"]");
    if (!solo.Refresh(error)) {
        std::printf("  FAIL  refresh after a block failed: %s\n", error.c_str());
        return 1;
    }
    const std::string second = solo.Current().job.jobId;
    Ok(second != first, "a new tip is a new job");
    Ok(solo.KnowsJob(first),
       "the job from the tip that just moved is still submittable");

    // ANOTHER BLOCK. Now the first is two generations back: a block built on
    // a grandparent cannot compete with anything, so it may be forgotten.
    rpc.Call("generatetoaddress",
             "[1,\"wamrt1q9uynnmupf5jl920vgztyef0v3esfjvdzfxfhyt\"]");
    if (!solo.Refresh(error)) {
        std::printf("  FAIL  refresh after a second block failed: %s\n",
                    error.c_str());
        return 1;
    }
    Ok(solo.KnowsJob(second),
       "the previous tip's job is still submittable");
    Ok(!solo.KnowsJob(first),
       "the job two tips back is dropped, because it can no longer be mined");

    std::printf("\n  %d checks, %d failure(s)\n\n", checks, failures);
    return failures ? 1 : 0;
}
