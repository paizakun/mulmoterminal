// @vitest-environment node
//
// When a resumed prompt-history scan may be believed (#1750).
//
// The read is a cache now, so its failure mode is the one caches have: answering the new question
// with the old rows, silently and plausibly. Two things invalidate a memo, and they are different
// kinds of stale — the QUESTION changed (the ids being read, the `/clear` floor), or the FILE no
// longer carries what the last scan read.
//
// The second used to be judged from `stat` — inode and birth time — and that was wrong three times,
// each time in a way that looked right. Measured on an ubuntu runner over 200 rounds of
// write/remove/write: the inode came back identical 200/200, and the birth time rounded to the
// millisecond collided 173/200. What retired the approach is the case no precision helps with — a
// file truncated and REWRITTEN IN PLACE keeps both fields. The guard is the CONTENT at the resume
// point now, which no filesystem bookkeeping can fake.
import { describe, it, expect } from "vitest";
import { anchorOf, memoKeyFor, resumePlan, ANCHOR_BYTES, EMPTY_ANCHOR, MEMO_MAX_AGE_MS, type HistoryMemo } from "../../../server/session/prompt-history-memo";
import { claudePromptScan } from "../../../server/session/prompt-history";

const scan = () => claudePromptScan(["s1"], 100, undefined);
const ANCHOR = anchorOf(Buffer.from('{"display":"the first prompt"…'), Buffer.from("…the last line of the previous scan\n"));
const NOW = 1_800_000_000_000;
const memo = (over: Partial<HistoryMemo> = {}): HistoryMemo => ({ key: "s1|", offset: 1000, anchor: ANCHOR, scan: scan(), fullScanAt: NOW, ...over });

describe("memoKeyFor", () => {
  it("separates a different set of ids", () => {
    expect(memoKeyFor(["s1"], undefined)).not.toBe(memoKeyFor(["s1", "s2"], undefined));
  });

  it("separates a floor from no floor, and two different floors", () => {
    expect(memoKeyFor(["s1"], undefined)).not.toBe(memoKeyFor(["s1"], 5));
    expect(memoKeyFor(["s1"], 5)).not.toBe(memoKeyFor(["s1"], 6));
  });

  it("is stable for the same question", () => {
    expect(memoKeyFor(["s1", "s2"], 7)).toBe(memoKeyFor(["s1", "s2"], 7));
  });
});

describe("anchorOf", () => {
  const head = Buffer.from("head\n");
  const tail = Buffer.from("tail\n");

  it("separates content that differs by a single byte, at either end", () => {
    expect(anchorOf(head, tail)).not.toBe(anchorOf(Buffer.from("heaD\n"), tail));
    expect(anchorOf(head, tail)).not.toBe(anchorOf(head, Buffer.from("taiL\n")));
  });

  it("is stable for the same bytes", () => {
    expect(anchorOf(head, tail)).toBe(anchorOf(Buffer.from("head\n"), Buffer.from("tail\n")));
  });

  // THE reason both ends are fingerprinted: every line of this file ends with the same
  // `"project":…,"sessionId":…}` for one session, so a tail-only window fingerprints the FORMAT and
  // matches a different file outright. The replacement test caught exactly this.
  it("separates two files whose lines share the identical trailing format", () => {
    const suffix = Buffer.from('","project":"/ws","sessionId":"11111111-2222-4333-8444-555555555555"}\n');
    expect(anchorOf(Buffer.from('{"display":"old0'), suffix)).not.toBe(anchorOf(Buffer.from('{"display":"new0'), suffix));
  });

  // It is the user's own prompt text: a memo has no business holding more of it than the window it
  // already serves.
  it("does not carry the content it fingerprints", () => {
    expect(anchorOf(Buffer.from("a secret the user typed\n"), tail)).not.toContain("secret");
  });

  it("reads a window wide enough to reach the part of a line that varies", () => {
    expect(ANCHOR_BYTES).toBeGreaterThanOrEqual(128);
  });
});

describe("resumePlan", () => {
  it("starts from the beginning when there is no memo", () => {
    expect(resumePlan(undefined, "s1|", ANCHOR, NOW)).toEqual({ from: 0, reuse: null });
  });

  it("resumes when the file still carries what the last scan read", () => {
    const m = memo();
    expect(resumePlan(m, "s1|", ANCHOR, NOW)).toEqual({ from: 1000, reuse: m.scan });
  });

  // The cache failure that matters most: the question changed while the file did not.
  it("starts over when the ids or the floor changed", () => {
    expect(resumePlan(memo(), "s1,s2|", ANCHOR, NOW)).toEqual({ from: 0, reuse: null });
    expect(resumePlan(memo(), "s1|1234", ANCHOR, NOW)).toEqual({ from: 0, reuse: null });
  });

  // What the inode check could not do: a REPLACEMENT that is bigger than the old offset carries
  // different bytes there, whatever the filesystem says about the file's identity.
  it("starts over when the bytes at the resume point are not the ones it read", () => {
    expect(resumePlan(memo(), "s1|", anchorOf(Buffer.from("a different file"), Buffer.from("entirely\n")), NOW)).toEqual({ from: 0, reuse: null });
  });

  // Null is "the file cannot supply those bytes at all" — shorter than the offset, or unreadable.
  it("starts over when the file cannot reach the resume point", () => {
    expect(resumePlan(memo(), "s1|", null, NOW)).toEqual({ from: 0, reuse: null });
  });

  it("resumes a memo taken at byte zero, which has nothing before it to prove", () => {
    const m = memo({ offset: 0, anchor: EMPTY_ANCHOR });
    expect(resumePlan(m, "s1|", EMPTY_ANCHOR, NOW)).toEqual({ from: 0, reuse: m.scan });
  });

  // The anchor cannot see a rewrite that leaves both fingerprinted windows alone, so the chain it
  // stands on is aged out instead: wrong for at most this long rather than wrong forever (Codex).
  describe("the age of the full scan underneath", () => {
    it("resumes while the chain is younger than the ceiling", () => {
      const m = memo({ fullScanAt: NOW - MEMO_MAX_AGE_MS + 1 });
      expect(resumePlan(m, "s1|", ANCHOR, NOW)).toEqual({ from: 1000, reuse: m.scan });
    });

    it("starts over once it is older, even though the file itself checks out", () => {
      expect(resumePlan(memo({ fullScanAt: NOW - MEMO_MAX_AGE_MS }), "s1|", ANCHOR, NOW)).toEqual({ from: 0, reuse: null });
    });

    // It is the CHAIN that ages, not the memo: a resume carries `fullScanAt` forward rather than
    // restamping it, or a pane read every 400ms would never re-derive anything.
    it("is measured from the full scan, not from the last resume", () => {
      const old = memo({ fullScanAt: NOW - MEMO_MAX_AGE_MS - 60_000 });
      expect(resumePlan(old, "s1|", ANCHOR, NOW)).toEqual({ from: 0, reuse: null });
    });
  });
});
