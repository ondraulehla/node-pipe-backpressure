// What happens to a promise that waits for 'drain' when the child process dies
// before the stream ever drains? Answer: it is never settled again, because a
// destroyed stream does not emit 'drain'. This file measures that, and measures
// the write-callback shape that settles either way.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// 8 MB is past every backpressure threshold measured so far, so the write is
// guaranteed to be buffered rather than accepted outright.
const PAYLOAD = 'x'.repeat(8 * 1024 * 1024) + '\n';

// Dies on its own shortly after start, standing in for a server that crashes,
// gets OOM killed, or is terminated by its parent.
const DYING_CHILD = 'setTimeout(() => process.exit(0), 300)';
// Ignores stdin at first and only then starts reading, standing in for a slow
// but healthy peer. A correct implementation must not reject on this one.
const SLOW_CHILD = 'setTimeout(() => process.stdin.resume(), 500); setTimeout(() => {}, 4000)';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function spawnChild(script) {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    return child;
}

const spawned = child => new Promise(resolve => child.once('spawn', resolve));

// The shape that hangs: resolve on 'drain', with no path for failure at all.
const drainOnlySend = (stdin, payload) =>
    new Promise(resolve => {
        if (stdin.write(payload)) {
            resolve();
        } else {
            stdin.once('drain', resolve);
        }
    });

// The shape that cannot hang: the write callback runs on flush or on failure.
const writeCallbackSend = (stdin, payload) =>
    new Promise((resolve, reject) => {
        if (stdin.write(payload, error => (error ? reject(error) : resolve()))) {
            resolve();
        }
    });

async function observe({ send, childScript, waitMs }) {
    const child = spawnChild(childScript);
    await spawned(child);

    let outcome = 'pending';
    let reason = null;
    send(child.stdin, PAYLOAD).then(
        () => (outcome = 'resolved'),
        error => {
            outcome = 'rejected';
            reason = error?.code ?? error?.message ?? 'unknown';
        }
    );

    await sleep(waitMs);
    const observed = {
        outcome,
        reason,
        leakedDrainListeners: child.stdin.listenerCount('drain'),
        streamDestroyed: child.stdin.destroyed,
        childExitCode: child.exitCode
    };
    child.kill('SIGKILL');
    return observed;
}

export async function measureHang({ waitMs = 5000 } = {}) {
    return {
        platform: process.platform,
        node: process.version,
        waitMs,
        // The bug: nothing ever settles this promise, and the listener stays on
        // a stream that can no longer emit anything.
        drainOnlyAgainstDyingChild: await observe({ send: drainOnlySend, childScript: DYING_CHILD, waitMs }),
        // The fix: the same scenario now surfaces the real write error.
        writeCallbackAgainstDyingChild: await observe({ send: writeCallbackSend, childScript: DYING_CHILD, waitMs }),
        // The regression guard: a slow peer must still resolve, not reject, and
        // both shapes have to agree on that so the fix cannot be accused of
        // trading a hang for a spurious failure.
        writeCallbackAgainstSlowChild: await observe({ send: writeCallbackSend, childScript: SLOW_CHILD, waitMs: 2500 }),
        drainOnlyAgainstSlowChild: await observe({ send: drainOnlySend, childScript: SLOW_CHILD, waitMs: 2500 })
    };
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
    const result = await measureHang();
    console.log(`${result.platform} ${result.node}, observed for ${result.waitMs} ms\n`);
    for (const [name, r] of Object.entries(result)) {
        if (typeof r !== 'object' || r === null) continue;
        console.log(
            `${name}\n  outcome=${r.outcome}${r.reason ? ` (${r.reason})` : ''}` +
                ` destroyed=${r.streamDestroyed} leaked 'drain' listeners=${r.leakedDrainListeners}`
        );
    }
    process.exit(0);
}
