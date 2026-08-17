// @vitest-environment node
//
// The resumed read must answer exactly what a full scan would (#1750).
//
// This is a behaviour-preservation claim, so it is proved by running both over generated inputs and
// comparing whole results, not by reading the resume logic — the repo's rule for any change that
// says "same output". The old reader (a full `forEachJsonlRecord` fold) is reproduced here rather
// than imported, because the point is to compare against what the code USED to do.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { forgetHistoryMemo, sessionPrompts } from "../../../server/session/session-reads.js";
import { claudePromptScan, foldClaudePrompt, promptWindow, PROMPT_SCAN_LIMIT } from "../../../server/session/prompt-history.js";
import { forEachJsonlRecord } from "../../../server/infra/jsonl-file.js";
import type { PromptEntry } from "../../../common/promptHistory.js";

const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";

let home = "";
let realHome: string | undefined;
const historyFile = () => path.join(home, ".claude", "history.jsonl");

const line = (sessionId: string, display: string, timestamp = 1_700_000_000_000) =>
  `${JSON.stringify({ display, pastedContents: {}, timestamp, project: "/ws", sessionId })}\n`;

/** What the reader did before the memo: one fold over the whole file, every time.
 *
 *  Served through `promptWindow`, as the route does — the raw scan holds PROMPT_SCAN_LIMIT (one
 *  over, so overflow is a fact rather than an inference) while what reaches the pane is
 *  PROMPT_HISTORY_MAX. Comparing the raw window against the served one is the wrong comparison and
 *  differs by exactly one row, which looks like a resume bug. */
async function fullScan(sessionId: string): Promise<PromptEntry[]> {
  const scan = claudePromptScan([sessionId], PROMPT_SCAN_LIMIT, undefined);
  await forEachJsonlRecord(historyFile(), (record) => foldClaudePrompt(scan, record));
  return promptWindow(scan.found).prompts;
}

const resumedScan = async (sessionId: string): Promise<PromptEntry[]> => (await sessionPrompts("/ws", sessionId, "claude")).prompts;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mt-prompt-resume-"));
  realHome = process.env.HOME;
  process.env.HOME = home;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  // The memo map is module state that outlives one test. CI caught this the hard way: on Linux two
  // temp files created in succession got the SAME inode, so a memo from the previous case was
  // accepted for the next one's file. The production guard reads content rather than `stat` now, but
  // a test must not lean on that — it starts from no memo at all.
  [SESSION, OTHER].forEach(forgetHistoryMemo);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe("a resumed prompt-history read equals a full scan", () => {
  it("agrees after every append in a long interleaved run", async () => {
    await fs.writeFile(historyFile(), line(SESSION, "first"));
    expect(await resumedScan(SESSION)).toEqual(await fullScan(SESSION));

    // Interleave other sessions and ours, re-reading after each append: the memo is carried across
    // these calls, so a divergence shows up as soon as it exists rather than at the end.
    for (let i = 0; i < 40; i++) {
      await fs.appendFile(historyFile(), line(i % 3 === 0 ? SESSION : OTHER, `p${i}`, 1_700_000_000_000 + i));
      const [resumed, full] = [await resumedScan(SESSION), await fullScan(SESSION)];
      expect(resumed).toEqual(full);
    }
  });

  it("agrees once the window has overflowed, so the sliding window resumes correctly too", async () => {
    // More than PROMPT_SCAN_LIMIT, written in two halves with a read in between: the second read
    // must drop from the FRONT of a window it did not build.
    const half = Array.from({ length: 80 }, (_, i) => line(SESSION, `a${i}`, 1_700_000_000_000 + i)).join("");
    await fs.writeFile(historyFile(), half);
    await resumedScan(SESSION); // memo taken here, mid-window

    const rest = Array.from({ length: 80 }, (_, i) => line(SESSION, `b${i}`, 1_700_000_100_000 + i)).join("");
    await fs.appendFile(historyFile(), rest);

    const resumed = await resumedScan(SESSION);
    expect(resumed).toEqual(await fullScan(SESSION));
    expect(resumed.at(-1)?.text).toBe("b79");
    expect(resumed).toHaveLength(100); // PROMPT_HISTORY_MAX, the served window
  });

  // Truncated in place: same file, fewer bytes than the last scan consumed. The LENGTH guard.
  it("agrees when the file is truncated to something shorter", async () => {
    await fs.writeFile(historyFile(), Array.from({ length: 10 }, (_, i) => line(SESSION, `old${i}`)).join(""));
    await resumedScan(SESSION); // memo now points past the end of what replaces it

    await fs.writeFile(historyFile(), line(SESSION, "rotated"));
    const resumed = await resumedScan(SESSION);
    expect(resumed).toEqual(await fullScan(SESSION));
    expect(resumed.map((p) => p.text)).toEqual(["rotated"]);
  });

  // A genuinely NEW file, LARGER than the old offset (CodeRabbit): a replacement that grew past the
  // resume point is the one a length check cannot see. On Linux it is also handed the SAME inode,
  // which is how CI found the `stat`-based guard was too weak in the first place.
  it("agrees when the file is REPLACED by a larger one", async () => {
    await fs.writeFile(historyFile(), Array.from({ length: 5 }, (_, i) => line(SESSION, `old${i}`)).join(""));
    await resumedScan(SESSION);

    await fs.rm(historyFile());
    await fs.writeFile(historyFile(), Array.from({ length: 40 }, (_, i) => line(SESSION, `new${i}`)).join(""));

    const resumed = await resumedScan(SESSION);
    expect(resumed).toEqual(await fullScan(SESSION));
    expect(resumed.map((p) => p.text).every((t) => t.startsWith("new"))).toBe(true);
    expect(resumed).toHaveLength(40);
  });

  it("does not serve one session's memo to another", async () => {
    await fs.writeFile(historyFile(), line(SESSION, "ours") + line(OTHER, "theirs"));
    expect((await resumedScan(SESSION)).map((p) => p.text)).toEqual(["ours"]);
    expect((await resumedScan(OTHER)).map((p) => p.text)).toEqual(["theirs"]);

    await fs.appendFile(historyFile(), line(SESSION, "ours again"));
    expect((await resumedScan(OTHER)).map((p) => p.text)).toEqual(["theirs"]);
    expect((await resumedScan(SESSION)).map((p) => p.text)).toEqual(["ours", "ours again"]);
  });

  it("reads a file that appears only after the first look", async () => {
    // No history file at all: the reader falls back and must not memoise a failure.
    expect(await resumedScan(SESSION)).toEqual([]);
    await fs.writeFile(historyFile(), line(SESSION, "written later"));
    expect((await resumedScan(SESSION)).map((p) => p.text)).toEqual(["written later"]);
  });
});

// Codex, #1750: the memo is shared, so two overlapping reads used to fold into ONE array — every
// appended prompt counted twice and the sliding window evicted good rows. The reader copies the
// carried scan instead.
describe("overlapping reads of one session", () => {
  it("agree with a full scan, and with each other", async () => {
    await fs.writeFile(historyFile(), Array.from({ length: 5 }, (_, i) => line(SESSION, `p${i}`, 1_700_000_000_000 + i)).join(""));
    await resumedScan(SESSION); // take the memo

    await fs.appendFile(historyFile(), line(SESSION, "appended", 1_700_000_000_100));
    // Started together, so both resume from the same memo before either finishes.
    const [a, b] = await Promise.all([resumedScan(SESSION), resumedScan(SESSION)]);
    const full = await fullScan(SESSION);
    expect(a).toEqual(full);
    expect(b).toEqual(full);
    expect(a.filter((p) => p.text === "appended")).toHaveLength(1); // not folded twice
  });

  it("survives a burst of them without duplicating anything", async () => {
    await fs.writeFile(historyFile(), line(SESSION, "base"));
    await resumedScan(SESSION);
    await fs.appendFile(historyFile(), line(SESSION, "more"));

    const results = await Promise.all(Array.from({ length: 8 }, () => resumedScan(SESSION)));
    const full = await fullScan(SESSION);
    results.forEach((r) => expect(r).toEqual(full));
    expect(full.map((p) => p.text)).toEqual(["base", "more"]);
  });
});

// Codex, #1750: the memo used to record the size stat'd BEFORE the scan. Claude can append while a
// scan runs, so the stream can pass that size; a truncation to a length between the two then looked
// like growth. The guard is the offset the scan actually reached.
describe("a file truncated in place after growing mid-scan", () => {
  it("starts over rather than resuming past the end", async () => {
    await fs.writeFile(historyFile(), Array.from({ length: 20 }, (_, i) => line(SESSION, `long${i}`)).join(""));
    await resumedScan(SESSION);

    // Truncate to a prefix: shorter than where the scan stopped, longer than nothing.
    const kept = Array.from({ length: 3 }, (_, i) => line(SESSION, `long${i}`)).join("");
    await fs.writeFile(historyFile(), kept);

    const resumed = await resumedScan(SESSION);
    expect(resumed).toEqual(await fullScan(SESSION));
    expect(resumed.map((p) => p.text)).toEqual(["long0", "long1", "long2"]);
  });
});

// The file moving under a read in progress (#1750). It went wrong three ways before the reader held
// the file open across the whole scan: `stat` inspected a PATH and the stream opened that path after
// it; then the anchor was read from the path after the fold; then the head was re-read from the path
// at the end. Each of those pairs could see two different files, and the memo they built out of the
// pair — one file's window beside another file's anchor — passed its own check on every later read.
//
// Now one `open` covers the plan, the fold and the stored anchor, so there is no gap to place a swap
// INSIDE. What is left are the two orderings around that open, and the tests below take both:
// `{ before: true }` swaps first, so the scan opens the replacement; the default swaps immediately
// after, so the scan reads the file it opened while the PATH already points elsewhere.
const raceOn = (swap: () => Promise<void>, opts: { before?: boolean } = {}) => {
  const realOpen = fs.open.bind(fs);
  let swapped = false;
  return vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (!swapped && opts.before) {
      swapped = true;
      await swap();
      return realOpen(...args);
    }
    const handle = await realOpen(...args);
    if (!swapped) {
      swapped = true;
      await swap();
    }
    return handle;
  });
};

// Holding the file open answers a replaced PATH and nothing else: the bytes of the file itself can
// still be rewritten UNDER the handle, and then the fold and the anchor stored beside it are reading
// one inode at two different moments (CodeRabbit, #1750).
//
// Hooked on the fold's last read rather than on `open`, because that is the moment: the fold reaches
// EOF exactly once — the only read that comes back empty — and everything after it is the checking.
// `afterReads` walks the swap through the checks that follow the fold, each of which is a positional
// read of its own: 0 is the moment the fold ends, and 2 is once the anchor destined for the memo has
// been read but before the checkpoint is confirmed — the gap a validation placed too early leaves
// open.
const raceAtEndOfFold = (swap: () => Promise<void>, opts: { afterReads?: number } = {}) => {
  const realOpen = fs.open.bind(fs);
  const due = opts.afterReads ?? 0;
  let swapped = false;
  return vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    const read = handle.read.bind(handle);
    let sinceEof = -1;
    // Defined rather than assigned: `read` is overloaded, and defineProperty takes the one shape
    // this file actually calls without weakening the handle's type to do it.
    const counted = async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, length, position);
      if (sinceEof < 0 && result.bytesRead === 0)
        sinceEof = 0; // the fold reached EOF
      else if (sinceEof >= 0) sinceEof += 1;
      if (!swapped && sinceEof === due) {
        swapped = true;
        await swap();
      }
      return result;
    };
    Object.defineProperty(handle, "read", { value: counted, configurable: true });
    return handle;
  });
};

describe("the file changed under a scan in progress", () => {
  const OLD = Array.from({ length: 5 }, (_, i) => line(SESSION, `old${i}`)).join("");
  // Bigger than the memo's offset, so a length check cannot be what saves either case.
  const NEW = Array.from({ length: 40 }, (_, i) => line(SESSION, `new${i}`)).join("");
  // A replacement that KEEPS the file's opening bytes and changes what follows. A fingerprint of the
  // head cannot see this one, so it is what says whether the reader compares against the same file
  // it folded rather than merely a file that starts the same way (CodeRabbit, #1750).
  const KEEPS_HEAD = OLD.split("\n").slice(0, 3).join("\n") + "\n" + Array.from({ length: 40 }, (_, i) => line(SESSION, `new${i}`)).join("");

  it("does not splice the old window onto the new file", async () => {
    await fs.writeFile(historyFile(), OLD);
    await resumedScan(SESSION); // memo taken against the original file

    const spy = raceOn(async () => {
      await fs.rm(historyFile());
      await fs.writeFile(historyFile(), NEW);
    });
    const resumed = await resumedScan(SESSION);
    spy.mockRestore();

    // Answering from the file it opened is legitimate — the handle IS that file. What it must never
    // do is MIX the two, and it must not leave a memo that makes the next read mix them either.
    const texts = resumed.map((p) => p.text);
    const oneFile = texts.every((t) => t.startsWith("old")) || texts.every((t) => t.startsWith("new"));
    expect(oneFile).toBe(true);
    expect(await resumedScan(SESSION)).toEqual(await fullScan(SESSION));
  });

  // The same race WITHOUT unlinking: `writeFile` over an existing path truncates in place, so the
  // inode and the birth time both survive it and no stamp made from them can tell the two contents
  // apart. If the rewrite regrows past the memo's offset a length check passes too — and the memo
  // that gets stored then carries the OLD window plus the new file's suffix, which every later read
  // resumes from. This is the case that retired the `stat`-based identity (Codex, #1750).
  it("does not splice the old window onto a file rewritten in place", async () => {
    await fs.writeFile(historyFile(), OLD);
    await resumedScan(SESSION);

    const spy = raceOn(() => fs.writeFile(historyFile(), NEW)); // same inode, same birth time
    const resumed = await resumedScan(SESSION);
    spy.mockRestore();

    expect(resumed.map((p) => p.text).every((t) => t.startsWith("new"))).toBe(true);
    // And the corruption must not outlive the raced call: the NEXT read has to agree too.
    expect(await resumedScan(SESSION)).toEqual(await fullScan(SESSION));
  });

  // A scan that starts from ZERO carries no memo, so there is nothing it was planned against to
  // re-check afterwards. Both orderings of the swap around its single open have to leave the reader
  // either right or empty-handed — never with a memo that pairs one file's window with another's
  // anchor, which is a poisoned cache rather than one wrong response (Codex, #1750).
  [true, false].forEach((before) => {
    it(`does not memoise a fresh scan raced by a replacement ${before ? "before" : "after"} it opens the file`, async () => {
      await fs.writeFile(historyFile(), Array.from({ length: 5 }, (_, i) => line(SESSION, `first${i}`)).join(""));

      const spy = raceOn(
        async () => {
          await fs.rm(historyFile());
          await fs.writeFile(historyFile(), NEW);
        },
        { before },
      );
      await resumedScan(SESSION); // no memo yet, so this one scans from zero
      spy.mockRestore();

      // Whatever that raced call answered, what must not survive is a memo built from the first
      // file. These reads are unraced, so they can only disagree with a full scan if one was stored.
      expect(await resumedScan(SESSION)).toEqual(await fullScan(SESSION));
      expect((await resumedScan(SESSION)).map((p) => p.text).every((t) => t.startsWith("new"))).toBe(true);
    });
  });

  // The same race, with the replacement built to defeat a fingerprint of the HEAD: its first lines
  // are the old file's, byte for byte, and only what follows differs. A check that re-reads the path
  // cannot tell it from the file the fold actually consumed — only reading BOTH through one handle
  // can, which is why the scan holds the file open across all of it (CodeRabbit, #1750).
  it("does not memoise a fresh scan against a replacement that keeps the opening bytes", async () => {
    await fs.writeFile(historyFile(), OLD);

    // Immediately after the open, which is where a re-read of the path would have picked up the
    // replacement while the fold kept consuming the original.
    const spy = raceOn(async () => {
      await fs.rm(historyFile());
      await fs.writeFile(historyFile(), KEEPS_HEAD);
    });
    await resumedScan(SESSION);
    spy.mockRestore();

    // `old0`–`old2` are still there legitimately — the replacement kept them, which is the whole
    // point of it. What only the OLD file had is `old3` and `old4`, so those are the poisoning
    // signal: they can only appear from a window built before the swap.
    const after = (await resumedScan(SESSION)).map((p) => p.text);
    expect(after).toEqual((await fullScan(SESSION)).map((p) => p.text));
    expect(after).not.toContain("old3");
    expect(after).not.toContain("old4");
  });

  // The case the handle cannot answer on its own: the same inode, rewritten in place, in the gap
  // between the fold reaching EOF and the anchor being read for the memo. A FRESH scan is where it
  // bites, because it carries no memo whose anchor could be re-checked — so the scan has to take its
  // own before-and-after reading of the boundary it folded up to (CodeRabbit, #1750).
  // Each number is a moment among the reads that follow the fold, and the memo must survive none of
  // them carrying two different states of the file: 0 ends the fold, 2 is after the anchor that will
  // be stored has been read. The second is what says the checkpoint is confirmed AFTER everything the
  // memo holds rather than before it (CodeRabbit, #1750).
  [0, 1, 2, 3].forEach((afterReads) => {
    it(`does not memoise a fresh scan rewritten in place ${afterReads} reads after the fold`, async () => {
      await fs.writeFile(historyFile(), OLD);

      const spy = raceAtEndOfFold(() => fs.writeFile(historyFile(), NEW), { afterReads }); // same inode
      await resumedScan(SESSION); // no memo yet, so this one scans from zero
      spy.mockRestore();

      const after = (await resumedScan(SESSION)).map((p) => p.text);
      expect(after).toEqual((await fullScan(SESSION)).map((p) => p.text));
      expect(after.some((t) => t.startsWith("old"))).toBe(false);
    });
  });
});
