// Terminal "query" control sequences an application writes to probe the emulator — Device
// Attributes, device/cursor status, OSC color, kitty-keyboard flags, XTVERSION. The emulator
// auto-REPLIES to each. That's correct live, but when we replay a reattached session's buffered
// output, xterm re-answers the queries baked into it and the stale replies are sent back as
// INPUT, surfacing as junk like "0;276;0c" in the app's prompt (codex writes several at startup).
// Strip them from the replay only: they render nothing, so the visual restore is unchanged, and
// the app re-queries live if it still needs to.
//
// Built via new RegExp so the ESC/BEL control chars stay out of the regex source (satisfies
// no-control-regex without a disable).
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

const QUERY_PATTERNS: RegExp[] = [
  new RegExp(ESC + "\\[[>=]?\\d*c", "g"), // Device Attributes (DA1/DA2/DA3) — the "…c" symptom
  new RegExp(ESC + "\\[\\??\\d*n", "g"), // device / cursor status report (DSR / CPR)
  new RegExp(ESC + "\\[\\?u", "g"), // kitty keyboard flags query
  new RegExp(ESC + "\\[>\\d*q", "g"), // XTVERSION
  new RegExp(ESC + "\\]1[012];\\?(?:" + BEL + "|" + ESC + "\\\\)", "g"), // OSC 10/11/12 fg/bg/cursor color query
];

export function stripTerminalQueries(data: string): string {
  return QUERY_PATTERNS.reduce((out, re) => out.replace(re, ""), data);
}

// The same modes infra/tmux.ts's TERMINAL_MODE_FLAGS restores from tmux — kept as a literal
// copy rather than a shared import because pulling infra/tmux.ts into this module for one array
// would drag its process-spawning surface along with it.
const TRACKED_MODES = new Set([1049, 1000, 1002, 1003, 1005, 1006]);

const MODE_SEQUENCE = new RegExp(ESC + "\\[\\?([0-9;]+)([hl])", "g");

// Where a chunk could have been cut mid-sequence: an ESC, or ESC "[", or ESC "[?" plus whatever
// digits/semicolons came before the cut — anything short of the h/l that would have closed it.
// Anchored at the END of the (post-match) remainder, so a complete, unrelated escape sequence
// earlier in that remainder (colour codes, cursor moves) is not mistaken for a pending one.
const INCOMPLETE_MODE_TAIL = new RegExp(ESC + "(\\[(\\?[0-9;]*)?)?$");

// Mirrors tmuxTerminalModes for sessions with no tmux to ask (infra/tmux.ts:325 chose the tmux
// query specifically to avoid this bookkeeping — plain shells and a tmux-less host are the one
// case that leaves nothing to query, so it happens here instead, scoped to the modes the reattach
// prefix ever restores).
//
// `entry.modesCarry` holds a sequence this call found incomplete at the end of `data`, so a
// DECSET/DECRST split across two pty reads is not lost between chunks (the same hazard
// appendBoundedOutput's cut handles for the buffer, from the opposite direction).
export function trackTerminalModes(entry: { modes?: Set<number>; modesCarry?: string }, data: string): void {
  const modes = (entry.modes ??= new Set());
  const combined = (entry.modesCarry ?? "") + data;
  MODE_SEQUENCE.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MODE_SEQUENCE.exec(combined)) !== null) {
    lastIndex = MODE_SEQUENCE.lastIndex;
    const [, codes, setter] = match;
    const setting = setter === "h";
    for (const code of (codes ?? "").split(";").map(Number)) {
      if (!TRACKED_MODES.has(code)) continue;
      if (setting) modes.add(code);
      else modes.delete(code);
    }
  }
  const tailMatch = INCOMPLETE_MODE_TAIL.exec(combined.slice(lastIndex));
  entry.modesCarry = tailMatch ? tailMatch[0] : "";
}

// The DECSETs that put a reattaching browser back into the screen buffer and mouse modes the app
// set once and never repeated (#1073) — read from tmux, sent AHEAD of the replay so the tail
// renders where it was written.
//
// ONE SEQUENCE PER MODE, never `CSI ? 1049 ; 1003 h`. The client only swallows a sequence whose
// parameters are ALL mouse modes (src/composables/mouseTrackingModes.ts); a combined one would
// reach xterm, which would then do the mouse tracking itself and turn every drag into coordinate
// reports instead of a text selection — the regression #729 exists to prevent.
//
// Order within the prefix doesn't matter (the client records modes into a Set, and xterm's mouse
// state survives the buffer switch). Preceding the replay is what matters.
export function terminalModePrefix(modes: readonly number[]): string {
  return modes.map((mode) => `${ESC}[?${mode}h`).join("");
}

// A CSI sequence closes with a final byte in 0x40-0x7E; an OSC string closes with BEL
// or ST. Neither can appear inside the sequence before its terminator, so the first
// occurrence IS the end.
const CSI_FINAL = /[\x40-\x7E]/;
// ST is the TWO bytes `ESC \`, so the backslash must be consumed with the escape or it
// leaks into the retained output. The trailing `?` still matches a lone ESC, which is
// how a terminal aborts an unfinished OSC.
const OSC_TERMINATOR = new RegExp(BEL + "|" + ESC + "\\\\?");

// Past the END of the terminator, not past its first character — ST is two bytes wide.
const firstMatchEnd = (text: string, terminator: RegExp): number => {
  const found = terminator.exec(text);
  if (!found) return text.length;
  return found.index + found[0].length;
};

// How many leading characters of `cut` belong to a sequence the truncation split. Zero
// when the cut fell cleanly BETWEEN sequences — the common case, and the one where every
// byte must be kept.
//
// This is decided from the discarded side, not guessed from the retained side. An earlier
// version pattern-matched the head of `cut` and could strip ordinary text
// ("/api/v1/resource" -> "pi/v1/resource"); knowing what was thrown away removes the
// guesswork entirely.
//
// The search for the opening escape spans the WHOLE discarded prefix rather than a fixed
// window. A bounded look-behind misses OSC strings whose payload is longer than the
// window — and this host enables OSC 52 deliberately (see infra/tmux.ts), so kilobyte
// base64 clipboard payloads are a designed-for case, not a hypothetical.
const splitSequenceLength = (combined: string, cutAt: number, cut: string): number => {
  const escapeAt = combined.lastIndexOf(ESC, cutAt - 1);
  if (escapeAt === -1) return 0;
  const afterEscape = combined.slice(escapeAt + 1, cutAt);
  // The introducer went with the discarded text, or it is the first retained character.
  const introducer = afterEscape.length > 0 ? afterEscape.charAt(0) : cut.charAt(0);
  const retained = afterEscape.length > 0 ? cut : cut.slice(1);
  const consumedIntroducer = afterEscape.length > 0 ? 0 : 1;
  if (introducer === "[") {
    // Closed already if a final byte followed the introducer before the cut.
    if (CSI_FINAL.test(afterEscape.slice(1))) return 0;
    return consumedIntroducer + firstMatchEnd(retained, CSI_FINAL);
  }
  if (introducer === "]") {
    if (OSC_TERMINATOR.test(afterEscape.slice(1))) return 0;
    return consumedIntroducer + firstMatchEnd(retained, OSC_TERMINATOR);
  }
  // A two-character sequence (ESC + one byte). It is complete unless that byte is the
  // first retained character, in which case dropping it alone is enough.
  return consumedIntroducer;
};

// Append PTY output, keeping a bounded tail for reattach replay.
//
// Cutting by character count can land INSIDE an escape sequence, and the orphaned
// parameter bytes then render as literal junk ("5;196m") at the top of the screen
// restored on reattach — stripTerminalQueries can't help, it only matches whole
// sequences. So drop exactly the split sequence and nothing else.
export function appendBoundedOutput(buffer: string, data: string, limit: number): string {
  const combined = buffer + data;
  if (combined.length <= limit) return combined;
  const cutAt = afterOrphanedSurrogate(combined, combined.length - limit);
  const cut = combined.slice(cutAt);
  return cut.slice(splitSequenceLength(combined, cutAt, cut));
}

// The OTHER boundary a character-count cut can land inside (#1639). `slice` counts UTF-16 code
// units, so cutting between the halves of a surrogate pair keeps the low half alone — which is
// not an error anywhere: the string stays a legal JS string, JSON.stringify emits it as
// "\udf9f", and it first becomes visible as U+FFFD at the top of the restored screen.
//
// Resolved where the cut index is decided, so one number answers "where does the tail start"
// before anything reads it — not because the escape scan below needs it in that order.
//
// What it acts on is the POSITION, not the provenance: a low surrogate sitting at the cut is
// dropped whether this cut orphaned it or it was already there. One further into the retained
// tail is untouched — nothing here scans the tail.
//
// So the helper is not a sanitiser, and does not need to be: its input is decoded pty output,
// and a UTF-8 decoder answers invalid bytes with U+FFFD — it has no way to emit half a pair.
//
// Whether the code unit before it is the matching high half is deliberately not checked: it
// would only ever agree, since both cases it distinguishes want the same answer.
const afterOrphanedSurrogate = (text: string, at: number): number => {
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff ? at + 1 : at;
};

// How far past `limit` the retained tail is allowed to run before it is cut back.
//
// The slack is what makes the append cheap, and its size is a memory trade, not a speed one.
// Every value tested appends in ~0.0002 ms; what changes is how much unflattened rope the tail
// carries between cuts, and a rope of small chunks costs several times its character count in
// cons nodes and per-string headers. Measured per session at a 1 MiB limit, 40-byte pty chunks:
// 1.00 MB as it was, 2.54 MB at 1.25, 6.45 MB at 2.
const TAIL_SLACK = 1.25;

// Append pty output for replay WITHOUT paying for the bound on every chunk.
//
// appendBoundedOutput slices, which flattens, so calling it per chunk costs O(limit) however
// few bytes arrived — 0.1 ms against a full 1 MiB buffer, ~11k times a second under a flooding
// command. That is one core, and it is spent starving the pty read that would have drained the
// child: six cells running the same command took 8230 ms instead of 2159 ms (#1506).
//
// Concatenation is what V8 keeps as a rope, so this is O(chunk); the exact cut happens once per
// TAIL_SLACK-worth of appended output. Readers therefore get MORE than `limit` and must cut it
// back themselves — see PtyEntry.buffer.
export function growOutputTail(buffer: string, data: string, limit: number): string {
  const grown = buffer + data;
  return grown.length > limit * TAIL_SLACK ? appendBoundedOutput(grown, "", limit) : grown;
}

/** The exact bounded tail, for the two places that read a session's buffer out. Named rather
 *  than inlined so "the buffer overruns its limit" has one answer instead of two. */
export function boundedTail(buffer: string, limit: number): string {
  return appendBoundedOutput(buffer, "", limit);
}
