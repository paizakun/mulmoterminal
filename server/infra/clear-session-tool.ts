// Host tool: clearSession. Types "/clear" into the CALLING session's own pty, the same way a
// human would — see server/session/draft-injection.ts for the write() pattern this mirrors.
// Needs server internals (the live PTY table), so it lives here rather than in a plugin module,
// same reasoning as spawnBackgroundChat above.
//
// No confirmation step of its own: the model is expected to have already gotten the user's
// explicit yes (e.g. via a real AskUserQuestion) and written any context worth keeping to disk
// before calling this — /clear is not reversible. Deliberately not added to
// NEVER_AUTO_APPROVED_TOOLS (common/toolGroups.ts): the AskUserQuestion step upstream is the
// agreed safety gate, not a second permission prompt on top of it.
import type { ToolDefinition } from "gui-chat-protocol";

export const CLEAR_SESSION: ToolDefinition = {
  type: "function",
  name: "clearSession",
  description:
    "Clear this session's conversation, the same as the user typing /clear. IRREVERSIBLE. " +
    "Only call this after the user has explicitly agreed (e.g. you asked via AskUserQuestion) " +
    "AND you have already written anything worth keeping to a file — nothing said in this " +
    "conversation is recoverable afterwards.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};
