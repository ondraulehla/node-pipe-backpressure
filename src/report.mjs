// Runs both measurements and prints one markdown row for this platform and Node
// version. On GitHub Actions it also appends to the job summary and writes a
// JSON file so the aggregate job can assemble the full matrix table.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

import { measureHang } from './hang.mjs';
import { measureThreshold } from './threshold.mjs';

export function row({ threshold, hang }) {
    const hung = hang.drainOnlyAgainstDyingChild;
    const fixed = hang.writeCallbackAgainstDyingChild;
    const slow = hang.writeCallbackAgainstSlowChild;
    return {
        platform: threshold.platform,
        node: threshold.node,
        highWaterMark: threshold.highWaterMark,
        firstBackpressureKB: threshold.firstBackpressureKB,
        drainOnly: `${hung.outcome}, ${hung.leakedDrainListeners} leaked`,
        writeCallback: `${fixed.outcome}${fixed.reason ? ` (${fixed.reason})` : ''}`,
        slowPeer: slow.outcome
    };
}

export const HEADER = [
    '| platform | node | highWaterMark | first backpressure | drain-only send | write-callback send | slow peer |',
    '| --- | --- | --- | --- | --- | --- | --- |'
];

export const toMarkdown = r =>
    `| ${r.platform} | ${r.node} | ${r.highWaterMark} | ${r.firstBackpressureKB ?? 'n/a'} KB | ` +
    `${r.drainOnly} | ${r.writeCallback} | ${r.slowPeer} |`;

const threshold = await measureThreshold();
const hang = await measureHang();
const measured = row({ threshold, hang });

console.log(HEADER.join('\n'));
console.log(toMarkdown(measured));

if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [...HEADER, toMarkdown(measured), ''].join('\n'));
}

if (process.env.GITHUB_ACTIONS) {
    mkdirSync('results', { recursive: true });
    const name = `${threshold.platform}-${threshold.node}`.replace(/[^a-z0-9.-]/gi, '_');
    writeFileSync(`results/${name}.json`, JSON.stringify({ threshold, hang, row: measured }, null, 2));
}

process.exit(0);
