// The three GUI-plugin tool routes this server answers itself, rather than through a plugin
// package's own router.
//
// All three MUST be mounted before mountAllRoutes' /api/plugin/:toolName catch-all, which
// would otherwise take them. Their failure reporting is narration by contract — see
// plugin-narration.ts for why a failed tool call must still be a 200.
import { randomUUID } from "node:crypto";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Express } from "express";

import { CLAUDE_CWD, PORT } from "../config/env.js";
import { messageOf } from "../errors.js";
import { isRecord } from "../../common/isRecord.js";
import { readString } from "../../common/readString.js";
import { backgroundMarkers, markFailedWorker, markUnplacedSession, ptys } from "../session/registry.js";
import { runWithHiddenMarker } from "../session/hiddenMarker.js";
import { registerCompletionHook } from "../session/completion-hooks.js";
import { backgroundChatMessage, parseBackgroundChat, spawnModeFor, type SpawnMode } from "../session/background-chat.js";
import type { TerminalAgent } from "../../common/sessionAgent.js";
import { registeredGuiMcpGroups } from "../infra/gui-mcp-registration.js";
import { TOOL_GROUPS, type ToolGroup } from "../../common/toolGroups.js";
import { codexifySkillSeed } from "../agents/codex-skills.js";
import { SESSION_HEADER } from "../backends/presentPathRoot.js";
import { SESSION_ID_RE } from "../config/env.js";
import { cwdForSession } from "../session/session-cwd.js";
import { projectScopeForCwd, rootForProjectId, projectId } from "../infra/project-root.js";
import { mulmoterminalHome } from "../infra/mulmoterminal-home.js";
import { slugify } from "../git/worktrees.js";
import { manageCollectionHandlerFor } from "../infra/collection-tool.js";
import { manageSharedApp } from "../infra/shared-app-tool.js";
import { upstreamFailureMessage } from "./plugin-narration.js";
import type { SpawnClaudePty, SpawnCodexPty, SpawnAntigravityPty, SpawnGrokPty, SpawnMusePty } from "../session/spawners.js";

export interface PluginRouteDeps {
  spawnClaudePty: SpawnClaudePty;
  spawnCodexPty: SpawnCodexPty;
  spawnAntigravityPty: SpawnAntigravityPty;
  spawnGrokPty: SpawnGrokPty;
  spawnMusePty: SpawnMusePty;
  /** Put a hidden spawn on the scheduled-session retention (#541). Nobody watches a
   *  background worker and the chat list keeps it behind a filter, so the hook-driven reap
   *  is the only thing that would ever end it — and a worker blocked on a permission prompt
   *  never fires the hook that starts it. */
  registerBackgroundSession: (id: string) => void;
}

// Which agent to start, and how the seed reaches it — one switch over SpawnMode, so an agent added
// to TERMINAL_AGENTS reaches this as a mode with no case rather than as a silent claude spawn.
//
// ws is null on every branch: the session runs headless until the user opens it (a reattach replays
// the buffered output). A claude DRAFT spawns with no initial prompt, so it does not auto-run, and
// the text is typed into its input box afterwards; the other agents have no editable-draft path (no
// stable TUI ready-marker), so their seed always auto-runs as a first-turn prompt — codex typed in,
// agy through `--prompt-interactive`, grok and muse as a positional.
function spawnSeededSession(
  deps: PluginRouteDeps,
  mode: SpawnMode,
  { sessionId, message, mcpGroups, cwd }: { sessionId: string; message: string; mcpGroups: readonly ToolGroup[]; cwd: string },
): void {
  // GUI MCP: every branch below keeps the full toolset regardless of the directory, and that is a
  // decision rather than an oversight. `carriesFullGuiMcp()` is consulted inside each spawner —
  // claude's `attachGuiMcp` defaults true and codex is passed `true` here — so a seeded chat gets
  // the generated `--mcp-config` even when it runs in a project directory, where a plain CELL
  // would instead read the user's own `.mcp.json`.
  //
  // Why that asymmetry is right: this chat exists because a GUI action asked for it, and the seed
  // it carries names collection paths and expects the collection tools. A cell the user opened in
  // that directory has made no such request. The agents that read their groups from a file in the
  // directory get them from `groupsForSpawn(agent, cwd)` instead, which is the per-directory
  // mechanism that DOES have to follow the cwd.
  const initialPrompt = codexifySkillSeed(message);
  if (mode === "codex-run") deps.spawnCodexPty(sessionId, null, null, cwd, true, { initialPrompt });
  else if (mode === "antigravity-run") deps.spawnAntigravityPty(sessionId, null, null, cwd, { mcpGroups, initialPrompt });
  else if (mode === "grok-run") deps.spawnGrokPty(sessionId, null, null, cwd, { mcpGroups, initialPrompt });
  else if (mode === "muse-run") deps.spawnMusePty(sessionId, null, null, cwd, { mcpGroups, initialPrompt });
  else if (mode === "claude-draft") deps.spawnClaudePty(sessionId, null, null, { draft: message, cwd });
  else deps.spawnClaudePty(sessionId, null, null, { initialPrompt: message, cwd });
}

/** Where a seeded chat runs: the project it was started from, or the workspace when it named
 *  none. `null` means the request named a project this server does not know — refused rather than
 *  quietly spawned in the workspace, which is the substitution the rest of this surface refuses.
 *
 *  The id is resolved against the server's OWN list of directories; it is never a path. */
function spawnCwdFor(project: string | null): string | null {
  return project === null ? CLAUDE_CWD : rootForProjectId(project);
}

/** The GUI MCP groups a seeded spawn must be handed, resolved from the directory it will run in.
 *
 *  The agents that read their GUI MCP servers from a FILE in the working directory — agy's
 *  `.agents/mcp_config.json` and grok's `.grok/config.toml` — share that file with every other
 *  session running there, so the groups have to be resolved BEFORE the spawn rewrites it: passing
 *  none would clear the entries those sessions are using (#1095 review).
 *
 *  Which agents need them resolved here: the ones that do not get a per-spawn `--mcp-config`. agy
 *  and grok write them into a config file in the directory; muse takes them as its session's
 *  entitlement (server/session/bridge-session.ts) — and it was left out of this list when it was
 *  wired, so a background muse chat got an empty list and therefore no GUI tools, in a workspace
 *  that had them registered (Codex review on #1514).
 *
 *  Read from the SPAWN's directory, not the workspace: those config files live in the directory
 *  the session runs in, so a chat spawned in a project must be told what that project registered. */
async function groupsForSpawn(agent: TerminalAgent, cwd: string): Promise<readonly ToolGroup[]> {
  const needsGroups = agent === "antigravity" || agent === "grok" || agent === "muse";
  return needsGroups ? await registeredGuiMcpGroups(cwd, TOOL_GROUPS).catch(() => []) : [];
}

export function mountPluginRoutes(app: Express, deps: PluginRouteDeps): void {
  // Host tool: spawnBackgroundChat. Unlike a plugin (handled by mountAllRoutes'
  // catch-all), it needs server internals — it spawns a brand-new interactive Claude
  // terminal session, seeded with `message`, that the user can open from the sidebar.
  // `role` is ignored (MulmoTerminal has no roles). `hidden:true` marks it a background
  // worker: it still lists in the sidebar, but behind the Background filter and never
  // bold/unread. `draft:true` makes `message` an editable DRAFT — typed into the input box
  // but NOT auto-submitted (the collection-plugin's startNewChatDraft / template cards),
  // so the user reviews and presses Enter.
  app.post("/api/plugin/spawnBackgroundChat", async (req, res) => {
    const parsed = parseBackgroundChat(req.body);
    if (!parsed.ok) return res.json({ message: parsed.message });
    const { agent, draft, hidden, message, project } = parsed.request;
    const cwd = spawnCwdFor(project);
    if (cwd === null) return res.json({ message: `spawnBackgroundChat: unknown project '${project?.replace(/[\r\n]/g, " ") ?? ""}'.` });
    const sessionId = randomUUID();
    const mcpGroups = await groupsForSpawn(agent, cwd);
    try {
      runWithHiddenMarker(hidden, sessionId, backgroundMarkers, () =>
        spawnSeededSession(deps, spawnModeFor(agent, draft), { sessionId, message, mcpGroups, cwd }),
      );
      // Visible: somebody should be able to SEE this session. The browser that asked for it
      // places it immediately (useChatLauncher), and this covers every other caller — an agent
      // calling the tool from another session, with no tab open at all. The mark is cleared the
      // moment any cell attaches, so the browser-placed case does not come back as a duplicate.
      if (!hidden) markUnplacedSession(sessionId, agent);
      if (hidden) {
        deps.registerBackgroundSession(sessionId);
        // A hidden worker is invisible on purpose, which is exactly why a FAILED one needs a
        // record: nothing pulls the user's attention and nothing waits to be clicked, so the
        // failure is otherwise never learned. The completion hook is the existing seam for it —
        // a finished turn reports success first and this never fires; reaching teardown with no
        // Stop means no turn ever completed (see completion-hooks.ts for why first-answer-wins).
        //
        // Registered AFTER the spawn: a launch that threw has no session to report on, and would
        // leave a hook nothing will ever fire or clear. Safe against the feeds engine's own hook
        // (last writer wins) because that dispatches through its own spawner, never this route.
        //
        // CLAUDE ONLY, and that is a correctness limit rather than a scope choice. The single
        // success signal a PTY-hosted agent gives us is a finished turn reported by Claude Code's
        // Stop hook (hook-routes.ts); codex and antigravity have no hook mechanism at all, so
        // they can never report success. Registering for them would mean every SUCCESSFUL hidden
        // codex worker reached reap unreported and was marked failed — a signal that is wrong
        // more often than it is right, which is worse than the silence it replaced.
        // (Codex, PR #1188.) A non-claude hidden worker therefore keeps today's behaviour: no
        // failure signal. Giving it one needs a completion signal for those agents first.
        //
        // RECORDS ONLY, and synchronously. Announcing is reap's job: it publishes one teardown
        // message carrying this outcome, which is what keeps the generic notification from
        // racing ahead of the specific one. Staying synchronous is therefore a contract, not an
        // implementation detail — reap reads the flag immediately after firing this.
        if (agent === "claude") {
          registerCompletionHook(sessionId, ({ didError }) => {
            if (didError) markFailedWorker(sessionId);
          });
        }
      }
    } catch (err) {
      console.error(`[spawnBackgroundChat] failed for ${sessionId}: ${messageOf(err)}`);
      return res.json({ message: `Failed to spawn a new session: ${messageOf(err)}` });
    }
    return res.json({ message: backgroundChatMessage(agent, draft, sessionId), jsonData: { chatId: sessionId, agent } });
  });

  // Host tool: manageAccounting. The accounting package exposes no gui-chat-protocol
  // `.` core (just the Vue View + the /api/accounting router), so — like MulmoClaude's
  // host-side passthrough execute — this route bridges the GUI MCP tool to that router.
  // The router's envelope ({ action, ...data, message }) flows straight back to the
  // broker: `data` (set for PREVIEW actions) gates the GUI publish, `message` narrates
  // to claude.
  app.post("/api/plugin/manageAccounting", async (req, res) => {
    try {
      const upstream = await fetch(`http://127.0.0.1:${PORT}/api/accounting`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(isRecord(req.body) ? req.body : {}),
      });
      const body: unknown = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        // A refused request is only ever narrated to the agent, so without this it leaves no
        // trace on the server at all — and a router answering `{ error: "" }` leaves none with
        // the agent either. "Could not connect" is logged below; "connected and was refused"
        // should be too.
        const message = upstreamFailureMessage(upstream.status, body, "accounting request failed");
        console.error(`[manageAccounting] upstream ${upstream.status}: ${message || "(no message)"}`);
        return res.json({ message });
      }
      return res.json(body);
    } catch (err) {
      console.error(`[manageAccounting] dispatch failed: ${messageOf(err)}`);
      return res.json({ message: `accounting dispatch failed: ${messageOf(err)}` });
    }
  });

  mountClearSessionRoute(app);
  mountCollectionRoute(app);
  mountSharedAppRoute(app);
}

// One directory per project (keyed by the same opaque, non-reversible id project-root.ts
// mints for collections), under mulmoterminalHome() rather than env.ts's frozen
// MULMOTERMINAL_HOME — this is new code, so it gets the override-respecting accessor rather
// than adding another caller of the constant tracked in issue #3.
function clearLogDir(cwd: string): string {
  return path.join(mulmoterminalHome(), "clear-logs", projectId(cwd));
}

// A stable, sortable, filesystem-safe filename: the timestamp keeps entries ordered without
// reading their contents, the slug keeps them recognisable in a directory listing.
function clearLogFilename(title: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${slugify(title)}.md`;
}

// Appended, never rewritten: the index is the ONE file a human (or a future agent deciding
// whether digging further is worth it) reads in full, so it stays cheap to load however many
// records pile up — a title and a link, not the record itself.
async function appendClearLogIndex(dir: string, title: string, filename: string): Promise<void> {
  const line = `- ${new Date().toISOString()} — [${title}](./${filename})\n`;
  await appendFile(path.join(dir, "index.md"), line, "utf8");
}

/** Split out of `mountPluginRoutes` for its line budget, same as the two routes below. */
function mountClearSessionRoute(app: Express): void {
  // Host tool: clearSession. Writes `title`/`minutes` to a per-project log, then types
  // "/clear\r" into the CALLING session's own pty — the session id rides in the same header
  // manageCollection/manageSharedApp read below, since that is the MCP broker's only way to
  // say which session is asking. No session id, or one whose pty is already gone (session
  // ended, or this was reached from outside a live terminal), narrates rather than throwing —
  // a clear that can't find anything to clear.
  app.post("/api/plugin/clearSession", async (req, res) => {
    const header = req.get(SESSION_HEADER);
    const sessionId = header && SESSION_ID_RE.test(header) ? header : null;
    const entry = sessionId ? ptys.get(sessionId) : undefined;
    if (!entry) return res.json({ message: "clearSession: no active terminal session found." });

    const body = isRecord(req.body) ? req.body : {};
    const title = readString(body.title).trim();
    const minutes = readString(body.minutes).trim();
    if (!title || !minutes) {
      return res.json({ message: "clearSession: both `title` and `minutes` are required — nothing was cleared." });
    }

    const dir = clearLogDir(cwdForSession(sessionId));
    const filename = clearLogFilename(title);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, filename), `# ${title}\n\n${minutes}\n`, "utf8");
      await appendClearLogIndex(dir, title, filename);
    } catch (err) {
      console.error(`[clearSession] failed to write minutes for ${sessionId}: ${messageOf(err)}`);
      return res.json({ message: `clearSession: could not save minutes (${messageOf(err)}) — nothing was cleared.` });
    }

    try {
      entry.term.write("/clear\r");
    } catch (err) {
      console.error(`[clearSession] write failed for ${sessionId}: ${messageOf(err)}`);
      return res.json({ message: `clearSession: minutes saved, but clearing failed: ${messageOf(err)}` });
    }
    return res.json({ message: `Session cleared. Minutes saved: ${path.join(dir, filename)}` });
  });
}

/** Split out of `mountPluginRoutes` for its line budget. Both of these are host-tool dispatch
 *  routes and belong beside each other; only the enclosing function's size moved them out. */
function mountCollectionRoute(app: Express): void {
  // Host tool: manageCollection — the shared collection data plane
  // (@mulmoclaude/core/collection/server, bound in server/infra/collection-tool.ts).
  // The engine runs in-process against the configured workspace, so the route calls the
  // handler directly. The result string (JSON for the read/write actions) narrates to claude
  // via the envelope `message`; no `data`, so nothing publishes to the GUI — same as
  // MulmoClaude.
  app.post("/api/plugin/manageCollection", async (req, res) => {
    try {
      // Scoped to the SESSION's directory, not the workspace. An agent asked to make a
      // collection "here" means the folder its cell is open in, and the workspace-bound handler
      // silently made it somewhere else — the read/write surface was scoped per request while
      // this, the agent's own data plane, still resolved one fixed root.
      //
      // The session id rides in a header from the MCP broker, and `cwdForSession` is the same
      // lookup presentDocument's relative paths already resolve through, so the tool and the
      // documents it produces agree on where "here" is.
      const header = req.get(SESSION_HEADER);
      const sessionId = header && SESSION_ID_RE.test(header) ? header : null;
      const handler = manageCollectionHandlerFor(projectScopeForCwd(cwdForSession(sessionId)).workspaceRoot);
      const message = await handler(isRecord(req.body) ? req.body : {});
      return res.json({ message });
    } catch (err) {
      console.error(`[manageCollection] dispatch failed: ${messageOf(err)}`);
      return res.json({ message: `manageCollection failed: ${messageOf(err)}` });
    }
  });
}

function mountSharedAppRoute(app: Express): void {
  // Host tool: manageSharedApp — deploy / publish / unpublish for the shared app declared by the
  // repository's app.json (server/infra/shared-app-tool.ts). MulmoTerminal's own; there is no
  // counterpart in MulmoClaude to match, which is the point of the tool existing here.
  //
  // Scoped to the SESSION's directory for the same reason manageCollection is: an app is a
  // REPOSITORY, and "deploy this app" means the one the cell is open in. Resolving it to the
  // workspace would deploy a different app than the agent is looking at — and unlike a misplaced
  // collection, that one is visible to other people the moment it lands.
  app.post("/api/plugin/manageSharedApp", async (req, res) => {
    try {
      const header = req.get(SESSION_HEADER);
      const sessionId = header && SESSION_ID_RE.test(header) ? header : null;
      const root = projectScopeForCwd(cwdForSession(sessionId)).workspaceRoot;
      return res.json({ message: await manageSharedApp(root, req.body) });
    } catch (err) {
      console.error(`[manageSharedApp] dispatch failed: ${messageOf(err)}`);
      return res.json({ message: `manageSharedApp failed: ${messageOf(err)}` });
    }
  });
}
