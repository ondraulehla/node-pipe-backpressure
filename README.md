# node-pipe-backpressure

What happens to an awaited write to a child process's stdin when the child dies before the write is flushed? I needed the answer to argue for a fix in the MCP TypeScript SDK, could not find it written down anywhere, so I measured it on every platform and Node version that mattered.

Everything here is a few dozen lines of plain Node with no dependencies, so you can check any claim on your own machine in about a minute.

## The short version

Two things caught me out.

**A promise that only waits for `'drain'` is never settled when the child exits.** The exit destroys the pipe, and a destroyed stream does not emit `'drain'`, so the await sits there for the lifetime of the process. No error, no timeout, and the listener stays attached to a stream that can never fire again. I let it run for 15 seconds with `destroyed === true` before accepting that "slow" was the wrong word for it.

**The size at which a write starts being buffered is not a constant.** It ranges from 16 KB to 224 KB across the nine platform and version combinations below, a factor of fourteen. Code that never reaches the buffered path on one platform hits it routinely on another, which is a nasty way for a bug to hide.

| platform | node | writableHighWaterMark | first size that backpressures |
| --- | --- | --- | --- |
| linux | 20.20.2 | 16384 | 224 KB |
| linux | 22.23.1 | 65536 | 160 KB |
| linux | 24.18.0 | 65536 | 160 KB |
| darwin | 20.20.2 | 16384 | 16 KB |
| darwin | 22.23.1 | 65536 | 64 KB |
| darwin | 24.18.0 | 65536 | 64 KB |
| win32 | 20.20.2 | 16384 | 16 KB |
| win32 | 22.23.1 | 16384 | 16 KB |
| win32 | 24.18.0 | 16384 | 16 KB |

Two things stand out. The high water mark grew from 16 KB to 64 KB between Node 20 and 22 on Linux and macOS, but not on Windows, so a payload size that is safely unbuffered on one runtime is buffered on the next. And the mark only predicts the threshold on two of the three platforms: on Windows and macOS the first size that backpressures is exactly the mark, while on Linux it is 2.5 times the mark on Node 22 and 24 and fourteen times it on Node 20, because the Linux pipe absorbs a large part of the chunk synchronously before Node has to queue anything. Reading `writableHighWaterMark` therefore tells you less than you would hope.

Every number here comes from the workflow in this repo, which runs the same two scripts on ubuntu, macOS and Windows for Node 20, 22 and 24. The sizes are the first entry in a coarse ladder (4, 8, 16, 32, 48, 64, 96, 128, 160, 192, 224, 256 and 512 KB), so the true boundary sits between the listed size and the one before it.

## Why I was looking

`StdioClientTransport.send()` in the MCP TypeScript SDK had exactly the first shape. Its promise executor took only `resolve`, so there was no failure path at all:

```js
return new Promise(resolve => {
    if (this._process.stdin.write(json)) {
        resolve();
    } else {
        this._process.stdin.once('drain', resolve); // never fires if the child exits
    }
});
```

The visible symptom was that `await client.notification(...)` never came back when a server died with a large message in flight. The notification path awaits the transport send with no timeout, and the SDK's connection-closed teardown settles pending responses but not pending sends, so nothing rescued it. Requests were luckier: they were already settled by that teardown, they just reported a generic connection-closed error instead of the real `EPIPE`.

The fix is to settle from the write callback, which Node invokes on flush or on failure, so a dead pipe produces a rejection instead of silence:

```js
return new Promise((resolve, reject) => {
    if (this._process.stdin.write(json, error => (error ? reject(error) : resolve()))) {
        resolve(); // fast path unchanged
    }
});
```

That went upstream as [modelcontextprotocol/typescript-sdk#2552](https://github.com/modelcontextprotocol/typescript-sdk/pull/2552). The same shape had already been fixed on the server transport in [#1568](https://github.com/modelcontextprotocol/typescript-sdk/pull/1568), the client side had just never been brought in line.

## What the measurements show

`src/hang.mjs` runs four scenarios against a real child process with 8 MB in flight, which is past every threshold above. The result is identical on all nine platform and version combinations:

| scenario | drain-only send | write-callback send |
| --- | --- | --- |
| child exits mid write | pending forever, 1 leaked `'drain'` listener | rejects, `EPIPE` on Linux and macOS, `EOF` on Windows, no leak |
| child is slow, then starts reading | resolves | resolves |

The second row is the one that keeps the fix honest. A peer that is merely slow must still resolve, otherwise the cure is worse than the disease, and both shapes have to agree on that.

## Run it yourself

```bash
node src/threshold.mjs   # high water mark and the first size that backpressures
node src/hang.mjs        # the three scenarios above, with the leaked listener count
node src/report.mjs      # one markdown row for this platform and Node version
```

## What I got wrong on the way

I originally wrote three claims into the upstream pull request from reading the code, and had to drop all three after driving the real public API instead:

1. "The request path reports a misleading timeout a minute later." It does not. `callTool()` rejects in 0.4 seconds with a connection-closed error, because the transport teardown settles pending response handlers.
2. "The abort controller entry leaks for the lifetime of the process." It does not. The teardown swaps that map and aborts everything in it.
3. "16 KB is enough to trigger this." Only on Windows, as the table above shows.

I keep this section because it is the part that changed how I work. Follow the value into the callee, then drive the documented entry point rather than the unit, then measure on the platform CI actually runs on. Everything in this repo is written so that someone else can do the same to me.

## License

MIT.
