// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTempDir } from "../../support/tempDir.js";
import { rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";

import { guiMcpUrlTemplate, registeredGuiMcpGroups } from "../../../server/infra/gui-mcp-registration.js";
import { TOOL_GROUPS } from "../../../common/toolGroups.js";

// The url is registered ONCE, into the user's own Claude Code config, and then read at every
// connect. It has to stay a template: the port and session id are only known per spawn, and
// Claude Code is what expands them (verified against the real CLI).
describe("guiMcpUrlTemplate", () => {
  it("leaves the port and session id as ${VAR} for Claude Code to expand", () => {
    expect(guiMcpUrlTemplate("render")).toBe("http://127.0.0.1:${MULMOTERMINAL_PORT}/api/mcp/render/${MULMOTERMINAL_SESSION_ID}");
  });

  it("puts the group in the path, so one server id maps to one group", () => {
    expect(guiMcpUrlTemplate("data")).toContain("/api/mcp/data/");
    expect(guiMcpUrlTemplate("external")).toContain("/api/mcp/external/");
  });

  // 127.0.0.1 rather than localhost, for the same reason mcp-config.ts uses it: an IPv6/IPv4
  // resolution mismatch against the server's listen address.
  it("addresses the loopback numerically", () => {
    expect(guiMcpUrlTemplate("render").startsWith("http://127.0.0.1:")).toBe(true);
  });
});

// Read from the config FILES, never by running `claude mcp list` — that command health-checks
// every registered server first, and the launcher was paying that wait before it could draw the
// Canvas switch.
describe("registeredGuiMcpGroups", () => {
  let root = "";
  let home = "";
  let cwd = "";
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;

  const writeClaudeConfig = (value: unknown) => writeFileSync(path.join(home, ".claude.json"), JSON.stringify(value));

  beforeEach(() => {
    // realpath'd: on macOS the temp dir is itself behind a symlink (/var -> /private/var), which
    // would make every path in here exercise the symlink case by accident.
    // realpathSync.NATIVE, like the production code: on Windows the JS implementation leaves an
    // 8.3 short component alone (C:\Users\RUNNER~1) while the native one expands it
    // (…\runneradmin), so a fixture built with the JS version is spelled differently from what
    // the code under test resolves, and the comparison fails for a reason that has nothing to do
    // with symlinks. On macOS both expand /var -> /private/var, which is why this was already
    // realpath'd at all.
    root = makeTempDir("gui-mcp-");
    home = path.join(root, "home");
    cwd = path.join(root, "repo");
    mkdirSync(home);
    mkdirSync(cwd);
    process.env.CLAUDE_CONFIG_DIR = home;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("reports the groups registered for this directory in local scope", async () => {
    writeClaudeConfig({ projects: { [cwd]: { mcpServers: { "mulmoterminal-render": { type: "http" } } } } });
    expect(await registeredGuiMcpGroups(cwd, TOOL_GROUPS)).toEqual(["render"]);
  });

  // Local scope is keyed by directory: another project's registration is not this one's.
  it("does not report a group registered for a different directory", async () => {
    writeClaudeConfig({ projects: { [path.join(root, "elsewhere")]: { mcpServers: { "mulmoterminal-render": {} } } } });
    expect(await registeredGuiMcpGroups(cwd, TOOL_GROUPS)).toEqual([]);
  });

  // The three scopes `claude mcp list` merges are the three the session will actually get.
  it("also counts user scope and the repo's .mcp.json", async () => {
    writeClaudeConfig({ mcpServers: { "mulmoterminal-media": {} } });
    writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { "mulmoterminal-data": {} } }));
    expect((await registeredGuiMcpGroups(cwd, TOOL_GROUPS)).sort()).toEqual(["data", "media"]);
  });

  // Project scope is a WALK, not a single file: measured against the real CLI, a cell launched in
  // /repo/packages/app is served by /repo/.mcp.json. Reading only the leaf reported the switch as
  // off on a directory that has it.
  it("finds a .mcp.json in an ancestor directory", async () => {
    const deep = path.join(cwd, "packages", "app");
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { "mulmoterminal-render": {} } }));
    expect(await registeredGuiMcpGroups(deep, TOOL_GROUPS)).toEqual(["render"]);
  });

  // Also measured: a nearer file does not shadow a farther one, they merge — and the walk crosses
  // above a git root, so it is a directory walk rather than a repo lookup.
  it("merges the files up the tree rather than stopping at the nearest", async () => {
    const deep = path.join(cwd, "packages", "app");
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { "mulmoterminal-render": {} } }));
    writeFileSync(path.join(deep, ".mcp.json"), JSON.stringify({ mcpServers: { "mulmoterminal-data": {} } }));
    expect((await registeredGuiMcpGroups(deep, TOOL_GROUPS)).sort()).toEqual(["data", "render"]);
  });

  // `claude mcp add -s local` writes the project key with forward slashes regardless of the
  // cwd's own separator style (confirmed against the real CLI on Windows — see issue #8), while
  // our own cwd is canonicalized to the platform's native separator. On Windows that made an
  // exact-string lookup miss a registration the CLI itself had just written.
  //
  // Pinned to `platform: "win32"` explicitly (rather than relying on whichever OS runs the
  // suite) so this exercises the fix on every CI runner, not just Windows daily.
  it("matches a directory whose project key uses forward slashes, on Windows", async () => {
    const winCwd = "C:\\Users\\me\\repo";
    writeClaudeConfig({ projects: { "C:/Users/me/repo": { mcpServers: { "mulmoterminal-render": {} } } } });
    expect(await registeredGuiMcpGroups(winCwd, TOOL_GROUPS, "win32")).toEqual(["render"]);
  });

  // Separators are not the only axis a CLI-written key can differ on: Windows filesystems are
  // case-insensitive, so `claude mcp add -s local` (or a user who typed a preset differently) can
  // end up with a project key whose casing doesn't match ours, reproducing the identical "silently
  // never registered" symptom through a different mismatch — the exact gap `isSamePath` already
  // closes for other callers (`#802`). Confirms this path reuses it rather than a narrower
  // separator-only fold that would leave this case unmatched.
  it("matches a directory whose project key differs only in case, on Windows", async () => {
    const winCwd = "C:\\Users\\Me\\Repo";
    writeClaudeConfig({ projects: { "c:/users/me/repo": { mcpServers: { "mulmoterminal-render": {} } } } });
    expect(await registeredGuiMcpGroups(winCwd, TOOL_GROUPS, "win32")).toEqual(["render"]);
  });

  // The leniency is Windows-only on purpose: `\` is a legal character inside a POSIX directory
  // name (unusual, but real), and POSIX filesystems are commonly case-sensitive, so folding either
  // axis there would risk matching two genuinely different directories. A registration for a
  // directory whose actual name happens to contain a literal backslash, or differs only in case,
  // must not be handed to a directory whose name merely looks similar.
  //
  // Built from string literals, not `path.join`/`root`: on a host whose OWN path module treats
  // `\` as a separator, joining would silently turn the literal backslash into a real one and
  // this test would pass for the wrong reason. `isSamePath`'s POSIX arm resolves with
  // `path.posix`, which never treats `\` as a separator, so a literal (non-real, non-existent)
  // path exercises it identically on every host OS.
  it("does not fold separators or case on POSIX", async () => {
    const dirWithLiteralBackslash = "/repos/foo\\bar"; // one segment named "foo\bar", not "foo/bar"
    writeClaudeConfig({
      projects: {
        "/repos/foo/bar": { mcpServers: { "mulmoterminal-render": {} } },
        "/Repos/Foo/Bar": { mcpServers: { "mulmoterminal-data": {} } },
      },
    });
    expect(await registeredGuiMcpGroups(dirWithLiteralBackslash, TOOL_GROUPS, "linux")).toEqual([]);
    expect(await registeredGuiMcpGroups("/repos/foo/bar", TOOL_GROUPS, "linux")).toEqual(["render"]);
  });

  // Claude Code keys local scope by its own resolved cwd; ours is canonicalized only lexically.
  it("matches a directory reached through a symlink", async () => {
    const link = path.join(root, "link");
    symlinkSync(cwd, link);
    writeClaudeConfig({ projects: { [cwd]: { mcpServers: { "mulmoterminal-render": {} } } } });
    expect(await registeredGuiMcpGroups(link, TOOL_GROUPS)).toEqual(["render"]);
  });

  // The file is rewritten live by Claude Code, so a read can land mid-write.
  it("reads a missing or unparsable config as nothing registered", async () => {
    expect(await registeredGuiMcpGroups(cwd, TOOL_GROUPS)).toEqual([]);
    writeFileSync(path.join(home, ".claude.json"), "{ half-writ");
    expect(await registeredGuiMcpGroups(cwd, TOOL_GROUPS)).toEqual([]);
  });

  // An indexed lookup would resolve these through Object.prototype and report a group that the
  // user never registered.
  it("does not read inherited object members as registrations", async () => {
    writeClaudeConfig({ projects: { [cwd]: { mcpServers: { constructor: {}, toString: {} } } } });
    expect(await registeredGuiMcpGroups(cwd, TOOL_GROUPS)).toEqual([]);
  });
});
