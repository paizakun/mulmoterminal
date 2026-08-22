// The GUI panel's two per-session stores: the tool RESULTS a plugin rendered, and the
// tool-CALL history every hook records. Both are disk-backed so the panel replays after a
// reboot. Extracted from index.ts (#548) with two things injected rather than imported:
//
// - `publish`, because pub/sub only exists once the HTTP server does. It arrives as a
//   closure, so it stays correct however late that happens.
// - `root`, so a test writes to a temp directory instead of the developer's own
//   ~/.mulmoterminal — the readers' equivalent of that binding is why registry.ts still
//   has no tests.
import { promises as fs } from "node:fs";
import path from "node:path";
import { SESSION_ID_RE } from "../config/env.js";
import { mulmoterminalHome } from "../infra/mulmoterminal-home.js";
import { messageOf } from "../errors.js";
import type { ToolCall, ToolResult } from "./types.js";
import { reconcileCollectionCard } from "../../common/collectionSeed.js";
import { isUnknownArray } from "../../common/isUnknownArray.js";
import { isRecord } from "../../common/isRecord.js";

export interface ToolStoreDeps {
  /** Fan a change out to the panel; a no-op before pub/sub exists. */
  publish: (channel: string, data: unknown) => void;
  /** Where the JSON files live. Defaults to ~/.mulmoterminal. */
  root?: string;
}

// How long a save waits for the next one before it writes. Long enough that a fast tool's
// PreToolUse and PostToolUse share a write; short enough that what a kill inside the window
// loses is one change to a display-only history.
const SAVE_COALESCE_MS = 50;

// Turn "write this session out" into "write it once for this burst, and never twice at once".
//
// Two writeFile calls truncating and refilling one path concurrently can leave a file that is
// neither version, so a write waits out whatever is already running for that session.
//
// One session therefore holds at most two writes: the one running, and the one waiting. Every save
// that arrives before the waiting one STARTS folds into it — including while the earlier write is
// still going, which is the case that matters on a slow disk. Chaining each save behind the last
// instead would queue a write per save, and since each writes the list as it stands when it runs,
// they would all put the same bytes on disk.
function createCoalescedWriter(write: (sessionId: string) => Promise<void>) {
  const waiting = new Map<string, Promise<void>>(); // not started — fold into it
  const running = new Map<string, Promise<void>>(); // started — it must finish alone

  const writeAlone = async (sessionId: string): Promise<void> => {
    await running.get(sessionId);
    waiting.delete(sessionId); // from here a save needs a write of its own; this one has its list
    const run = write(sessionId);
    running.set(sessionId, run);
    await run;
    if (running.get(sessionId) === run) running.delete(sessionId);
  };

  return (sessionId: string): Promise<void> => {
    const scheduled = waiting.get(sessionId);
    if (scheduled) return scheduled; // it has not started, so it will carry this change too
    const written = new Promise<void>((resolve) => {
      setTimeout(() => void writeAlone(sessionId).then(resolve), SAVE_COALESCE_MS);
    });
    waiting.set(sessionId, written);
    return written;
  };
}

// Write one session's list out, reporting rather than throwing — a save is best-effort.
//
// Serialising the WHOLE list is what makes this expensive: 3.8 ms of blocked event loop for a
// 3.4 MB list, before those megabytes reach the disk. That is why callers coalesce (#1507).
async function persistList(dirName: string, dir: string, file: string, sessionId: string, list: unknown): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(list));
  } catch (e) {
    console.error(`[${dirName}] failed to persist ${sessionId}: ${messageOf(e)}`);
  }
}

// The file's mtime, or 0 when there is no readable file.
async function fileMtimeMs(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

// A per-session list store mirrored to disk so it survives a server reboot — one
// JSON file per session under <workspace>/<dirName>/<sessionId>.json
// (<workspace> = CLAUDE_CWD). The in-memory Map is the working copy; the file is
// rewritten on each change and lazy-loaded on first access. Session ids are
// validated UUIDs (SESSION_ID_RE), so they're safe to use as filenames.
//
// The file is shared with any other server rooted at the same MULMOTERMINAL_HOME. Only the
// server that spawned a session ever WRITES its file (the hook/broker URLs bake in the owning
// server's port), but a NON-owning server can READ it (a phone/browser attached to it opens
// that session's tool history). This instance OWNS any session it has ever saved: that map is
// the source of truth and is never re-read (its writes are fire-and-forget, so re-reading could
// clobber an in-place mutation not yet flushed). A session this instance has only READ is
// re-read when the file's mtime is newer than the copy it cached, so the non-owner picks up the
// owner's appends instead of holding a stale copy until it restarts. `statMtimeMs` is a
// parameter so a test can drive the mtime deterministically. (#705)
// `isEntry` is required rather than optional: the file is JSON this process wrote, but it can be
// hand-edited, truncated by a crash, or left behind by an older version — and with no check the
// list is promoted to T[] on nothing but the type argument, so every read off an entry lies.
export function createSessionStore<T>(dirName: string, isEntry: (value: unknown) => value is T, root = mulmoterminalHome(), statMtimeMs = fileMtimeMs) {
  const dir = path.join(root, dirName);
  const fileFor = (id: string) => path.join(dir, `${id}.json`);
  const map = new Map<string, T[]>(); // id -> list (the working copy; mutate in place)
  const owned = new Set<string>(); // sessions this instance has written => authoritative, never re-read
  const loadedMtime = new Map<string, number>(); // id -> file mtime as of the last read (non-owned only)
  const loading = new Map<string, Promise<T[]>>(); // id -> Promise<list>, dedupes concurrent loads

  // Read a session's list off disk. Stat BEFORE reading so a write that races the read is
  // caught on the next get (a stale-newer mtime only costs one extra re-read; a stale-older one
  // could miss the update). Missing / corrupt / non-array file => empty.
  async function readFromDisk(sessionId: string): Promise<{ list: T[]; mtimeMs: number }> {
    if (!SESSION_ID_RE.test(sessionId)) return { list: [], mtimeMs: 0 };
    const file = fileFor(sessionId);
    const mtimeMs = await statMtimeMs(file);
    try {
      // A bad entry is dropped rather than failing the read: the list is a set, not positional.
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      return { list: isUnknownArray(parsed) ? parsed.filter(isEntry) : [], mtimeMs };
    } catch {
      return { list: [], mtimeMs: 0 };
    }
  }

  function firstLoad(sessionId: string): Promise<T[]> {
    const inflight = loading.get(sessionId);
    if (inflight) return inflight;
    const p = (async () => {
      const { list, mtimeMs } = await readFromDisk(sessionId);
      map.set(sessionId, list);
      loadedMtime.set(sessionId, mtimeMs);
      loading.delete(sessionId);
      return list;
    })();
    loading.set(sessionId, p);
    return p;
  }

  // Return the cached list, or re-read it if another instance wrote the file since we cached it.
  async function maybeReload(sessionId: string, cached: T[]): Promise<T[]> {
    if (!SESSION_ID_RE.test(sessionId)) return cached; // an invalid id never had a file
    if ((await statMtimeMs(fileFor(sessionId))) <= (loadedMtime.get(sessionId) ?? 0)) return cached;
    const { list, mtimeMs } = await readFromDisk(sessionId);
    map.set(sessionId, list);
    loadedMtime.set(sessionId, mtimeMs);
    return list;
  }

  // Lazily load a session's list from disk; on later calls keep the in-memory copy. A session
  // this instance owns (has written) is always its cached working array; one it has only read is
  // re-read when a second instance that owns it has since appended to the file.
  function get(sessionId: string): Promise<T[]> {
    const cached = map.get(sessionId);
    if (!cached) return firstLoad(sessionId);
    if (owned.has(sessionId)) return Promise.resolve(cached);
    return maybeReload(sessionId, cached);
  }

  const scheduleWrite = createCoalescedWriter((sessionId) => persistList(dirName, dir, fileFor(sessionId), sessionId, map.get(sessionId) || []));

  // Persist a session's list (best-effort; callers fire and forget). Writing marks the session
  // owned by this instance, so subsequent reads trust the in-memory working copy over the disk.
  //
  // Saves that land inside one window share a write. A tool call fires two — PreToolUse then
  // PostToolUse — and a tool that returns quickly puts both inside it, so the common case costs
  // one full re-serialisation instead of two. A slow tool falls outside and writes twice, as
  // before; its rate is low enough that it never mattered.
  //
  // `owned` is marked synchronously, ahead of the write: get() reads it to decide whether the
  // disk copy could be newer than ours, and between here and the write it cannot be.
  function save(sessionId: string): Promise<void> {
    if (!SESSION_ID_RE.test(sessionId)) return Promise.resolve();
    owned.add(sessionId);
    return scheduleWrite(sessionId);
  }

  return { get, save };
}

export const toolCallsChannel = (id: string) => `toolcalls:${id}`;

// Stored tool outputs are capped so one verbose tool can't bloat the on-disk history (and
// the pane). The raw output still reaches the LLM via the terminal; this is only the copy.
const TOOL_OUTPUT_CAP = 20_000;

export function capToolOutput(output: unknown): unknown {
  if (typeof output === "string" && output.length > TOOL_OUTPUT_CAP) {
    return output.slice(0, TOOL_OUTPUT_CAP) + `\n… (truncated ${output.length - TOOL_OUTPUT_CAP} chars)`;
  }
  return output;
}

// What the hook layer hands the call recorders. `status` is a plain string rather than the
// hook's completed/failed union because this store only records what it was told, and
// ToolCall.status is what it persists.
interface ToolCallStartRecord {
  toolUseId?: string | undefined;
  toolName?: string | undefined;
  toolInput?: unknown;
}

interface ToolCallEndRecord extends ToolCallStartRecord {
  toolOutput?: unknown;
  durationMs?: number | undefined;
  status: string;
}

/** The panel's stores, bound to one pub/sub and one directory root. */
// What each store accepts back off disk. Every REQUIRED field is checked, and the optional ones
// are checked when present — a guard that waved those through would be asserting a type the value
// does not have.
const isToolResult = (value: unknown): value is ToolResult => isRecord(value) && typeof value.uuid === "string";

const isToolCall = (value: unknown): value is ToolCall =>
  isRecord(value) &&
  typeof value.status === "string" &&
  typeof value.at === "number" &&
  (value.toolUseId === undefined || typeof value.toolUseId === "string") &&
  (value.toolName === undefined || typeof value.toolName === "string") &&
  (value.durationMs === undefined || typeof value.durationMs === "number");

export function createToolStores({ publish, root = mulmoterminalHome() }: ToolStoreDeps) {
  // GUI toolResults per session, persisted under ~/.mulmoterminal/toolresults so
  // the panel replays the rendered views even after a server reboot. (Chat +
  // message history live in the terminal and Claude's .jsonl; this is the GUI-side
  // store.) Each entry is an array of toolResults, capped to the most recent N.
  const toolResultsStore = createSessionStore("toolresults", isToolResult, root);
  const GUI_HISTORY_LIMIT = 50;

  // Upsert a toolResult into a session's list, deduped by uuid — a re-emitted result
  // (e.g. a form whose viewState changed after the user submitted) updates in place.
  // Mirrors MulmoClaude's applyToolResultToSession.
  //
  // Returns whether it was stored. A browser-seeded collection placeholder is DROPPED when the
  // agent's real card for that collection is already here (see reconcileCollectionCard) — uuid
  // dedupe cannot catch that pair, because the two arrive with different uuids from different
  // writers. The caller needs the answer so a result that was not stored is not published either.
  async function storeToolResult(sessionId: string, result: ToolResult): Promise<boolean> {
    const list = await toolResultsStore.get(sessionId);
    if (reconcileCollectionCard(list, result) === "skip") {
      // The list may still have changed above; save so a supersede is not lost on restart.
      void toolResultsStore.save(sessionId);
      return false;
    }
    const idx = list.findIndex((r) => r.uuid === result.uuid);
    if (idx >= 0) {
      list[idx] = result;
    } else {
      list.push(result);
      if (list.length > GUI_HISTORY_LIMIT) list.splice(0, list.length - GUI_HISTORY_LIMIT);
    }
    void toolResultsStore.save(sessionId);
    return true;
  }

  // Per-session tool-call history, published on a per-session channel the tools pane
  // subscribes to. (The broker's toolResults store above is separate; it only drives
  // rendering of GUI views.) It has two writers, and which one a session gets decides
  // how complete its history is:
  //
  //   claude          — its PreToolUse/PostToolUse hooks, matcher "", so EVERY tool call:
  //                     built-ins (Bash, Read, …), the user's MCP tools, and ours.
  //   codex / agy     — the MCP broker, since neither has a hook mechanism. GUI tools only.
  //
  // Never both for one session — see mcp/gui-call-history.ts for why that would double
  // rather than dedupe.
  //
  // Persisted under ~/.mulmoterminal/toolcalls via the same disk-backed store as
  // the toolResults, so the history survives a server reboot.
  const toolCallsStore = createSessionStore("toolcalls", isToolCall, root);
  const TOOLCALLS_LIMIT = 200;
  // PreToolUse: a tool started. Append a "running" entry (deduped by tool_use_id).
  async function recordToolCallStart(sessionId: string, { toolUseId, toolName, toolInput }: ToolCallStartRecord) {
    const list = await toolCallsStore.get(sessionId);
    if (toolUseId && list.some((c) => c.toolUseId === toolUseId)) return;
    const call = { toolUseId, toolName, toolInput, status: "running", at: Date.now() };
    list.push(call);
    if (list.length > TOOLCALLS_LIMIT) list.splice(0, list.length - TOOLCALLS_LIMIT);
    publish(toolCallsChannel(sessionId), call);
    void toolCallsStore.save(sessionId);
  }

  // PostToolUse (status "completed") or PostToolUseFailure (status "failed"):
  // complete the matching entry by tool_use_id (or add one if we never saw the
  // start). A failed tool fires PostToolUseFailure, NOT PostToolUse, so both route
  // here — otherwise the entry would be stuck on "running".
  async function recordToolCallEnd(sessionId: string, { toolUseId, toolName, toolInput, toolOutput, durationMs, status }: ToolCallEndRecord) {
    const list = await toolCallsStore.get(sessionId);
    const output = capToolOutput(toolOutput);
    let call = toolUseId ? list.find((c) => c.toolUseId === toolUseId) : undefined;
    if (call) {
      call.status = status;
      call.toolOutput = output;
      call.durationMs = durationMs;
    } else {
      call = { toolUseId, toolName, toolInput, toolOutput: output, status, at: Date.now(), durationMs };
      list.push(call);
      if (list.length > TOOLCALLS_LIMIT) list.splice(0, list.length - TOOLCALLS_LIMIT);
    }
    publish(toolCallsChannel(sessionId), call);
    void toolCallsStore.save(sessionId);
  }

  return { toolResultsStore, toolCallsStore, storeToolResult, recordToolCallStart, recordToolCallEnd };
}
