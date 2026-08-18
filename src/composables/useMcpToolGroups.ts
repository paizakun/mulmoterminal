import { ref, type Ref } from "vue";
import { TOOL_GROUPS, type ToolGroup } from "../../common/toolGroups";
import { queueMcpWrite } from "../components/mcpWriteQueue";
import { isUnknownArray } from "../../common/isUnknownArray";
import { jsonBody } from "../jsonBody";
// The POST shells out to `claude mcp add` / `remove`; the GET only reads config files, so it
// keeps the ordinary deadline.
import { fetchWithTimeout, SLOW_COMMAND_TIMEOUT_MS } from "../utils/fetchWithTimeout";

// Which GUI tool groups a directory hands its agents, one switch per group in TOOL_GROUPS
// (render, data, media, external). NOT MulmoTerminal state: each is an MCP server registered in
// Claude Code's own local-scope config for that directory, so the switches read and write through
// /api/gui-mcp-groups and `claude mcp list` stays the one place they can be seen.
//
// One record per group rather than a flag per group: the switches differ only in the group they
// name, so adding one to TOOL_GROUPS should not mean another copy of this block.
// The groups spelled out, which reads like a step back from deriving them — and is not.
// `Object.fromEntries` types every key as `string`, so it cannot say the result covers ToolGroup;
// the assertion that used to bridge that gap ACCEPTS a missing key silently. Written out against a
// `Record<ToolGroup, T>` annotation, a group added to TOOL_GROUPS makes this a compile error
// instead — the reminder arrives, rather than a switch quietly never appearing.
const byToolGroup = <T>(value: T): Record<ToolGroup, T> => ({ render: value, data: value, media: value, external: value, session: value });

interface Switches {
  // The directory the switches currently describe. Null means there is nothing to show — either
  // no answer yet, or an answer that no longer belongs to the directory being asked about.
  dir: Ref<string | null>;
  enabled: Ref<Record<ToolGroup, boolean>>;
  busy: Ref<Record<ToolGroup, boolean>>;
  failed: Ref<Record<ToolGroup, string | null>>;
  // Request token: a reply for a directory the user has since moved off is dropped.
  req: number;
}

// Take the switches away without asking for new ones — the directory field just changed, and rows
// left on screen during the reload would be the PREVIOUS directory's positions under the new
// directory's name.
function forget(switches: Switches): void {
  switches.req++;
  switches.dir.value = null;
}

async function load(switches: Switches, target: string | null): Promise<void> {
  const reqId = ++switches.req;
  // Cleared BEFORE the fetch, not only on the failure path: the switches showing while the answer
  // is in flight are the previous directory's, and a flip during that gap writes to the previous
  // directory (apply captures the dir, which is what keeps a queued write honest). The rows come
  // back a moment later with this directory's real positions.
  switches.dir.value = null;
  if (!target) return;
  try {
    const res = await fetchWithTimeout(`/api/gui-mcp-groups?cwd=${encodeURIComponent(target)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await jsonBody(res);
    // A slower reply for a directory the user has since moved off would show its answer under the
    // new directory's name.
    if (reqId !== switches.req) return;
    // THROWN, not defaulted to an empty list. The route always answers `{ groups: [...] }`, so a
    // missing `groups` means the body could not be read — `jsonBody` absorbs a truncated or
    // aborted one into `{}` and returns NORMALLY, which would walk straight past the catch below
    // and paint every switch "off". That is the one position the catch exists to refuse.
    if (!isUnknownArray(data.groups)) throw new Error("GET /api/gui-mcp-groups → body is not { groups }");
    switches.dir.value = target;
    const registered: unknown[] = data.groups;
    switches.enabled.value = byToolGroup(false);
    for (const group of TOOL_GROUPS) switches.enabled.value[group] = registered.includes(group);
    switches.failed.value = byToolGroup(null);
  } catch {
    // No switch rather than one whose position is a guess — flipping a wrong "off" would run
    // `claude mcp remove` on a registration the user may actually have.
    if (reqId === switches.req) switches.dir.value = null;
  }
}

// Writes into the user's Claude Code config, so a failure is surfaced and the checkbox is put
// back — a switch that shows "on" for a registration that was never written is the worst state.
//
// Busy is set HERE, when the write is queued, not when it starts running. Marking it at the
// front of the queued callback would leave the checkbox live while it waits behind another
// group's save: a second flip would queue a second write, and since a failed write puts its
// checkbox back, the earlier failure's rollback would land on top of the later intent — flip on,
// flip off, end up on. Disabled from the flip until the write settles, there is only ever one.
// The DIRECTORY is captured here too, for the same reason: a queued write can run long after the
// flip, and the launcher's directory field is editable the whole time. Read at execution time, a
// switch ticked for A would register the MCP server against whatever B the user had typed by
// then — a silent write to a folder they never touched the switch in.
function apply(switches: Switches, group: ToolGroup): Promise<void> {
  const target = switches.dir.value;
  if (!target) return Promise.resolve();
  const wanted = switches.enabled.value[group];
  switches.busy.value[group] = true;
  switches.failed.value[group] = null;
  return queueMcpWrite(() => write(switches, group, target, wanted));
}

async function write(switches: Switches, group: ToolGroup, target: string, wanted: boolean): Promise<void> {
  try {
    const res = await fetchWithTimeout(
      "/api/gui-mcp-groups",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: target, group, enabled: wanted }),
      },
      SLOW_COMMAND_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await jsonBody(res);
    if (data.ok !== true) throw new Error(typeof data.message === "string" && data.message ? data.message : "claude mcp failed");
  } catch (e) {
    // Only if the switches still belong to the directory this write was for. Moved on, they are
    // showing what the NEW directory has registered, and putting one back would report another
    // folder's failure as that directory's state.
    if (switches.dir.value === target) {
      switches.enabled.value[group] = !wanted;
      switches.failed.value[group] = e instanceof Error ? e.message : String(e);
    }
  } finally {
    switches.busy.value[group] = false;
  }
}

// Claude Code keys local-scope MCP config by the CLI's working directory, and a worktree launch
// starts claude in the WORKTREE — not in the repository the switches were set for. Without this
// the session gets no GUI tools even though the launcher plainly says the group is on.
//
// A SYNC of every group, not a copy of the ticked ones. A REUSED worktree can carry a
// registration from an earlier launch, and mirroring only the "on" groups leaves that stale one
// standing: uncheck `external` in the repo, reuse the worktree it was once on for, and the
// session gets external tools the launcher shows as off. Over-granting is the direction that
// matters, so a group that is off here is removed there.
//
// Copied rather than moved: the repository keeps its own registration, and a worktree is a
// throwaway room that should start out like the repo it came from. Failures are swallowed —
// the launch itself is what the user asked for, and the Canvas button will report the truth.
//
// Only the groups that actually DIFFER are written, because each write shells out to the
// `claude` CLI and the launch waits on them. The target's current state is one config-file read
// (the GET does not shell out); when it cannot be read, every group is written rather than
// assumed — a wrong assumption here is the stale registration this exists to clear.
async function syncInto(switches: Switches, worktreePath: string): Promise<void> {
  if (!switches.dir.value || worktreePath === switches.dir.value) return;
  // Read once, here — same rule `apply` follows. Each write shells out to the `claude` CLI and the
  // whole loop is awaited with the launcher still on screen, so the switches can be flipped, or
  // wholesale replaced by a reload for a directory the user typed meanwhile, between deciding what
  // to write and writing it. Read lazily, the worktree would then be handed another directory's
  // positions under this repository's name.
  const wantedNow = { ...switches.enabled.value };
  const already = await registeredIn(worktreePath);
  const wanted = (group: ToolGroup) => wantedNow[group];
  const changed = TOOL_GROUPS.filter((group) => already === null || already.includes(group) !== wanted(group));
  // Through the same queue as the switches, one group at a time: a launch that fires while a
  // checkbox is still saving would otherwise be the very concurrent write the queue exists for.
  for (const group of changed) {
    await queueMcpWrite(async () => {
      try {
        await fetchWithTimeout(
          "/api/gui-mcp-groups",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd: worktreePath, group, enabled: wanted(group) }),
          },
          SLOW_COMMAND_TIMEOUT_MS,
        );
      } catch {
        // best-effort — a worktree without the registration still launches, just without the tools
      }
    });
  }
}

// What the target directory has registered right now, or null when that can't be read — which the
// caller reads as "write every group" rather than as "nothing is registered".
async function registeredIn(dir: string): Promise<unknown[] | null> {
  try {
    const res = await fetchWithTimeout(`/api/gui-mcp-groups?cwd=${encodeURIComponent(dir)}`);
    if (!res.ok) return null;
    const data = await jsonBody(res);
    return isUnknownArray(data.groups) ? data.groups : null;
  } catch {
    return null;
  }
}

export function useMcpToolGroups() {
  const switches: Switches = {
    dir: ref<string | null>(null),
    enabled: ref(byToolGroup(false)),
    busy: ref(byToolGroup(false)),
    failed: ref(byToolGroup<string | null>(null)),
    req: 0,
  };
  return {
    dir: switches.dir,
    enabled: switches.enabled,
    busy: switches.busy,
    failed: switches.failed,
    forget: () => forget(switches),
    load: (target: string | null) => load(switches, target),
    apply: (group: ToolGroup) => apply(switches, group),
    syncInto: (worktreePath: string) => syncInto(switches, worktreePath),
  };
}
