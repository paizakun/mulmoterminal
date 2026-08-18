// Host tool: clearSession. Writes a minutes record to disk, then types "/clear" into the
// CALLING session's own pty, the same way a human would — see
// server/session/draft-injection.ts for the write() pattern this mirrors. Needs server
// internals (the live PTY table), so it lives here rather than in a plugin module, same
// reasoning as spawnBackgroundChat above.
//
// `title` and `minutes` are REQUIRED, not a convention left to the calling agent: a clear
// with nothing worth keeping written down is exactly the failure mode this tool exists to
// prevent, so the schema itself refuses a call that skips it rather than trusting an
// instruction the model can forget under context pressure.
//
// No confirmation step of its own: the model is expected to have already gotten the user's
// explicit yes (e.g. via a real AskUserQuestion) before calling this — /clear is not
// reversible. Deliberately not added to NEVER_AUTO_APPROVED_TOOLS (common/toolGroups.ts): the
// AskUserQuestion step upstream is the agreed safety gate, not a second permission prompt on
// top of it.
import type { ToolDefinition } from "gui-chat-protocol";

export const CLEAR_SESSION: ToolDefinition = {
  type: "function",
  name: "clearSession",
  description:
    "Clear this session's conversation, the same as the user typing /clear. IRREVERSIBLE. " +
    "Only call this after the user has explicitly agreed (e.g. you asked via AskUserQuestion). " +
    "Before clearing, this tool writes `title` and `minutes` to a per-project log on disk " +
    "(browsable later by title, without loading the full record) — nothing said in this " +
    "conversation is recoverable afterwards except what you put in `minutes`.",
  prompt:
    "Keep `minutes` as short as it can be while still being useful later — decisions made, options rejected and why, " +
    "unresolved questions, interfaces/files touched. Not a transcript: aim for what you'd want a future session to " +
    "read in a few seconds, comparable in length to a /compact summary, not longer.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "A short, specific title for this record — this is what shows up in the browsable index, so make it findable later.",
      },
      minutes: {
        type: "string",
        description:
          "The record to keep: implementation decisions and why, options considered and rejected, unresolved questions, " +
          "interfaces/libraries used. Markdown. Keep it concise — see the tool's `prompt`.",
      },
    },
    required: ["title", "minutes"],
  },
};
