// Reading claude's prompt history without walking the whole file every time.
//
// The file is one per USER (not per session), so the pane cannot tail-read it — a session whose
// activity is a few days old falls outside any window and reads as empty (#1749, measured: 254
// sessions showed 0). It therefore scans the whole thing, which on this machine is 7.8 MB and 46 ms
// of blocked event loop, on every refresh of an open pane.
//
// It is also APPEND-ONLY, which is the way out: what a second read has to look at is the bytes
// written since the first one. That is the same trick transcript-fold.ts plays on a transcript, and
// it uses the same reader — `forEachJsonlRecordIn`, which takes a byte range and answers where it
// stopped.
//
// Deliberately NOT the reverse scan #1750 proposed: measured over the 14 sessions open at the time,
// five could collect their newest 101 prompts from the last 122–798 KB, and **nine could not be
// satisfied without reading to the start of the file** — they simply have fewer than 101 prompts,
// and "there are no more" is only knowable by reaching the beginning. A resume helps every session;
// a reverse scan helps the busy ones once each.
//
// Pure: the file reading and the map live in session-reads.ts. What is here is when a memo may be
// believed, which is the part that goes wrong silently.
import { createHash } from "node:crypto";
import type { ClaudePromptScan } from "./prompt-history.js";

export interface HistoryMemo {
  /** What question this memo answers — see memoKeyFor. */
  key: string;
  /** The line-aligned byte offset the scan stopped at. */
  offset: number;
  /** Proof that the file still holds what the last scan read up to `offset` — see anchorOf. */
  anchor: string;
  /** The sliding window as it stood there. */
  scan: ClaudePromptScan;
  /** When the FULL scan this window ultimately rests on was taken — carried across every resume,
   *  not restamped by them. See MEMO_MAX_AGE_MS. */
  fullScanAt: number;
}

/** Which question a memo answers: the ids being read under, and the `/clear` floor.
 *
 *  Both can change for one session while the server runs — a hook teaches us claude's re-minted id,
 *  or a `/clear` puts a floor under the list — and either changes what the window should contain.
 *  A memo that survived such a change would answer the old question with the old rows, which is
 *  exactly the failure a cache is expected to have and the one nobody notices. */
export const memoKeyFor = (ids: readonly string[], since: number | undefined): string => `${ids.join(",")}|${since ?? ""}`;

/** How many bytes are fingerprinted at each end. Small enough that reading them is free, wide
 *  enough to reach the part of a line that actually varies (see below). */
export const ANCHOR_BYTES = 256;

/** A fingerprint of the file at the resume point: its HEAD, and the bytes ending at the offset.
 *
 *  This replaced a stamp made from `stat`'s inode and birth time, which was wrong three times and
 *  each time in a way that looked right. Metadata says which file this IS; what a resume needs to
 *  know is what the file CONTAINS, and the gap between those two shows up as (#1750):
 *
 *  - inode numbers are RECYCLED. On an ubuntu runner, 200 rounds of write/remove/write handed back
 *    the same inode 200/200 times, so the inode alone separates nothing.
 *  - the birth time separates them only at FULL precision. Rounded to the millisecond it collided
 *    173/200 in that same run — a delete-and-recreate inside one millisecond is the common case.
 *    macOS mints a fresh inode every time and so never reaches this, which is why it only ever
 *    failed in CI.
 *  - and neither survives the case that retired the approach: a file TRUNCATED AND REWRITTEN IN
 *    PLACE keeps its inode AND its birth time. If the rewrite regrows past the resume point, no
 *    stamp made from `stat` can tell it from an append.
 *
 *  BOTH ends, because the tail alone is not distinctive in THIS file: every line ends
 *  `…"project":"<dir>","sessionId":"<uuid>"}`, which for one session is byte-for-byte identical
 *  across lines. A window that lands inside that suffix fingerprints the format rather than the
 *  content, and matches a completely different file — which is exactly what the replacement test
 *  caught before this was widened. What varies is `display`, at the START of a line; the head of the
 *  file is likewise the first thing a replacement changes.
 *
 *  It is evidence, not proof: proving the first `offset` bytes are unchanged means reading them,
 *  which is the cost the resume exists to avoid. What it rules out is every replacement that differs
 *  at either end — and a file that matches at both ends yet differs in the middle is not something
 *  an append-only log does to itself. Hashed rather than kept, because these bytes are the user's own
 *  prompt text and a memo has no business holding more of it than the window it serves. */
export const anchorOf = (head: Buffer, tail: Buffer): string =>
  `${createHash("sha256").update(head).digest("hex").slice(0, 16)}:${createHash("sha256").update(tail).digest("hex").slice(0, 16)}`;

/** The anchor of a resume point that has no bytes before it — a scan starting from zero. */
export const EMPTY_ANCHOR = "";

/** Where the next scan should start, and whether it may keep what the last one found.
 *
 *  `reuse: null` means start over from byte 0 with a fresh window. `from === size` is not special —
 *  the caller reads an empty range, folds nothing, and answers from the window it kept. */
export interface ResumePlan {
  from: number;
  reuse: ClaudePromptScan | null;
}

const RESTART: ResumePlan = { from: 0, reuse: null };

/** How long a chain of resumes may stand on one full scan before the next read pays for a fresh one.
 *
 *  The anchor is evidence, not proof (see anchorOf), so there is a shape of rewrite it cannot see —
 *  one that leaves both fingerprinted windows byte-identical and changes what is between them. That
 *  is not a state an append-only log reaches on its own, but "cannot see it" and "carries it forever"
 *  are different sizes of wrong, and only the second one is unbounded (Codex, #1750). A ceiling on
 *  the chain's age turns it into the first: at worst the pane is stale for this long, then a full
 *  scan re-derives the window from the file.
 *
 *  Cheap because it bounds the CHAIN rather than the memo: `fullScanAt` is carried across resumes
 *  instead of being restamped by them, so a continuously-read pane still pays one 50 ms scan per
 *  interval — amortised over refreshes that arrive every 400 ms, well under a hundredth of a ms. */
export const MEMO_MAX_AGE_MS = 10 * 60 * 1000;

/** A memo may be resumed only when it answers THIS question, the file still carries at the byte it
 *  stopped on exactly what it read there, and the full scan underneath it is not too old.
 *
 *  `anchorNow` is what the caller found at `memo.offset` in the file as it is now, or null where it
 *  could not read that far — a file shorter than the offset was truncated or replaced, and either
 *  way the offset points somewhere it never did. */
export function resumePlan(memo: HistoryMemo | undefined, key: string, anchorNow: string | null, now: number): ResumePlan {
  if (!memo || memo.key !== key) return RESTART;
  if (anchorNow === null || anchorNow !== memo.anchor) return RESTART;
  if (now - memo.fullScanAt >= MEMO_MAX_AGE_MS) return RESTART;
  return { from: memo.offset, reuse: memo.scan };
}
