// The GUI MCP registration for `muse`, which reaches MCP through neither a flag nor a file in the
// project but through a PLUGIN — the third shape, and the reason this file looks like neither
// grok-mcp.ts nor antigravity-mcp.ts.
//
// What muse offers (measured against muse-bin 0.1.0-R708.1, 2026-08-06):
//
//   A plugin is a directory with `.muse-plugin/plugin.json`, whose `capabilities.mcpServers` is a
//   list of `{ id, transport: "stdio", command }`. `muse plugins install <dir>` copies it into a
//   content-addressed cache and records it; `muse plugins approve <id>` trusts the capability, and
//   only then does a session start the server. `streamable_http` parses but is not wired yet
//   ("streamable HTTP transport startup is not wired yet"), so stdio — our bridge — is the transport.
//
// THREE consequences shape everything below, and each of them is why some part of this is not just
// grok's file with different words:
//
//   1. INSTALLATION IS PER MACHINE. `--scope project` writes nothing into the project (measured:
//      installing from one directory left it untouched and the plugin was listed from another), so
//      a per-directory registration cannot be expressed by installing and removing. Every group
//      server is therefore registered once, and the SESSION decides which of them serve: the
//      spawn records the directory's groups against the session id, the bridge asks for them when
//      it resolves itself, and one whose group is not among them stands down with an empty toolset
//      (server/mcp/bridge.mjs). The directory's own switches still govern — they are read from the
//      same place claude's, agy's and grok's are.
//
//   2. NOTHING REACHES THE SERVER BUT ITS COMMAND LINE. A plugin's MCP server is started with a
//      CURATED ENVIRONMENT — measured at 16 variables, all of muse's own choosing — so neither the
//      muse process's environment nor an `env` block in this manifest arrives (both were measured:
//      the block validates, and then the server sees neither it nor anything of ours). So the group
//      and the port are argv, and the SESSION — which cannot be baked into a machine-wide manifest
//      anyway — is asked for at runtime: the bridge maps its own pid back to the session whose tmux
//      pane it runs under (server/session/bridge-session.ts).
//
//   3. PLUGINS ARE BEHIND AN EXPERIMENTAL FLAG. Without `MUSE_EXPERIMENTAL_PLUGINS=1` every
//      `muse plugins` verb answers "plugins are not available in this build". It is set on the CLI
//      calls here AND on the session spawn, and its absence is a reason for a muse cell to have no
//      GUI tools — never a reason for it to fail to start. A build that drops the flag makes every
//      call below fail, which lands in the same warning as a build with no plugin support at all.
//
// The SERVER IDS are the group names alone (`render`, `data`, …) rather than
// `toolGroupServerId()`'s `mulmoterminal-<group>`, and that divergence is deliberate. Those ids are
// long because they are keys in files USERS wrote, which is what makes renaming them a migration
// (common/toolGroups.ts). Nothing user-written names these: the manifest is generated here, and
// muse composes the tool name from the plugin id and the capability id — so
// `mcp__plugin_mulmoterminal_render__presentChart`, where the ids in `toolGroupServerId()` form
// would repeat our name in every tool name, in every listing, in every session.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TOOL_GROUPS } from "../../common/toolGroups.js";
import { isRecord } from "../../common/isRecord.js";
import { byCodeUnit } from "../../common/byCodeUnit.js";
import { PORT } from "../config/env.js";
import { mulmoterminalHome } from "../infra/mulmoterminal-home.js";
import { spawnCapture } from "../infra/spawnCapture.js";
import { bridgeCommand } from "./gui-mcp-bridge.js";
import { museAdapter } from "./muse.js";

/** The plugin id, which muse puts in every tool name — hence the short one. */
export const MUSE_PLUGIN_ID = "mulmoterminal";

/** The bundle we generate and hand to `muse plugins install`. Under our own config directory
 *  rather than in the user's project: there is one installation per machine, so a copy per
 *  directory would duplicate the same manifest everywhere and leave every copy but one stale. */
export const musePluginDir = (): string => path.join(mulmoterminalHome(), "muse-plugin");

/** The flag every `muse plugins` call needs; see the header. */
export const musePluginEnv = (): Record<string, string> => ({ MUSE_EXPERIMENTAL_PLUGINS: "1" });

/** What muse is told this plugin is. Pure, so the manifest a spec asserts on is the manifest that
 *  gets written — including the argv, which is where the group AND the port live (see 2. above:
 *  argv is the only channel that reaches the server this registers). */
export function musePluginManifest(bridge: { command: string; args: string[] }, port: string | number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: MUSE_PLUGIN_ID,
    displayName: "MulmoTerminal",
    version: "1.0.0",
    description: "MulmoTerminal's GUI tools — the Canvas, workspace data, media, external accounts, and session control.",
    compat: { source: "native", manifestDir: ".muse-plugin" },
    capabilities: {
      skills: [],
      commands: [],
      hooks: [],
      reminders: [],
      // Every group, always. Which of them a session may actually reach is decided per session
      // (see 1. in the header), because installation cannot express it.
      mcpServers: TOOL_GROUPS.map((group) => ({
        id: group,
        transport: "stdio",
        // The PORT is baked in because nothing else can carry it: the environment a plugin server
        // is started with holds none of ours. A server that comes back on a different port declares
        // a different command, which the check below sees and re-installs.
        command: [bridge.command, ...bridge.args, "--group", group, "--port", String(port)],
      })),
    },
  };
}

const manifestPath = (dir: string): string => path.join(dir, ".muse-plugin", "plugin.json");

/** Write the bundle where `muse plugins install` will read it. Separated from the install so the
 *  manifest is testable without a muse on PATH. */
export function writeMusePlugin(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(path.dirname(manifestPath(dir)), { recursive: true });
  writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** One `muse plugins` call, JSON-parsed, with every failure reading as "nothing there". */
// Every call here runs on the /ws/muse path, which is the event loop — so the bound is what stops
// a hung `muse plugins` from freezing every other session on the server, not just this spawn. The
// install copies a package and hashes it; 20s is far beyond the ~0.3s it has been measured at.
const MUSE_PLUGINS_TIMEOUT_MS = 20_000;

function runMusePlugins(args: string[]): { ok: boolean; message: string; json: unknown } {
  const { status, stdout, stderr } = spawnCapture(museAdapter.bin(), ["plugins", ...args], {
    env: { ...process.env, ...musePluginEnv() },
    timeoutMs: MUSE_PLUGINS_TIMEOUT_MS,
  });
  return { ok: status === 0, message: [stdout, stderr].filter(Boolean).join("\n").trim(), json: parsed(stdout) };
}

// When this process last confirmed muse's registration. See syncMuseMcpPlugin. `-Infinity` rather
// than 0, so "never checked" cannot read as "checked at the epoch" — which, for any clock a test
// hands in, is inside the window.
let verifiedAtMs = -Infinity;
const VERIFY_TTL_MS = 60_000;

/** A `--json` answer, or null for anything unusable — a build that prints a sentence instead
 *  ("plugins are not available in this build") lands here, and reads as "nothing registered". */
function parsed(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Is muse's OWN registration already the one this manifest describes?
 *
 * Asked of `muse plugins inspect`, not of a note we left ourselves, and that distinction is the
 * whole point of this function. The first version recorded the digest of the manifest it had last
 * installed and skipped the install when it matched — which is a record of what WE did, not of what
 * muse HAS. Anything that removes the plugin on muse's side (`muse plugins remove`, a cleared
 * cache, a muse reinstall, another tool) then left the two permanently disagreeing: our note said
 * "installed", muse had nothing, and every muse cell started with no GUI tools and nothing logged.
 * That is exactly how this shipped broken the first time.
 *
 * Three conditions, because a plugin can be present and still not serve:
 *   - `active`: installed, enabled, and its package still valid.
 *   - every capability `trusted_enabled`: an unapproved one is listed and never started, which is
 *     what a CHANGED manifest produces (trust is keyed to the definition hash).
 *   - the commands match ours: the bridge path or the port may have moved, and a stale command
 *     points a session at a server that is not there.
 */
export function museRegistrationMatches(inspected: unknown, manifest: Record<string, unknown>): boolean {
  if (!isRecord(inspected) || inspected.active !== true) return false;
  const capabilities = inspected.runtime_capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0) return false;
  if (!capabilities.every((entry) => isRecord(entry) && entry.status === "trusted_enabled")) return false;
  return sameServers(museServersOf(inspected), museServersOf(manifest));
}

/** `[id, command…]` per declared server, from either shape — muse's inspect output nests the
 *  capabilities under `plugin`, our manifest has them at the top. */
function museServersOf(doc: unknown): string[] {
  const root = isRecord(doc) && isRecord(doc.plugin) ? doc.plugin : doc;
  if (!isRecord(root) || !isRecord(root.capabilities)) return [];
  const capabilities: Record<string, unknown> = root.capabilities;
  // Two spellings for one thing: our manifest writes `mcpServers`, muse's inspect answers
  // `mcp_servers`. Both are read so the comparison can be made between them at all.
  const servers = capabilities.mcpServers ?? capabilities.mcp_servers;
  if (!Array.isArray(servers)) return [];
  return (
    servers
      .filter(isRecord)
      .map((server) => [String(server.id), ...(Array.isArray(server.command) ? server.command.map(String) : [])].join(" "))
      // byCodeUnit, not the default sort: this list is compared for EQUALITY between two sources, so
      // it only has to be the same order on both sides — and a locale-aware sort is not.
      .toSorted(byCodeUnit)
  );
}

const sameServers = (a: readonly string[], b: readonly string[]): boolean => a.length > 0 && a.length === b.length && a.every((entry, i) => entry === b[i]);

/**
 * Make this machine's muse able to reach the GUI tools.
 *
 * Idempotent, and cheap when nothing changed: one `muse plugins inspect` (~100ms) and no writing.
 * That read is not optional — see museRegistrationMatches for what skipping it cost.
 *
 * Both verbs are needed and in this order: install records the plugin, approve trusts the
 * capability definitions by their hash, and an unapproved capability is listed but never started.
 *
 * Never throws. A muse that is not installed, a build without the plugin flag, and a read-only
 * config directory are all reasons for a cell to have no GUI tools — none of them a reason for the
 * session not to start.
 */
export function syncMuseMcpPlugin(dir = musePluginDir(), now = Date.now()): { ok: boolean; message: string } {
  try {
    // Verified recently by THIS process, so nothing can have changed that this would catch: the
    // manifest is derived from our own bridge path and port, both fixed for the life of the server.
    // The window exists because a reattach also comes through here (see spawn-muse.ts) and a
    // reloaded browser tab reattaches every cell at once — without it, one page refresh spawns a
    // `muse plugins inspect` per muse cell on screen.
    if (now - verifiedAtMs < VERIFY_TTL_MS) return { ok: true, message: "" };

    const manifest = musePluginManifest(bridgeCommand(), PORT);
    if (museRegistrationMatches(runMusePlugins(["inspect", MUSE_PLUGIN_ID, "--json"]).json, manifest)) {
      verifiedAtMs = now;
      return { ok: true, message: "" };
    }

    writeMusePlugin(dir, manifest);
    const installed = runMusePlugins(["install", dir, "--scope", "user", "--json"]);
    if (!installed.ok) return warn(installed.message);
    const approved = runMusePlugins(["approve", MUSE_PLUGIN_ID, "--json"]);
    if (!approved.ok) return warn(approved.message);

    verifiedAtMs = now;
    // Says what it does NOT cover, because that is the surprising half: muse reads its plugins when
    // the session's process starts, and MulmoTerminal's sessions outlive the server (tmux). So a
    // muse that was already running when this landed has no GUI tools until it is started again —
    // restarting the SERVER is not enough, and the cell looks broken rather than out of date.
    console.log(`[muse] registered the GUI MCP plugin (${TOOL_GROUPS.length} tool groups) — muse sessions already running keep no tools until restarted`);
    return { ok: true, message: "" };
  } catch (err) {
    return warn(String(err));
  }
}

function warn(message: string): { ok: boolean; message: string } {
  // One line, and it names the flag: "plugins are not available in this build" is the message a
  // reader will otherwise search for and find nothing about.
  console.warn(`[muse] could not register the GUI MCP plugin — muse cells will have no GUI tools: ${message}`);
  return { ok: false, message };
}
