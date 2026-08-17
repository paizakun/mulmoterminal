// @vitest-environment node
//
// THE CONTRACT TEST, in a real browser, and there is exactly one of it.
//
// The plan requires it and names the reason (`plans/feat-shared-app-preview.md`, section 7): jsdom
// reproduces NEITHER of the two failures this feature exists to catch. There is no sandbox, so
// `allow-forms` cannot be absent from it; there is no meaningful `MessagePort` lifetime, so a
// handshake answered by a document that no longer exists is not modelled. A suite that checked
// this against jsdom would pass while both bugs shipped — which is what happened, in a real app,
// twice in ten minutes.
//
// So this one test drives Chrome, and it drives it with the pages from that incident:
//
//   the page that WORKS  — `ready()` outside `onState`, a `<div>` and a `type="button"` button.
//   the page that SHIPPED — a `<form>`, and `ready()` inside the `onState` callback.
//   plus one whose controls no cursor can reach, because a press has to be a real press.
//
// It is skipped, loudly, when no browser is installed. Skipping is right and failing is not: a
// browser is an optional dependency of this server (see `browserOrProblem`), and a machine without
// one gets a headless preview that says so rather than a suite that goes red.
import { beforeAll, describe, expect, it } from "vitest";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LIMITS, runPagesHeadless, type HeadlessPageInput, type HeadlessPageReport } from "../../../server/backends/sharedApp/headlessPreview.js";

/** Whether Chrome is on this machine, asked by STARTING one and closing it again.
 *
 *  Not by checking `executablePath()`: that answered "no" on a machine where the launch then
 *  succeeded — puppeteer resolves a browser from its cache directory and from the environment, and
 *  a path check knows about neither. The probe has to be the thing itself.
 *
 *  At module scope on purpose. Collection has no per-test budget, so the launch is billed to
 *  nobody; inside an `it` it would be charged against `testTimeout` (CLAUDE.md). */
const chromeReady: boolean = await (async () => {
  try {
    const puppeteer = (await import("puppeteer")).default;
    await (await puppeteer.launch({ headless: true })).close();
    return true;
  } catch {
    return false;
  }
})();

const datasets = { menu: [{ title: "Curry" }, { title: "Ramen" }] };
const submit = { orders: { createFields: ["name"] } };

/** What a working page looks like, and every line of it is load-bearing.
 *
 *  The file input is here deliberately: a browser refuses a non-empty value on one, and the throw
 *  used to take the whole run with it — an app with an upload control reported nothing at all. */
/** A page that must leave NO record behind, checked for the reason it leaves none.
 *
 *  The three that must not write are not variations on one idea, and collapsing them to "nothing
 *  was written" would lose what each is guarding:
 *
 *  - `onload` / `resubmits` submit BEFORE the press. The run clears that confirmation, so the press
 *    itself raises nothing: `pressSubmitted` false and `withheld` FALSE, because there was no
 *    submission to withhold. What they did is reported as `submittedOnLoad`, which is also the
 *    finding a visitor would care about — they are shown a dialog nobody asked for.
 *  - `timer` submits DURING the press. The press really does see a submission arrive, which is the
 *    exact shape that made every counting-based design write a record for a button that does
 *    nothing. It is refused on the only ground that is not a guess: the runtime did not mark it.
 *
 *  Its own function because the assertions are the same three lines with different answers, and
 *  because inlining all four pages put the test over the complexity limit. */
function expectNoRecord(pages: HeadlessPageReport[], id: string, want: { submittedOnLoad: number; pressSubmitted: boolean; withheld: boolean }): void {
  const page = pages.find((pg) => pg.id === id);
  expect(page, id).toBeDefined();
  expect(page?.submittedOnLoad, id).toBe(want.submittedOnLoad);
  expect(page?.presses[0]?.submitted !== null, id).toBe(want.pressSubmitted);
  expect(page?.presses[0]?.writeWithheld, id).toBe(want.withheld);
  expect(page?.presses[0]?.write, id).toBeNull();
}

const WORKS = `
<div id="menu">loading…</div>
<input id="name">
<input type="file" id="receipt">
<button type="button" id="go">Order</button>
<script>
  const view = window.__MC_APP_VIEW;
  view.onState((collections) => {
    document.getElementById("menu").textContent = (collections.menu || []).map((row) => row.title).join(", ");
  });
  document.getElementById("go").addEventListener("click", () => {
    view.submit("orders", { name: document.getElementById("name").value });
  });
  view.ready();
</script>`;

/** What was published, twice, with nobody having pressed the button. */
const SHIPPED = `
<div id="menu">loading…</div>
<form id="f">
  <input name="name">
  <button type="submit">Order</button>
</form>
<script>
  const view = window.__MC_APP_VIEW;
  view.onState((collections) => {
    document.getElementById("menu").textContent = "drawn";
    view.ready();
  });
  document.getElementById("f").addEventListener("submit", (event) => {
    event.preventDefault();
    view.submit("orders", { name: "x" });
  });
</script>`;

/** Two controls a visitor's cursor can never arrive at, and they fail differently.
 *
 *  `element.click()` in the page's own realm would fire BOTH handlers and report the page as
 *  submitting twice. A press through the browser, at real coordinates, gets what a person gets:
 *  the overlay swallows the first, and the second has no box to aim at. */
const UNREACHABLE = `
<div style="position:relative">
  <button type="button" id="go">Order</button>
  <div style="position:absolute;inset:0;background:#fff"></div>
</div>
<button type="button" id="hidden" style="display:none">Hidden</button>
<script>
  const view = window.__MC_APP_VIEW;
  const send = () => view.submit("orders", { name: "x" });
  document.getElementById("go").addEventListener("click", send);
  document.getElementById("hidden").addEventListener("click", send);
  view.onState(() => {});
  view.ready();
</script>`;

/** A page that submits the moment it loads, with a button that does nothing.
 *
 *  Measured from the mount rather than from the press, the automatic submission is attributed to
 *  whichever control is under test — so every button on a page like this looks correctly wired. */
const SUBMITS_ON_LOAD = `
<button type="button" id="go">Order</button>
<script>
  const view = window.__MC_APP_VIEW;
  view.onState(() => {});
  view.ready();
  view.submit("orders", { name: "nobody asked" });
</script>`;

/** A page that submits on load AND submits again the moment its confirmation is answered.
 *
 *  "That didn't work, try once more" — a handler that costs nothing to write. It is the page that
 *  breaks a run which clears the pending confirmation and then measures the press from what it saw
 *  BEFORE clearing: the resubmission lands in between, so the inert button below is credited with
 *  it and a real record is written for a control nobody pressed. */
const RESUBMITS_ON_DECLINE = `
<button type="button" id="go">Order</button>
<script>
  const view = window.__MC_APP_VIEW;
  view.onState(() => {});
  view.ready();
  const again = () => { view.submit("orders", { name: "again" }); };
  // Both branches, because what a declined confirmation does to the promise is the parent's
  // business and this page is written by somebody who does not know or care which it is.
  view.submit("orders", { name: "nobody asked" }).then(again, again);
</script>`;

/** A page whose button does nothing and which submits from a TIMER, long after it loaded.
 *
 *  Nothing is pending when the press happens and nothing was pending at the mount, so every
 *  counting-based defence sees a submission appear "because of" the click. It did not. This is the
 *  page that decides whether the run writes on a guess. */
const SUBMITS_ON_A_TIMER = `
<button type="button" id="go">Order</button>
<script>
  const view = window.__MC_APP_VIEW;
  view.onState(() => {});
  view.ready();
  setTimeout(() => { view.submit("orders", { name: "a timer did this" }); }, 800);
</script>`;

/** A page that rearranges its own controls when an input is filled.
 *
 *  Ordinary reactive behaviour, and it moves the ground under a survey taken before the filling:
 *  the control at index 0 was "Order" and is now "Clear". Named from the stale survey, this run
 *  would report "Order" as a dead button while having pressed something else entirely. */
const REORDERS = `
<input id="name">
<button type="button" id="go">Order</button>
<script>
  const view = window.__MC_APP_VIEW;
  view.onState(() => {});
  view.ready();
  document.getElementById("name").addEventListener("input", () => {
    if (document.getElementById("clear") !== null) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "clear";
    button.textContent = "Clear";
    document.body.insertBefore(button, document.body.firstChild);
  });
  document.getElementById("go").addEventListener("click", () => view.submit("orders", { name: "x" }));
</script>`;

/** A page with NO control until a box is ticked, revealed from an `input` handler.
 *
 *  Ordinary consent-then-submit. Surveyed before anything is filled in, it has nothing to press
 *  and would be reported as a page with no controls at all. */
const REVEALS = `
<input type="checkbox" id="agree">
<div id="slot"></div>
<script>
  const view = window.__MC_APP_VIEW;
  view.onState(() => {});
  view.ready();
  document.getElementById("agree").addEventListener("input", () => {
    document.getElementById("slot").innerHTML = '<button type="button" id="go">Order</button>';
    document.getElementById("go").addEventListener("click", () => view.submit("orders", { name: "x" }));
  });
</script>`;

/** A page that breaks the QUESTIONS this run puts to it, rather than breaking itself.
 *
 *  A getter of the page's own that throws is the reachable version of it; a frame that navigates
 *  itself out from under the handle is the other, and neither can be arranged deterministically
 *  except this way. Both make `evaluate` REJECT, and a rejection that is swallowed leaves a page
 *  with a button in it reported as a page with no text and no controls — as calmly as an empty
 *  page. */
const POISONED = `
<button type="button" id="go">Order</button>
<script>
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    get() {
      throw new Error("innerText is poisoned");
    },
  });
  window.__MC_APP_VIEW.onState(() => {});
  window.__MC_APP_VIEW.ready();
</script>`;

/** A page that answers everything EXCEPT the question about its screen text.
 *
 *  The hang is aimed by the BUDGET the query asks for (`LIMITS.textChars`), so only that one
 *  question is left outstanding: hang them all and the page has no controls either, and there is
 *  no press left to prove anything about. */
const hangsOnText = (body: string, wires: boolean): string => {
  const close = "</scr" + "ipt>";
  return `${body}<script>
    const slice = String.prototype.slice;
    String.prototype.slice = function (from, to) {
      return to === ${LIMITS.textChars} ? new Promise(() => {}) : slice.call(this, from, to);
    };
    const view = window.__MC_APP_VIEW;
    view.onState(() => {});
    ${wires ? `document.getElementById("go").addEventListener("click", () => view.submit("orders", { name: "x" }));` : ""}
    view.ready();${close}`;
};

const page = (id: string, html: string): HeadlessPageInput => ({ id, audience: "public", html, datasets, submit });

describe.skipIf(!chromeReady)("a headless run, in a real browser", () => {
  // ONE run for the three assertions below. Chrome is started once and the three pages are driven
  // once, because the cost is the browser rather than the checking — and split across three `it`s
  // a failure says which of the three things broke.
  let pages: HeadlessPageReport[] = [];

  beforeAll(async () => {
    const run = await runPagesHeadless([
      page("works", WORKS),
      page("shipped", SHIPPED),
      page("unreachable", UNREACHABLE),
      page("onload", SUBMITS_ON_LOAD),
      page("reorders", REORDERS),
      page("reveals", REVEALS),
    ]);
    if (!run.ok) throw new Error(run.problems.join(" "));
    pages = run.pages;
  }, 240_000);

  it("draws the page that works, and carries its press to the parent", () => {
    // The handshake completed, the records arrived, and the page DREW them — the text on screen is
    // the assertion, because "it rendered" and "it is still on its loading state" are the two
    // states a preview exists to tell apart.
    const works = pages[0];
    expect(works?.readied).toBe(true);
    expect(works?.stateDelivered).toBe(true);
    // AND it was not called unresponsive. The flag is what the report leads with, and it says
    // nothing below it describes the page — so a flag stuck on true does not add a wrong line, it
    // disowns every right one. It was stuck on true: the deadline answered `undefined`, which is
    // also what a healthy `FILL_INPUTS` and a healthy `decline()` return, on every page.
    expect(works?.unresponsive).toBe(false);
    expect(works?.text).toContain("Curry, Ramen");
    expect(works?.liveForms).toBe(0);
    // The press reached the parent as a submission for the declared collection — and was declined,
    // so nothing was written.
    expect(works?.presses[0]?.submitted).toEqual({ cid: "orders", fields: ["name"] });
  });

  it("catches both halves of the page that shipped", () => {
    // `ready()` inside `onState` is a deadlock: the parent sends no state until `ready` arrives, so
    // the callback never runs, so `ready` is never sent. The page sits on "loading…".
    const shipped = pages[1];
    expect(shipped?.readied).toBe(false);
    expect(shipped?.stateDelivered).toBe(false);
    // Deadlocked is not unresponsive. This page answers everything put to it; what it never does
    // is send `ready`, and the report has a different sentence for that.
    expect(shipped?.unresponsive).toBe(false);
    expect(shipped?.text).toContain("loading");
    // And the Submit button does nothing at all: the browser blocks the submission BEFORE the
    // `submit` event fires, so the handler that would have called `view.submit` never runs.
    expect(shipped?.liveForms).toBe(1);
    expect(shipped?.presses[0]?.submitted).toBeNull();
    expect(shipped?.presses[0]?.blockedFormSubmission).toBe(true);
  });

  it("does not credit a control with a submission the page made on its own", () => {
    // The false green: one automatic submission, measured from the mount, makes every button on
    // the page look correctly wired.
    const onload = pages[3];
    expect(onload?.submittedOnLoad).toBeGreaterThan(0);
    expect(onload?.presses[0]?.submitted).toBeNull();
  });

  it("names the control it actually pressed, not the one the survey saw", () => {
    // Filling the inputs fires `input` and `change`, and this page inserts a control in response.
    // The press has to be reported under the name of what is now at that index.
    const reorders = pages[4];
    expect(reorders?.presses[0]?.label).toBe("Clear");
    expect(reorders?.presses[0]?.submitted).toBeNull();
    // And the ORIGINAL control is still pressed. Bounded by the survey — one control — the run
    // would have pressed the newcomer, never pressed "Order", and reported nothing left out.
    expect(reorders?.presses[1]?.label).toBe("Order");
    expect(reorders?.presses[1]?.submitted).toEqual({ cid: "orders", fields: ["name"] });
    expect(reorders?.pressesOmitted).toBe(0);
  });

  it("finds a control that only exists once a box is ticked", () => {
    // A real click on a checkbox fires `input` as well as `change`, and this page listens for the
    // first. Dispatching only `change`, the run surveyed a page with nothing to press.
    const reveals = pages[5];
    expect(reveals?.presses[0]?.label).toBe("Order");
    expect(reveals?.presses[0]?.submitted).toEqual({ cid: "orders", fields: ["name"] });
  });

  it("presses where a person would, so a control no cursor reaches submits nothing", () => {
    // `element.click()` in the page's own realm would have fired both handlers and reported two
    // submissions for buttons nobody can press.
    const unreachable = pages[2];
    expect(unreachable?.presses[0]?.submitted).toBeNull(); // covered — the overlay took the click
    expect(unreachable?.presses[1]?.notClickable).toBe(true); // display:none — no box to aim at
    expect(unreachable?.presses[1]?.submitted).toBeNull();
  });

  it("writes for the pressed button and for NONE of the three pages that submit by themselves", async () => {
    // THE GATE, against four pages that each break a different guess somebody might make about
    // cause: the ordinary one, the one that submits on load, the one that resubmits the moment its
    // confirmation is answered, and the one whose timer fires later. Only the first submits from
    // inside the click's dispatch, so only the first carries the runtime's mark (`GESTURE_MARK`)
    // and only the first is written — with no window and no counting anywhere near it.
    //
    // Against a REAL browser and the REAL published runtime: the harness serves
    // `node_modules/@receptron/sharedapp/dist/view`, so this goes red if a future version stops
    // marking — which is the failure no unit test in this repo can see, because the mark can only
    // be produced by a browser dispatching a real click.
    const wrote: string[] = [];
    const run = await runPagesHeadless(
      [page("works", WORKS), page("onload", SUBMITS_ON_LOAD), page("resubmits", RESUBMITS_ON_DECLINE), page("timer", SUBMITS_ON_A_TIMER)],
      {
        write: async (_cid, values) => {
          wrote.push(values.name ?? "");
          return { ok: true, token: `t${wrote.length}` };
        },
        undo: async () => ({ ok: true }),
      },
    );
    if (!run.ok) throw new Error(run.problems.join(" "));
    // ONE write, and it is the pressed button's — `"preview"` is what the run fills a bare text
    // input with. Asserting the VALUE rather than the count is the point: a run that wrote
    // "a timer did this" instead would also have written exactly once.
    expect(wrote).toEqual(["preview"]);
    expect(run.pages[0]?.presses[0]?.submitted).toEqual({ cid: "orders", fields: ["name"] });
    expect(run.pages[0]?.presses[0]?.writeWithheld).toBe(false);
    expect(run.pages[0]?.presses[0]?.write).toMatchObject({ cid: "orders", ok: true, cleanup: "removed" });
    // The other three are unwritten for two DIFFERENT reasons — see `expectNoRecord`.
    expectNoRecord(run.pages, "onload", { submittedOnLoad: 1, pressSubmitted: false, withheld: false });
    expectNoRecord(run.pages, "resubmits", { submittedOnLoad: 1, pressSubmitted: false, withheld: false });
    expectNoRecord(run.pages, "timer", { submittedOnLoad: 0, pressSubmitted: true, withheld: true });
  }, 240_000);

  it("writes nothing when it is given no writer, which is every run a test drives", async () => {
    // The invariant that keeps every other test in this file honest: the default has to be the
    // behaviour this action had before it could write at all.
    const run = await runPagesHeadless([page("works", WORKS)]);
    if (!run.ok) throw new Error(run.problems.join(" "));
    expect(run.wrote).toBe(false);
    expect(run.pages[0]?.presses[0]?.submitted).toEqual({ cid: "orders", fields: ["name"] });
    expect(run.pages[0]?.presses[0]?.write).toBeNull();
    expect(run.pages[0]?.presses[0]?.writeSkipped).toBe(false);
  }, 120_000);

  it("gives the authored page no way to reach the writer", async () => {
    // THE HOLE `exposeFunction` OPENED. Puppeteer installs a binding in every document of the page,
    // the sandboxed `srcdoc` included — so the one document here that nobody trusts could have
    // called the writer directly, once per line of script, past the budget, the ledger and the undo.
    // The verdict is passed IN now, and this is what pins that.
    //
    // The page REPORTS WHAT IT FOUND onto its own screen rather than the test inferring it from a
    // write that did not happen: with the click mark not yet set by any runtime, nothing is written
    // either way, so "no record appeared" would prove nothing at all.
    const run = await runPagesHeadless([
      page(
        "greedy",
        `
<div id="menu">loading…</div>
<button type="button" id="go">Order</button>
<script>
  const view = window.__MC_APP_VIEW;
  view.onState(() => {
    document.getElementById("menu").textContent = typeof window.__previewWrite === "function" ? "WRITER REACHABLE" : "no writer here";
  });
  view.ready();
</script>`,
      ),
    ]);
    if (!run.ok) throw new Error(run.problems.join(" "));
    expect(run.pages[0]?.text).toContain("no writer here");
    expect(run.pages[0]?.text).not.toContain("WRITER REACHABLE");
  }, 120_000);

  it("photographs each page, and names where the picture went", async () => {
    // The pane's last advantage handed over: a person looking at the screen. The file has to
    // EXIST — a path in a report that opens nothing is worse than no path.
    const run = await runPagesHeadless([page("works", WORKS)]);
    if (!run.ok) throw new Error(run.problems.join(" "));
    const shot = run.pages[0]?.screenshot;
    expect(shot).not.toBeNull();
    expect(run.pages[0]?.screenshotError).toBe("");
    expect((await stat(shot ?? "")).size).toBeGreaterThan(0);
    // Outside the repository, because a preview must leave nothing for a commit to pick up.
    expect(shot?.startsWith(tmpdir())).toBe(true);
  }, 120_000);
});

describe.skipIf(!chromeReady)("a document that breaks the questions put to it", () => {
  // Its own run rather than a seventh page in the shared one: `LIMITS.pages` is 6, and a seventh
  // is dropped — reported, but dropped, so the assertions below would have read `undefined`.
  it("says a question could not be put, rather than reporting an empty page", async () => {
    const run = await runPagesHeadless([page("poisoned", POISONED)]);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const poisoned = run.pages[0];
    // The page is fine — it drew, and it answered the handshake. What it broke is our question,
    // and `evaluate` rejects: the survey then finds no control and the screen reads as empty.
    // Every one of those is an ordinary, calm-looking value, which is why the rejection has to be
    // said out loud instead.
    expect(poisoned?.readied).toBe(true);
    expect(poisoned?.errors.some((line) => line.includes("could not put a question"))).toBe(true);
    // And it is not called unresponsive: the page answered everything it could, and the flag above
    // it says something else.
    expect(poisoned?.unresponsive).toBe(false);
  }, 240_000);

  it("says the survey was refused, rather than reporting a control that went away", async () => {
    // The press is taken on a mount of its own, and the control is named FROM THAT MOUNT — so a
    // survey that REJECTS there comes back empty, which is indistinguishable from a page that
    // dropped the control while its inputs were filled. Both arrive at the same "control 1, not
    // clickable" line; only one of them means the run never got to look.
    //
    // The refusal is aimed at the second survey by what runs before it: the screen text is read
    // once per PAGE, not once per press, so a page can tell the two mounts apart by whether it has
    // been asked for its text yet.
    const close = "</scr" + "ipt>";
    const refuses = `<button type="button" id="go">Order</button><script>
      let asked = false;
      const slice = String.prototype.slice;
      String.prototype.slice = function (from, to) {
        if (to === ${LIMITS.textChars}) asked = true;
        if (to === 60 && !asked) throw new Error("this page will not be surveyed twice");
        return slice.call(this, from, to);
      };
      window.__MC_APP_VIEW.onState(() => {});
      window.__MC_APP_VIEW.ready();${close}`;
    const run = await runPagesHeadless([page("refuses", refuses)]);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const press = run.pages[0]?.presses[0];
    expect(press?.notClickable).toBe(true);
    expect(press?.errors.some((line) => line.includes("could not put a question"))).toBe(true);
  }, 240_000);
});

describe.skipIf(!chromeReady)("a document that stops answering", () => {
  it("is given up on, rather than waited for", async () => {
    // A script that does not return keeps the frame's own thread, so `load` never fires and every
    // question put to it queues behind it. Unbounded, this is not a slow preview — it is a tool
    // call that never comes back, holding the per-repository lock behind it.
    //
    // The spin is FINITE so this test leaves nothing wedged. What is being proved is that the run
    // stops waiting before the page stops spinning, and answers.
    const close = "</scr" + "ipt>";
    const spin = `<div id="x">loading…</div><script>const end = Date.now() + 6000; while (Date.now() < end) {}${close}`;
    const run = await runPagesHeadless([page("spins", spin)]);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.pages[0]?.unresponsive).toBe(true);
  }, 240_000);

  it("still says a question ran out of time after the presses have mounted over it", async () => {
    // ONE question hangs here — the screen text — and everything else about the page answers
    // normally: its button is found, pressed, and reaches the parent. The flag is cleared by every
    // mount, and every press mounts again, so read at the end it answers for the last press alone:
    // this page came back with an empty screen, no reason given, and a clean bill.
    const run = await runPagesHeadless([page("hangs", hangsOnText(`<button type="button" id="go">Order</button>`, true))]);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const hung = run.pages[0];
    expect(hung?.text).toBe("");
    expect(hung?.presses[0]?.submitted).toEqual({ cid: "orders", fields: ["name"] });
    expect(hung?.unresponsive).toBe(true);
  }, 240_000);

  it("does not read the abandoned question's failure onto the next page", async () => {
    // Giving up on a question does not cancel it. The browser still holds it, and it rejects when
    // the frame it was asked of goes away — which, for a page with nothing to press, is the mount
    // of the NEXT page. Recorded against whatever is current at that moment, the hung page's
    // failure is filed under the healthy one, and the author is sent to fix a page nothing is
    // wrong with.
    const run = await runPagesHeadless([page("hangs", hangsOnText("<div>nothing to press</div>", false)), page("works", WORKS)]);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.pages[0]?.unresponsive).toBe(true);
    const works = run.pages[1];
    expect(works?.errors.some((line) => line.includes("could not put a question"))).toBe(false);
    expect(works?.unresponsive).toBe(false);
    expect(works?.presses[0]?.submitted).toEqual({ cid: "orders", fields: ["name"] });
  }, 240_000);
});

describe.skipIf(chromeReady)("without a browser", () => {
  it("says so, and says what to do instead, rather than pretending to have run", async () => {
    const run = await runPagesHeadless([page("works", WORKS)]);
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.problems.join(" ")).toContain("real browser");
    expect(run.problems.join(" ")).toContain("Collections pane");
  });
});
