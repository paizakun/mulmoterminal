// The page a headless run loads: the SAME parent as the pane, with the chrome replaced by a
// recorder.
//
// "The same parent" is not a figure of speech and it is the whole design constraint
// (`plans/feat-shared-app-preview.md`, "採らなかったもの"): `viewBridge`, `portChannel`,
// `publicViewSrcdoc` and `viewNonce` come out of `@receptron/sharedapp/view`, which is what
// mulmoserver's `/a/{slug}` and this repository's `SharedAppPreview.vue` both run. What a host
// owns is its chrome — what the confirmation looks like, where the diagnostics sit — and here the
// chrome is a log. A second implementation of the parent would agree on the easy things and
// diverge on the ones that matter, which is how "it worked on my machine" is manufactured.
//
// SO THE MODULES ARE SERVED, NOT BUNDLED. `dist/view/*.js` is plain ESM whose only imports are its
// own siblings, so a small HTTP server in front of that directory is all a browser needs, and the
// alternative — a bundler step, or hand-copying the functions into this string — would make what
// runs here a copy that can drift silently.
//
// WHETHER IT ACCEPTS IS THE HOST'S TO DECIDE, and the DECIDING HAPPENS IN NODE. This page never
// reaches the database and holds nothing that could: `accept(answer)` is called with the verdict
// already in hand, and `submit` hands that verdict back to the parent. A run driven by a test, with
// no app and no database behind it, accepts nothing and behaves exactly as this harness always did.
//
// THE WRITER IS NOT A BINDING ON `window`, and that is a correction rather than a preference.
// Puppeteer's `exposeFunction` installs its binding in EVERY document of the page — including the
// sandboxed `srcdoc` this harness mounts, which is the one document here that nobody trusts. A page
// could then call the writer directly, once per line of script, bypassing the run's budget, its
// ledger and its undo: real records in a real app that nothing reports and nothing removes. Passing
// the ANSWER in is what closes that. The page can only ever receive a value Node chose to give it.
//
// It used to refuse unconditionally, and the reason was real while it lasted: before staging was
// removed an app had no `apps/{aid}` until it was deployed, so a confirmation accepted here was
// refused by the rules anyway. Since #1760 an app can be written to from the moment it is
// declared, and the only thing left in the way was a policy whose cost was that the run could
// never bring back the one answer an author most wants before publishing — what the DEPLOYED
// rules say. See `plans/feat-headless-preview-parity.md`.
//
// Design: `plans/feat-shared-app-preview.md` section 7 (P5).

import { GESTURE_MARK } from "@receptron/sharedapp/view";

/** Where the runtime's modules are mounted, relative to the harness page. */
export const VIEW_MOUNT = "/view";

/** The field on a submit message that says the page made it while handling a real click.
 *
 *  RE-EXPORTED, NOT DECLARED. The name is half of a wire contract whose other half is the injected
 *  bootstrap in `@receptron/sharedapp`, and a copy of a string is exactly the kind of agreement
 *  that holds until one side is renamed — at which point nothing fails here, every submission
 *  simply reads as unmarked, and the run quietly stops writing. Importing it makes that a build
 *  error instead.
 *
 *  What the runtime promises, and nothing on this side can check:
 *
 *    true  — `submit()` was called while a TRUSTED click was still being dispatched in that
 *            document: from a listener, or from a continuation ALREADY QUEUED when the dispatch
 *            takes its microtask checkpoint (`await Promise.resolve()` qualifies).
 *    false — everything else. A `setTimeout`, an animation frame, `onState`, a click the page
 *            dispatched itself — and, importantly, `await` on work that actually yields.
 *
 *  THAT LAST ONE IS THE COMMON SHAPE AND IT IS NOT OBVIOUS. These two are identical in source and
 *  land on opposite sides, because what decides it is when the continuation is queued, not that it
 *  is `async`:
 *
 *    async () => { await Promise.resolve(); view.submit(...) }   marked
 *    async () => { await validate(); view.submit(...) }          NOT marked, if validate yields
 *
 *  So a save that awaits a real check writes nothing in a headless preview. The author must be told
 *  that is the reason, or they will conclude their button is broken. Pinned against a real browser
 *  in `headlessPreview.spec.ts` ("marks a handler that awaits a MICROTASK").
 *
 *  It is deliberately a fact about the event loop rather than about elapsed time: a slow handler is
 *  still the handler, and a fast timer is still a timer. That is the whole reason it lives there
 *  and not here — four attempts to decide it from this side by counting and by waiting were each
 *  defeated by a page that simply waited longer (`plans/feat-headless-preview-parity.md`, D-2c).
 *
 *  A CHECKBOX OR SELECT THAT SAVES FROM ITS OWN `change` HANDLER IS NEVER MARKED. Activation
 *  behaviour runs AFTER the click's dispatch has ended, so such a submission is honestly `false`.
 *  The runtime cannot admit `change` instead — `element.click()` from script produces a trusted
 *  one — so the choice was between missing a real save-on-toggle and writing records for pages that
 *  never asked, and it fell on the side that writes nothing.
 *
 *  Do not expect to SEE that as a withheld press, though: `CLICKABLE` in `headlessPreview.ts` lists
 *  button-like controls only, so such a control is never pressed and produces no press line at all.
 *  The run's own field preparation ticks it and fires `change` before the press window, so whatever
 *  it submits arrives outside any press. The visible result is a report with nothing in it about a
 *  save path that was never exercised — which is why the tool description and the skill both have
 *  to say so out loud. */
// Re-exported, not `export ... from`: the browser side below reads the field off the wire and so
// needs the value in scope here too.
export { GESTURE_MARK };

/** What one rendered document produced, as the browser side collects it. Mirrored on the Node side
 *  by `HeadlessObservation` — the two are one shape crossing `page.evaluate`, so a field added
 *  here has to be read there or it is collected for nobody. */
export interface HarnessObservation {
  /** The frame answered the handshake on its private port. False is the `ready()` deadlock. */
  readied: boolean;
  /** The parent actually sent the records. Separate from `readied` because a page can answer the
   *  handshake and still be handed nothing when the app declares no datasets for it. */
  stateDelivered: boolean;
  /** Submissions that became a confirmation — the point at which a visitor would be asked. */
  submitted: { cid: string; fields: string[] }[];
  /** What the parent refused before drawing anything: `unknown-collection`, `undeclared-field`,
   *  `not-a-submission`, `busy`. These are the answers an author cannot see in the browser,
   *  because the page gets them as a rejected promise it usually does not await. */
  refused: string[];
  /** What the PAGE said about itself, through the runtime's `notice` port: an uncaught error, a
   *  promise it rejected and never handled, a modal the sandbox ignored. The pane has always taken
   *  these and this harness dropped them, which is the parity gap that made a page reporting its
   *  own crash look like a page that simply drew nothing. `detail` is PAGE-AUTHORED — see
   *  `ViewNotice` — so it is carried as the page's words and reported as such. */
  notices: { code: string; detail: string }[];
  /** The confirmation waiting to be answered, with the VALUES the page submitted.
   *
   *  The values and not only their field names, because Node is what writes now: the record the
   *  rules judge is built from these, and a host that could see only the keys would have to invent
   *  the rest. They never leave this process — the harness reads them out of the cell the parent
   *  already holds, and `runPagesHeadless` hands them to the writer. */
  pending: { cid: string; values: Record<string, string>; clickCaused: boolean } | null;
}

/** The harness document. A constant rather than a file on disk: it is served from memory to a
 *  browser this process started, and a file would have to survive `npm pack` and be found again at
 *  runtime for no benefit. */
export const HARNESS_HTML = `<!doctype html>
<meta charset="utf-8">
<title>shared-app headless preview</title>
<body>
<div id="host"></div>
<script type="module">
import { memberBridge, portChannel, publicViewSrcdoc, viewBridge, viewNonce, VIEW_MESSAGE } from "${VIEW_MOUNT}/index.js";

const host = document.getElementById("host");
let frame = null;
let datasets = {};
let config = null;
// The \`{ me, can }\` this page's audience resolves to, or null for a public one. A member page run
// without it is the bug this harness reported for months as an author's mistake: the page is handed
// \`{}\`, draws none of its buttons, and the report says the controls were not there.
let viewer = null;
let nonce = viewNonce();
let outbound = [];
let submitted = [];
let notices = [];
// requestId -> did the runtime mark this submission as click-caused. Read off the RAW inbound
// message: the parent's \`PendingSubmit\` carries what a confirmation panel needs in order to draw,
// and this is not that — it is provenance, and it travels beside the request rather than inside it.
// Reading it here is what keeps the change to \`@receptron/sharedapp\` down to the one place that
// can know the answer: the bootstrap inside the document.
let gestures = new Map();
// The verdict Node handed in for the confirmation currently being answered. Null means nothing was
// accepted, which is what \`submit\` refuses on.
let answer = null;

// The cells the bridge writes into. Plain objects with a \`value\`, which is all \`Signal<T>\` asks
// for — the package holds no framework precisely so a host can supply its own, and a recorder's
// own is a setter that appends.
let pendingValue = null;
const cells = {
  pending: {
    get value() {
      return pendingValue;
    },
    set value(next) {
      pendingValue = next;
      if (next !== null) submitted.push({ cid: next.cid, fields: Object.keys(next.values) });
    },
  },
  sending: { value: false },
  readied: { value: false },
};

const recording = (make) => () => {
  const channel = make();
  return {
    post: (message) => {
      outbound.push(message);
      channel.post(message);
    },
    // INBOUND IS READ TOO, and only for provenance — the bridge still receives every message
    // untouched. This notes the mark beside the request and gets out of the way.
    onMessage: (handler) =>
      channel.onMessage((data) => {
        if (data !== null && typeof data === "object" && data.type === VIEW_MESSAGE.submit && typeof data.requestId === "string") {
          gestures.set(data.requestId, data[${JSON.stringify(GESTURE_MARK)}] === true);
        }
        handler(data);
      }),
    close: channel.close,
  };
};

/** The member's parent, for a roster or participant page. It performs nothing — a transition, an
 *  assignment or a withdrawal is a real write against the live rules and neither this harness nor
 *  the PANE has a route for one — so every intent is refused BY NAME on the channel, which the
 *  report reads back out of \`outbound\`. That refusal is parity, not a shortfall: the pane refuses
 *  them too, for the same reason and in the same words. */
const member = memberBridge(
  {
    channel: recording(() => portChannel(frame)),
    state: () => datasets,
    viewer: () => viewer ?? { me: null, can: {} },
    // The page's own account of itself, which the pane has always taken and this harness dropped.
    // A page that crashes reports it HERE and nowhere else the run can see — dropped, it read as a
    // page that simply drew nothing.
    notice: (report) => notices.push({ code: String(report.code), detail: String(report.detail) }),
    // THE SAME CELL the public parent writes, because \`observe()\` reads one and the report puts
    // "It NEVER answered the handshake" at the top of a page whose value is false — over a
    // paragraph saying nothing below describes the page's behaviour. Wired to the public bridge
    // alone, every healthy member page was reported that way.
    readied: cells.readied,
  },
  () => nonce,
);

const bridge = viewBridge(
  {
    // Recorded on its way out, like the member parent's above. The refusals are only visible here:
    // they are answered on the port and never drawn, which is exactly why an author watching the
    // screen cannot see them.
    channel: recording(() => portChannel(frame)),
    // THE ANSWER NODE ALREADY DECIDED, or a refusal when it decided nothing.
    //
    // Node writes the record (through \`writePreviewSubmission\` — the same function the pane's own
    // accept path reaches through its HTTP route), and only then calls \`accept\` below with what
    // the database said. So the page runs its real post-submit path against a real verdict, and
    // this document never held anything that could reach a database.
    submit: async () => answer ?? { ok: false, error: "a headless preview never writes" },
    state: () => datasets,
    notice: (report) => notices.push({ code: String(report.code), detail: String(report.detail) }),
  },
  () => config,
  () => nonce,
  cells,
);

// Only our frame. The sandbox's origin is opaque, so \`event.origin\` cannot draw this line.
window.addEventListener("message", (event) => {
  if (frame === null || event.source !== frame.contentWindow) return;
  // The audience decides which parent answers, exactly as the address does in production.
  if (viewer !== null) {
    member.receive(event.data);
    return;
  }
  bridge.receive(event.data);
});

const refusals = () => outbound.filter((message) => message.type === VIEW_MESSAGE.result && message.ok === false).map((message) => String(message.error));

window.__preview = {
  /** Mount one document. Called again for every button pressed, so each press is judged against a
   *  page in its starting state rather than against whatever the previous press left behind. */
  render(page) {
    bridge.restart();
    member.forget();
    outbound = [];
    submitted = [];
    notices = [];
    gestures = new Map();
    answer = null;
    datasets = page.datasets;
    viewer = page.viewer ?? null;
    config = page.submit === null ? null : { submit: page.submit };
    nonce = viewNonce();
    if (frame !== null) frame.remove();
    frame = document.createElement("iframe");
    // The production sandbox, to the letter: no \`allow-forms\`, no \`allow-modals\`,
    // no \`allow-same-origin\`. A looser one here would pass pages the world cannot use.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.width = "900px";
    frame.style.height = "700px";
    const loaded = new Promise((resolve) => {
      frame.addEventListener("load", () => resolve(true), { once: true });
    });
    frame.srcdoc = publicViewSrcdoc(page.html, nonce);
    host.appendChild(frame);
    return loaded;
  },
  observe() {
    return {
      readied: cells.readied.value,
      stateDelivered: outbound.some((message) => message.type === VIEW_MESSAGE.state),
      submitted,
      refused: refusals(),
      notices,
      pending:
        pendingValue === null
          ? null
          : { cid: pendingValue.cid, values: pendingValue.values, clickCaused: gestures.get(pendingValue.requestId) === true },
    };
  },
  /** Answer the confirmation the way a visitor who changed their mind would. */
  decline() {
    bridge.decline();
  },
  /** Answer it the way somebody who meant it would, with the verdict Node already has.
   *
   *  \`given\` is what the parent's \`submit\` will return — \`{ ok: true }\`, or \`{ ok: false, error }\`
   *  carrying what the database said. The page's own success or failure path then runs against the
   *  real answer, which is the whole reason to accept rather than to decline. */
  async accept(given) {
    answer = given;
    await bridge.accept();
    answer = null;
  },
};
</script>
`;
