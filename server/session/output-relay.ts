// Every buffered pty's output path: keep the replay tail, and hand the browser batches
// rather than one frame per read.
//
// The batching exists because of the tail fix, not beside it. Draining a flooding pty at full
// speed makes each read SMALLER, so the same output arrives as far more chunks — six cells went
// from 118k to 655k in one measurement (#1506). One frame each would move the cost we just
// removed from appendBoundedOutput onto JSON.stringify and the socket.
import { growOutputTail, trackTerminalModes } from "./terminal-replay.js";
import { sendFrame } from "./ws-frames.js";
import type { PtyEntry } from "./types.js";

// Below one 60fps frame, so a batch can never be seen as lag; large enough that a flood
// collapses into a handful of frames a second instead of thousands.
const FLUSH_INTERVAL_MS = 8;

// A batch this big has already amortised the per-frame cost, and the queue only grows while the
// loop is busy enough that the timer cannot fire — so without a ceiling one burst decides how long
// a single stringify-and-send blocks. Measured batches run ~30 KB; this is the pathological case.
const MAX_BATCH_CHARS = 256 * 1024;

export interface OutputRelay {
  /** Keep a chunk for replay, and queue it for the browser. */
  push(data: string): void;
  /** Send what is queued. Call before an exit frame, or the last output lands after it. */
  flush(): void;
  /** Forget what is queued, for a caller that has already sent it another way. */
  discard(): void;
}

export function createOutputRelay(entry: PtyEntry, limit: number): OutputRelay {
  const pending: string[] = [];
  let pendingChars = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSentMs = 0;

  const discard = () => {
    pending.length = 0;
    pendingChars = 0;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    if (pending.length === 0) return discard();
    const data = pending.join("");
    discard();
    lastSentMs = Date.now();
    // Read the socket now, not at push time: a reattach swaps it while a batch is queued.
    sendFrame(entry.ws, { type: "output", data });
  };

  const push = (data: string) => {
    // Only a tmux-less entry needs this — tmuxTerminalModes reads the live state straight from
    // tmux, so tracking it here too would be a second, redundant source of truth for the entries
    // that already have the authoritative one.
    if (!entry.tmux) trackTerminalModes(entry, data);
    entry.buffer = growOutputTail(entry.buffer, data, limit);
    // Nobody to send to — a session whose browser has closed, still working in the background.
    // Queueing would only build batches to throw away, and the buffer above is already the
    // record: a reattach replays it (and discards the queue for exactly that reason).
    if (!entry.ws) return;
    pending.push(data);
    pendingChars += data.length;
    if (pendingChars >= MAX_BATCH_CHARS) return flush();
    if (timer) return;
    // Nothing went out recently, so this is a keystroke echo or a fresh prompt rather than a
    // flood — send it at once. Batching only starts once output is arriving faster than a frame.
    const sinceLastMs = Date.now() - lastSentMs;
    if (sinceLastMs >= FLUSH_INTERVAL_MS) return flush();
    timer = setTimeout(flush, FLUSH_INTERVAL_MS - sinceLastMs);
  };

  return { push, flush, discard };
}

/** Point a buffered pty's onData at a relay kept on the entry (where a reattach can reach it), and
 *  hand the relay back so the exit path can flush what is still queued.
 *
 *  `tap` is the spawner's own view of the stream — claude's draft-ready scanner, codex's
 *  seed injector — fed here rather than through a second onData listener. */
export function wireBufferedOutput(entry: PtyEntry, limit: number, tap?: (data: string) => void): OutputRelay {
  const relay = createOutputRelay(entry, limit);
  entry.output = relay;
  entry.term.onData((data) => {
    relay.push(data);
    tap?.(data);
  });
  return relay;
}
