// @vitest-environment node
//
// WHAT A HEADLESS RUN DOES WITH A CONFIRMATION, tested without a browser.
//
// Its own file, and the reason is a change in what the browser can prove. Writing is gated on the
// runtime marking a submission as caused by a click (`GESTURE_MARK`), and the published runtime
// does not set that mark yet — so in a real browser NOTHING is written, and every assertion about
// the write path would be an assertion about the gate refusing. The gate has its own test next
// door, in `headlessPreview.spec.ts`, where a real page is really pressed.
//
// What is left to check is the decision and what follows it: who is asked, in what order, what is
// undone, and what is reported when each of those goes wrong. None of that needs Chrome — it needs
// a `Driver` that answers, which is an interface.
import { describe, expect, it } from "vitest";
import { answerPress, type Driver, type PreviewWriter } from "../../../server/backends/sharedApp/headlessPreview.js";

/** Everything `answerPress` and `acceptOne` touch, and nothing else.
 *
 *  Cast once, here, rather than implementing the whole `Driver`: the rest of it is the browser, and
 *  a stub that pretended to have it would invite a test to use it. What the answers were is
 *  recorded, because "the page was told the truth" is half of what accepting is for. */
function stubDriver(): { driver: Driver; answers: ({ ok: boolean; error?: string } | "declined")[] } {
  const answers: ({ ok: boolean; error?: string } | "declined")[] = [];
  const driver = {
    accept: async (answer: { ok: boolean; error?: string }) => {
      answers.push(answer);
    },
    decline: async () => {
      answers.push("declined");
    },
  } as unknown as Driver;
  return { driver, answers };
}

const budgetOf = (writer: PreviewWriter | null, left = 4) => ({ writer, left, skipped: 0, outstanding: new Set<string>() });

const submitted = { cid: "orders", fields: ["name"] };
const caused = { cid: "orders", values: { name: "x" }, clickCaused: true };
const uncaused = { cid: "orders", values: { name: "x" }, clickCaused: false };

/** A writer that records what it was asked and answers however the test says. */
function spyWriter(over: Partial<PreviewWriter> = {}): { writer: PreviewWriter; wrote: { cid: string; values: Record<string, string> }[]; undone: string[] } {
  const wrote: { cid: string; values: Record<string, string> }[] = [];
  const undone: string[] = [];
  const writer: PreviewWriter = {
    write: async (cid, values) => {
      wrote.push({ cid, values });
      return { ok: true, token: `t${wrote.length}` };
    },
    undo: async (token) => {
      undone.push(token);
      return { ok: true };
    },
    ...over,
  };
  return { writer, wrote, undone };
}

describe("answering a confirmation", () => {
  it("writes the submission and takes the record straight back", async () => {
    // Straight back, and not at the end of the run: every press mounts a fresh page, so a record
    // left standing is in the way of the next press — and an app keyed by `auth.uid` would then
    // refuse its second button with a rules error that is entirely our own doing.
    const { driver, answers } = stubDriver();
    const { writer, wrote, undone } = spyWriter();
    const answered = await answerPress(driver, budgetOf(writer), { submitted, pending: caused });
    expect(wrote).toEqual([{ cid: "orders", values: { name: "x" } }]);
    expect(undone).toEqual(["t1"]);
    expect(answered.write).toEqual({ cid: "orders", ok: true, error: "", reason: "rules", cleanup: "removed", cleanupError: "" });
    // AND THE PAGE WAS TOLD, which is the reason to accept rather than decline: its own
    // post-submit branch is code an author wrote and nobody has run.
    expect(answers).toEqual([{ ok: true }]);
  });

  it("hands the page the database's own refusal, and undoes nothing", async () => {
    // A refused write has no record and no token. Undoing anyway would be a delete aimed at
    // nothing — harmless in a test, one request per refused press in production.
    const { driver, answers } = stubDriver();
    const { writer, undone } = spyWriter({ write: async () => ({ ok: false, error: "the window for slots/1 is closed", reason: "rules" }) });
    const answered = await answerPress(driver, budgetOf(writer), { submitted, pending: caused });
    expect(undone).toEqual([]);
    expect(answered.write).toMatchObject({ ok: false, reason: "rules", error: "the window for slots/1 is closed", cleanup: "not-written" });
    expect(answers).toEqual([{ ok: false, error: "the window for slots/1 is closed" }]);
  });

  it("keeps the author's own id collision apart from a rules refusal", async () => {
    // `already-taken` under `idFrom: "auth.uid"` is the AUTHOR's record and says nothing about a
    // visitor, who has a different uid. Reported as the rules refusing, it is simply false.
    const { driver } = stubDriver();
    const { writer } = spyWriter({ write: async () => ({ ok: false, error: "already-taken", reason: "taken" }) });
    const answered = await answerPress(driver, budgetOf(writer), { submitted, pending: caused });
    expect(answered.write).toMatchObject({ ok: false, reason: "taken" });
  });

  it("says a record it could not remove is still standing", async () => {
    // The one outcome that costs somebody else something: a booking left in place occupies a real
    // slot. Silence here reads as "removed".
    const { driver } = stubDriver();
    const { writer } = spyWriter({ undo: async () => ({ ok: false, error: "not-this-session" }) });
    const answered = await answerPress(driver, budgetOf(writer), { submitted, pending: caused });
    expect(answered.write).toMatchObject({ ok: true, cleanup: "left", cleanupError: "not-this-session" });
  });

  it("counts a record whose undo was ATTEMPTED as no longer the sweep's business", async () => {
    // Attempted and failed is reported on the press that made it. The end-of-run sweep re-trying it
    // would contradict that line — in the direction that makes the report the wrong one.
    const { driver } = stubDriver();
    const budget = budgetOf(spyWriter({ undo: async () => ({ ok: false, error: "gone" }) }).writer);
    await answerPress(driver, budget, { submitted, pending: caused });
    expect([...budget.outstanding]).toEqual([]);
  });

  it("declines when the budget is spent, and says that is what happened", async () => {
    // A silent cap reads as "everything was covered", and a declined confirmation is a different
    // finding from a button that never submitted.
    const { driver, answers } = stubDriver();
    const { writer, wrote } = spyWriter();
    const budget = budgetOf(writer, 0);
    const answered = await answerPress(driver, budget, { submitted, pending: caused });
    expect(wrote).toEqual([]);
    expect(budget.skipped).toBe(1);
    expect(answered.skipped).toBe(true);
    expect(answered.withheld).toBe(false);
    expect(answers).toEqual(["declined"]);
  });

  it("WRITES NOTHING when the runtime did not mark the submission as click-caused", async () => {
    // The gate. Nothing establishes that this control caused this submission — a page can submit
    // from a timer, from `onState`, from a promise settling — and a record in a real app needs a
    // better reason than "it turned up while I was clicking".
    const { driver, answers } = stubDriver();
    const { writer, wrote } = spyWriter();
    const answered = await answerPress(driver, budgetOf(writer), { submitted, pending: uncaused });
    expect(wrote).toEqual([]);
    expect(answered.write).toBeNull();
    expect(answered.withheld).toBe(true);
    // Withheld is NOT skipped: one is a budget this run spent, the other is a cause it never had.
    expect(answered.skipped).toBe(false);
    expect(answers).toEqual(["declined"]);
  });

  it("does not call a press withheld when the run had no writer at all", async () => {
    // Every test run, and any caller that asks for none. "We had no way to write" and "we would
    // not write this one" are different sentences in the report.
    const { driver } = stubDriver();
    const answered = await answerPress(driver, budgetOf(null), { submitted, pending: caused });
    expect(answered.write).toBeNull();
    expect(answered.withheld).toBe(false);
  });

  it("declines a press that raised no confirmation, and reports it as neither", async () => {
    // A dead button. It must not read as a budget this run spent, nor as a cause it doubted.
    const { driver, answers } = stubDriver();
    const { writer } = spyWriter();
    const answered = await answerPress(driver, budgetOf(writer), { submitted: null, pending: null });
    expect(answered).toEqual({ write: null, skipped: false, withheld: false });
    expect(answers).toEqual(["declined"]);
  });

  it("does not let a writer that throws take the run down", async () => {
    // The caller is a tool call whose contract is prose. A rejected promise here would be an
    // exception where the author expected a report.
    const { driver } = stubDriver();
    const { writer } = spyWriter({
      write: () => Promise.reject(new Error("the connection went away")),
    });
    const answered = await answerPress(driver, budgetOf(writer), { submitted, pending: caused });
    expect(answered.write).toMatchObject({ ok: false, reason: "host", error: "the connection went away" });
  });
});
