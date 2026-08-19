// Turning a directory's GUI tool group on and off, through Claude Code's OWN per-folder MCP
// config rather than a MulmoTerminal setting.
//
// MulmoTerminal deliberately stores nothing about this: `claude mcp add -s local` writes the
// registration into ~/.claude.json keyed by the directory, which is already the mechanism for
// "this folder gets that MCP server" — a second registry here would be one more place to look,
// with no approval gate and no `claude mcp list` to see it in.
//
// `local` scope, not `project`: it lands in the user's own file rather than a `.mcp.json`
// committed to their repo, so enabling a tool group for yourself never shows up in a diff.
//
// The url is a TEMPLATE, not a resolved address. Claude Code expands `${VAR}` in an MCP url at
// connect time, and the two moving parts (our port, the session id) are only known per spawn —
// they are set on each session's environment (see session/mcp-config.ts guiMcpEnv).
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnCaptureAsync } from "./spawnCapture.js";
import { toolGroupServerId, type ToolGroup } from "../../common/toolGroups.js";
import { isRecord } from "../../common/isRecord.js";

export const guiMcpUrlTemplate = (group: ToolGroup): string => `http://127.0.0.1:\${MULMOTERMINAL_PORT}/api/mcp/${group}/\${MULMOTERMINAL_SESSION_ID}`;

export interface GuiMcpRegistration {
  ok: boolean;
  /** stdout+stderr from the CLI, so a failure can be shown rather than guessed at. */
  message: string;
}

// `cwd` is what makes it per-folder: local scope is keyed by the directory the CLI runs in.
async function claudeMcp(bin: string, cwd: string, args: string[]): Promise<GuiMcpRegistration> {
  // Both streams: the CLI explains a refusal on stderr, and "it failed" with an empty message
  // is the one thing this route must never answer.
  const { status, stdout, stderr } = await spawnCaptureAsync(bin, ["mcp", ...args], { cwd });
  return { ok: status === 0, message: [stdout, stderr].filter(Boolean).join("\n").trim() };
}

export async function registerGuiMcpGroup(bin: string, cwd: string, group: ToolGroup): Promise<GuiMcpRegistration> {
  const id = toolGroupServerId(group);
  // Remove first so re-enabling repairs a registration written against an older url (the
  // template changes only when the route does, but a user may also have edited it). `remove`
  // failing means it was not there, which is the normal case — its status is deliberately
  // ignored rather than reported as the operation's.
  await claudeMcp(bin, cwd, ["remove", id, "-s", "local"]);
  return claudeMcp(bin, cwd, ["add", "-s", "local", "--transport", "http", id, guiMcpUrlTemplate(group)]);
}

export function unregisterGuiMcpGroup(bin: string, cwd: string, group: ToolGroup): Promise<GuiMcpRegistration> {
  return claudeMcp(bin, cwd, ["remove", toolGroupServerId(group), "-s", "local"]);
}

// Claude Code's own config file, which is where `claude mcp add -s local` writes. It defaults to
// ~/.claude.json and moves WITH CLAUDE_CONFIG_DIR — a user who relocated their Claude Code config
// must not see every directory reported as having nothing registered.
const claudeConfigFile = (): string => path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || homedir(), ".claude.json");

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    // Absent, unreadable or half-written (Claude Code rewrites this file live). Nothing
    // registered is the honest answer, and it is also the safe one: the switch renders OFF, and
    // turning it on re-registers rather than removing anything.
    return null;
  }
}

// `mcpServers` is a JSON object keyed by server id. Read with Object.keys on an own-property
// check rather than indexed lookups, so a key like `constructor` in the user's file cannot
// resolve through Object.prototype (same reason common/toolGroups.ts uses a Map).
const serverIdsIn = (value: unknown): string[] => (isRecord(value) ? Object.keys(value) : []);

const ownProp = (obj: unknown, key: string): unknown => (isRecord(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);

// `perDir`'s keys are directory paths, and on Windows they never match a plain `ownProp` lookup:
// `claude mcp add -s local` writes the project key with forward slashes regardless of the cwd's
// own separator style (confirmed empirically — see issue #8), while `canonicalDir()` resolves to
// backslash-separated paths. An exact-string lookup against a backslash `cwd` therefore never
// finds a registration the CLI itself just wrote.
//
// Only loosened on win32, not everywhere: backslash is a legal character inside a POSIX path
// component (an unusual directory name, but a real one), so folding it to `/` on POSIX would risk
// matching two genuinely different directories. Windows forbids `\` in a path component (it IS the
// separator there), so the fold is exact — never a coincidence — on the one platform that needs it.
const normalizeSeparators = (p: string): string => p.replace(/\\/g, "/");

function projectEntry(perDir: unknown, dir: string, platform: NodeJS.Platform = process.platform): unknown {
  if (!isRecord(perDir)) return undefined;
  if (platform !== "win32") return ownProp(perDir, dir);
  const target = normalizeSeparators(dir);
  for (const key of Object.keys(perDir)) {
    if (normalizeSeparators(key) === target) return perDir[key];
  }
  return undefined;
}

// The servers a scope holds. Every scope spells them the same way — `{ mcpServers: { <id>: … } }`
// — a per-directory entry under `projects` included.
const scopeServerIds = (scope: unknown): string[] => serverIdsIn(ownProp(scope, "mcpServers"));

// Every `.mcp.json` a session started in these directories would pick up.
//
// Project scope is NOT `<cwd>/.mcp.json` alone: Claude Code walks UP from its working directory
// and takes every one it finds on the way. Measured against the real CLI — a file two levels up
// is listed, one ABOVE the enclosing git root is listed (so this is a directory walk, not a repo
// lookup), and a nearer file does not shadow a farther one, they merge. A cell launched in
// `/repo/packages/app` therefore receives what `/repo/.mcp.json` registers, and reading only the
// leaf reported the Canvas switch as off on a directory that has it.
//
// Both spellings of the directory, for the symlink reason above: Claude walks from its resolved
// cwd, whose ancestors can differ from the lexical ones. Deduped, so the usual case (they are the
// same path) reads each file once.
function projectMcpFiles(...dirs: readonly string[]): string[] {
  const files = new Set<string>();
  for (const dir of dirs) {
    for (let current = dir, parent = path.dirname(current); ; current = parent, parent = path.dirname(current)) {
      files.add(path.join(current, ".mcp.json"));
      if (parent === current) break; // reached the filesystem root
    }
  }
  return [...files];
}

// Which groups this directory has registered. Read from Claude Code's config FILES, not from
// `claude mcp list`: that command health-checks every registered server before it prints, which
// costs seconds of network round-trips (more when one of the user's servers is down) — and the
// launcher runs this every time it opens, so the Canvas switch appeared late and moved the rows
// under it. The files are the same source `claude mcp list` reads, minus the probing, so the
// answer still follows a registration the user made with the CLI behind our back.
//
// All three scopes, because that is what the CLI shows and what the session will actually get:
// local (ours, keyed by directory), project (every `.mcp.json` up the tree), user (global).
const realpathOr = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return p; // gone, or not reachable — the lexical spelling is the best answer left
  }
};

// `platform` defaults to the real one and exists for the same reason path-within.ts's
// `canonicalDir`/`isSamePath` take it: a test pinning POSIX-specific behavior needs to do so on
// every OS the suite runs on, not just when it happens to execute on Linux/macOS.
export async function registeredGuiMcpGroups(cwd: string, groups: readonly ToolGroup[], platform: NodeJS.Platform = process.platform): Promise<ToolGroup[]> {
  // Claude Code keys local scope by its OWN process.cwd(), which the OS resolves symlinks in,
  // while the path we are asked about is canonicalized only lexically (see existingWorkspace).
  // Both spellings are looked up so a directory reached through a symlink still matches.
  // realpathSync.NATIVE: fs/promises has no native variant, and on Windows the JS implementation
  // leaves an 8.3 short component alone (C:\Users\RUNNER~1) where the native one expands it
  // (…\runneradmin). Comparing the two spellings never matches. One stat on a path already in
  // the page cache — the async form bought nothing here. Same call as git/worktrees.ts.
  const real = realpathOr(cwd);
  const projectFiles = projectMcpFiles(cwd, real);
  const [config, ...projects] = await Promise.all([claudeConfigFile(), ...projectFiles].map(readJsonObject));
  const perDir = ownProp(config, "projects");
  const ids = new Set([
    ...scopeServerIds(config),
    ...scopeServerIds(projectEntry(perDir, cwd, platform)),
    ...(real === cwd ? [] : scopeServerIds(projectEntry(perDir, real, platform))),
    ...projects.flatMap(scopeServerIds),
  ]);
  return groups.filter((group) => ids.has(toolGroupServerId(group)));
}
