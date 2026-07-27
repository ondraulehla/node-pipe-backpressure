// How large does a write to a child's stdin have to be before Node buffers it
// instead of handing it straight to the OS? That size is what separates a send
// that resolves immediately from one that has to wait for the stream.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// A child that never reads its stdin, so nothing we write can be consumed.
const DEAF_CHILD = 'setTimeout(() => {}, 5000)';

const LADDER_KB = [4, 8, 16, 32, 48, 64, 96, 128, 160, 192, 224, 256, 512];

function spawnDeafChild() {
    const child = spawn(process.execPath, ['-e', DEAF_CHILD], { stdio: ['pipe', 'pipe', 'ignore'] });
    // Without this, the EPIPE that arrives when we kill the child becomes an
    // unhandled 'error' event and takes the whole process down.
    child.stdin.on('error', () => {});
    return child;
}

const spawned = child => new Promise(resolve => child.once('spawn', resolve));

export async function measureThreshold() {
    const probe = spawnDeafChild();
    await spawned(probe);
    const highWaterMark = probe.stdin.writableHighWaterMark;
    probe.kill('SIGKILL');

    const ladder = [];
    for (const kb of LADDER_KB) {
        const child = spawnDeafChild();
        await spawned(child);
        // write() returns false once Node has to buffer, which is the signal
        // callers use for backpressure.
        const accepted = child.stdin.write('x'.repeat(kb * 1024) + '\n');
        ladder.push({ kb, accepted });
        child.kill('SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 25));
    }

    return {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        highWaterMark,
        firstBackpressureKB: ladder.find(row => !row.accepted)?.kb ?? null,
        ladder
    };
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
    const result = await measureThreshold();
    console.log(`${result.platform} ${result.arch} ${result.node}`);
    console.log(`writableHighWaterMark: ${result.highWaterMark}`);
    for (const { kb, accepted } of result.ladder) {
        console.log(`  ${String(kb).padStart(4)} KB -> write() returned ${accepted}${accepted ? '' : '   <- backpressure'}`);
    }
    console.log(`first size that backpressures: ${result.firstBackpressureKB ?? 'none in range'} KB`);
    process.exit(0);
}
