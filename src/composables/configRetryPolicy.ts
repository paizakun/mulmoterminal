// How long to wait before trying `/api/config` again, and when to stop trying.
//
// A separate module for the same reason as `reconnectPolicy`: the numbers are a decision with
// consequences the composable's own tests can't reach — too few attempts and the launcher stays
// empty, an unbounded loop polls a server that is genuinely gone for the life of the tab.
//
// WHAT IS BEING WAITED OUT is a backend that is restarting while the page keeps working. In
// development that is not an edge case: Vite serves the page on its own port and proxies `/api`
// to Express, so every save under `server/` (which `scripts/dev-server.mjs` answers with a full
// backend restart) leaves a window of seconds where the page is fine and `/api/config` is a 502
// from the proxy. Without a retry the tab that loaded in that window shows no saved directories
// at all, for as long as it stays open, with nothing on screen saying why.
//
// The schedule is 500ms doubling to a 5s ceiling, over 9 attempts — about 32 seconds of trying.
// The shape matches `reconnectDelayMs` (the terminal sockets are waiting out the same restart,
// and two different rhythms for one event would be noise); the ATTEMPT CAP is this module's own,
// because a terminal socket reconnects forever by design while a config read is a one-shot the
// user can always redo by reloading. 32s covers a `tsx` boot and the supervisor's 4s crash
// backoff with room to spare; past that the server is down rather than restarting.
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5000;
const MAX_ATTEMPTS = 9;

/**
 * How long to wait before retry number `attempt` (0 = the first retry after the initial failure),
 * or `null` when the config load should be given up on.
 */
export function configRetryDelayMs(attempt: number): number | null {
  if (attempt < 0 || attempt >= MAX_ATTEMPTS) return null;
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
}
