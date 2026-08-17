import { describe, it, expect } from "vitest";
import { configRetryDelayMs } from "../../../src/composables/configRetryPolicy";

// The schedule is the whole module, so it is pinned here rather than implied by a composable test
// that would go green with one attempt or a hundred.
describe("configRetryDelayMs", () => {
  it("doubles from 500ms and settles at the 5s ceiling", () => {
    expect([0, 1, 2, 3, 4, 5].map(configRetryDelayMs)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });

  it("gives up rather than retrying forever", () => {
    expect(configRetryDelayMs(8)).not.toBeNull();
    expect(configRetryDelayMs(9)).toBeNull();
    expect(configRetryDelayMs(99)).toBeNull();
  });

  // The window being waited out is a backend restart: `scripts/dev-server.mjs` kills the child,
  // waits out its backoff (up to 4s) and boots tsx again. A schedule that expired inside that
  // window would leave the launcher empty exactly when it is most likely to be.
  it("keeps trying for long enough to outlast a backend restart", () => {
    let total = 0;
    for (let attempt = 0; ; attempt++) {
      const delay = configRetryDelayMs(attempt);
      if (delay === null) break;
      total += delay;
    }
    expect(total).toBeGreaterThanOrEqual(30_000);
  });

  it("has no delay for a negative attempt", () => {
    expect(configRetryDelayMs(-1)).toBeNull();
  });
});
