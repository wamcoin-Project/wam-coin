'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  fakeMulti.js -- one definition of MULTI/EXEC for the test doubles
// ===========================================================================
//
//  WHY THIS FILE EXISTS
//
//  The same thing happened that fakeAtomic.js was written for, one command
//  later. On 2026-11-07 two money paths moved from redis.pipeline() to
//  redis.multi() -- the maturation credit and the share accounting -- and
//  five test files stopped with "this.redis.multi is not a function". Each
//  of them builds its own double knowing the subset of commands its own test
//  needs, so five files would have meant five hand-written MULTIs, in
//  doubles whose whole job is to behave like the thing they stand in for.
//
//  WHY THE PRODUCTION CODE MOVED, WHICH IS WHAT THIS HAS TO MODEL
//
//  An ioredis pipeline is a batch and not a transaction: the commands go out
//  together and redis applies them one by one, so a connection lost halfway
//  leaves the first few applied and the rest not. For the maturation credit
//  that meant some miners credited and others not, with the block's
//  maturation never ended. MULTI/EXEC is applied as one unit.
//
//  So a double that models MULTI as "a pipeline with a different name" would
//  let the fix pass its own test while proving nothing. The two properties
//  that matter here are both modelled:
//
//    1. ALL OR NOTHING. A connection lost during exec() applies no command,
//       not the first n. _multiFails is how a test asks for that.
//    2. ERRORS COME BACK AS DATA. ioredis resolves exec() with one
//       [error, result] pair per command, so a command that failed inside
//       the transaction arrives in the array rather than as a throw. Code
//       that does not read the array cannot tell a half-applied commit from
//       a clean one, and both call sites now read it.
//
//  A command the double does not have is an error naming the command, not a
//  silent no-op -- the same rule as attachUnsupported: a check that could
//  not look must never report that it looked.
// ===========================================================================

/**
 * Give a double a MULTI/EXEC over its own top-level commands.
 *
 * @param fake      the double; exec() calls fake.hincrby(...) and friends
 * @param controls  optional object read at exec() time:
 *                    failAll  -- truthy: reject exec() and apply nothing.
 *                               A string is used as the error message.
 *                  Passing the double itself is fine and usual, so a test
 *                  can set `redis._multiFails = true` between two calls.
 */
function attachMulti(fake, controls) {
    const knobs = controls || fake;

    fake.multi = function multi() {
        const queued = [];
        const api = {};

        // Everything the pool queues inside a MULTI today, plus the few a
        // nearby change would reach for. An unknown name is caught below,
        // where the test can see which one it was.
        const names = [
            'hincrby', 'hincrbyfloat', 'hset', 'hdel', 'del',
            'lpush', 'ltrim', 'lrem', 'lset',
            'sadd', 'srem', 'zadd', 'zrem',
            'incr', 'incrby', 'decrby', 'set', 'expire'
        ];
        for (const name of names) {
            api[name] = (...args) => { queued.push([name, args]); return api; };
        }

        api.exec = async () => {
            const failAll = knobs._multiFails;
            if (failAll) {
                // A real MULTI that never reached redis, or reached it and
                // died before EXEC, applies nothing at all. Applying the
                // first few here would model a pipeline and hide the whole
                // reason the production code stopped using one.
                throw new Error(typeof failAll === 'string'
                    ? failAll : 'connection lost before EXEC');
            }

            const replies = [];
            for (const [name, args] of queued) {
                if (typeof fake[name] !== 'function') {
                    throw new Error(
                        `MULTI queued ${name}, which this double does not ` +
                        'model. Nothing was asserted. Add it to the double ' +
                        'rather than letting the command disappear -- a ' +
                        'write that silently does not happen is the fault ' +
                        'these tests exist to catch.');
                }
                try {
                    replies.push([null, await fake[name](...args)]);
                } catch (err) {
                    // ioredis hands a failed command back inside the array.
                    replies.push([err, null]);
                }
            }
            return replies;
        };

        return api;
    };

    return fake;
}

module.exports = { attachMulti };
