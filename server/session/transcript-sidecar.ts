// A value folded out of a transcript, kept beside it on disk.
//
// createAppendFileCache (file-cache.ts) already stops a fold from being repeated — but only within
// one process's memory. Two things still pay full price: a restart, and every OTHER mulmoterminal
// rooted at the same home (eight run on this machine, each warming its own copy). A sidecar is that
// same {value, offset} written to a small JSON file, so the next reader spends a few KB instead of
// a few hundred MB (#1386).
//
// Only worth it for a big transcript: the median here is 93 KB, which folds in under a millisecond,
// while files over 10 MB hold 82% of all transcript bytes.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { mulmoterminalHome } from "../infra/mulmoterminal-home.js";
import { isRecord } from "../../common/isRecord.js";
import { createKeySerializer } from "../infra/serialize-per-key.js";
import type { AppendScan, FileStamp } from "./file-cache.js";

const sidecarRoot = (): string => path.join(mulmoterminalHome(), "transcript-index");
// Under this, a fold costs single-digit milliseconds and the in-memory cache already covers it.
const DEFAULT_MIN_BYTES = 10 * 1024 * 1024;
// Enough to carry a transcript's first record, which names the session and when it started.
const HEAD_BYTES = 256;

export interface TranscriptSidecar<T> {
  /** What was folded and where to continue, or undefined when the file must be folded from
   *  scratch — including every reason to distrust what is on disk. */
  read(transcript: string, stamp: FileStamp): Promise<AppendScan<T> | undefined>;
  /** Best effort, and deliberately not awaited by the read path: the answer is already in hand. */
  write(transcript: string, stamp: FileStamp, from: number, value: T): void;
}

export interface SidecarOptions<T> {
  /** One directory per KIND of derived value (title fields, cost, timeline …). */
  kind: string;
  /** Bump when the fold's MEANING changes. A stale cache is a slow answer; a stale sidecar is a
   *  WRONG one that survives restarts, so this is checked before anything else. */
  version: number;
  /** A file on disk is untrusted input, whoever wrote it. */
  isValue: (value: unknown) => value is T;
  minBytes?: number;
}

// One write at a time per sidecar path: within a process, two folds of the same transcript would
// otherwise interleave their tmp+rename.
const serializeWrite = createKeySerializer();

export function createTranscriptSidecar<T>(options: SidecarOptions<T>): TranscriptSidecar<T> {
  const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
  return {
    async read(transcript, stamp) {
      if (stamp.size < minBytes) return undefined;
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(sidecarPath(options.kind, transcript), "utf8"));
        return (await usableScan(parsed, options, transcript, stamp)) ?? undefined;
      } catch {
        return undefined; // absent, unreadable, or not JSON — fold it again
      }
    },
    write(transcript, stamp, from, value) {
      if (stamp.size < minBytes) return;
      const file = sidecarPath(options.kind, transcript);
      // Per path, so this process cannot race itself. Other processes are handled by the rename:
      // the last writer wins and every version on disk is self-consistent.
      void serializeWrite(file, async () => {
        try {
          await writeAtomic(
            file,
            JSON.stringify({ v: options.version, size: stamp.size, mtimeMs: stamp.mtimeMs, head: await headHash(transcript), scannedTo: from, value }),
          );
        } catch {
          // Best effort: the value is already answered from memory, and a sidecar that cannot be
          // written just means the next process folds the file itself.
        }
      });
    },
  };
}

// Every reason to distrust the file, in one place. `null` rather than a throw: none of these is an
// error a caller can act on — they all mean "fold it yourself".
async function usableScan<T>(parsed: unknown, options: SidecarOptions<T>, transcript: string, stamp: FileStamp): Promise<AppendScan<T> | null> {
  if (!isRecord(parsed) || parsed.v !== options.version) return null;
  const { size, mtimeMs, scannedTo, head, value } = parsed;
  if (!isByteCount(size) || !isByteCount(scannedTo) || typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs) || typeof head !== "string") return null;
  if (!options.isValue(value)) return null;
  // The same freshness rule the in-memory cache states: a shorter file was rewritten, and a
  // same-size one whose mtime moved was rewritten in place.
  if (stamp.size < size || scannedTo > stamp.size) return null;
  if (stamp.size === size && stamp.mtimeMs !== mtimeMs) return null;
  // (mtime, size) cannot tell "appended to" from "replaced by something longer". In memory that gap
  // is a moment wide; here the record can be days old, so the first bytes are checked too.
  if ((await headHash(transcript)) !== head) return null;
  return { from: scannedTo, value };
}

// A position in a file, as read back off disk. "typeof number" is not enough: a negative or
// fractional one reaches createReadStream as `start`, which throws ERR_OUT_OF_RANGE — and the
// session list turns a throw into a row that silently vanishes, from a sidecar that keeps being
// read. A number that cannot be an offset means the record is corrupt, i.e. rebuild it
// (CodeRabbit on #1387).
const isByteCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Mirrors the transcript's own layout — <project dir>/<session>.jsonl — from BASENAMES only, so
// nothing a caller passes can walk out of the sidecar root.
function sidecarPath(kind: string, transcript: string): string {
  const project = path.basename(path.dirname(transcript));
  const session = path.basename(transcript, ".jsonl");
  return path.join(sidecarRoot(), kind, project, `${session}.json`);
}

// One read of the first bytes, not a stream: the window is a fixed 256 bytes, and a plain read
// keeps the buffer typed all the way into the hash.
async function headHash(transcript: string): Promise<string> {
  const handle = await fs.open(transcript, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
  } finally {
    await handle.close();
  }
}

// tmp + rename, so a reader never sees half a file — including the readers in other processes.
async function writeAtomic(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
