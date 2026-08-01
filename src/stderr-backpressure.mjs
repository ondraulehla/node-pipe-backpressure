// Does process.stderr apply backpressure, and does a transform that waits for its own
// 'drain' after push() returns false deadlock because of it?
//
// Part A measures whether process.stderr.write() ever returns false on this platform and sink.
// Part B runs a transform in two variants, one that waits for 'drain' after a false push()
// and one that does not, and reports whether the waiting one parks.
//
// Everything is reported on stdout so that stderr stays free to be a pipe, a file or a tty.
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import os from 'node:os';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KB = 1024;

// ---------- part A ----------
const partA = () => {
    const chunk = Buffer.alloc(64 * KB, 0x61);
    let falses = 0;

    for (let i = 0; i < 40; i++) {
        if (process.stderr.write(chunk) === false) {
            falses++;
        }
    }

    return {
        isTTY: Boolean(process.stderr.isTTY),
        falseReturns: falses,
        writableLength: process.stderr.writableLength,
    };
};

// ---------- part B ----------
const START_TAG = '<<<CYPRESS.STDERR.START>>>';
const END_TAG = '<<<CYPRESS.STDERR.END>>>';

// Faithful copy of packages/stderr-filtering/lib/TagStream.ts transform(), with a counter
// and a switch for the variant under test.
class TagStream extends Transform {
    #decoder = new StringDecoder('utf8');
    pushFalse = 0;

    constructor(waitForDrain) {
        super({ transform: (...args) => this.transform(...args) });
        this.waitForDrain = waitForDrain;
    }

    tag(str) {
        return Buffer.from(START_TAG + str + END_TAG);
    }

    async transform(chunk, encoding, callback) {
        try {
            const out = chunk instanceof Buffer ? this.#decoder.write(chunk) : chunk;
            const transformed = out ? this.tag(out) : Buffer.from('');
            const canWrite = this.push(transformed);

            if (!canWrite) {
                this.pushFalse++;

                if (this.waitForDrain) {
                    await new Promise((resolve) => this.once('drain', resolve));
                }
            }

            callback();
        } catch (err) {
            callback(err);
        }
    }
}

const WRITER = `
const chunk = Buffer.alloc(8192, 0x62).toString();
let sent = 0;
const timer = setInterval(() => {
  if (sent >= 64) { clearInterval(timer); process.stdout.write(String(sent * 8192)); process.exit(0); }
  process.stderr.write(chunk);
  sent++;
}, 2);
`;

const partB = async (waitForDrain) => {
    const child = spawn(process.execPath, ['-e', WRITER], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childReported = '';

    child.stdout.on('data', (d) => {
        childReported += d.toString();
    });

    const ts = new TagStream(waitForDrain);

    // the shape used by packages/data-context/src/data/ProjectConfigIpc.ts
    child.stderr.pipe(ts).pipe(process.stderr);

    await sleep(4000);

    const result = {
        variant: waitForDrain ? 'waits for drain' : 'no wait',
        pushReturnedFalse: ts.pushFalse,
        parkedOnDrain: ts.listenerCount('drain') > 0,
        readableLength: ts.readableLength,
        writableLength: ts.writableLength,
        childWroteBytes: Number(childReported) || 0,
    };

    child.kill('SIGKILL');

    return result;
};

const report = {
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    partA: partA(),
    partB: [await partB(true), await partB(false)],
};

process.stdout.write(JSON.stringify(report, null, 2) + '\n');

const a = report.partA;
const waiting = report.partB[0];

process.stdout.write(
    `\nSUMMARY ${os.platform()} node ${process.version} stderr ${a.isTTY ? 'tty' : 'not a tty'}: ` +
        `stderr backpressure ${a.falseReturns > 0 ? 'YES' : 'no'}, ` +
        `push() returned false ${waiting.pushReturnedFalse} times, ` +
        `transform parked ${waiting.parkedOnDrain ? 'YES' : 'no'}\n`,
);
