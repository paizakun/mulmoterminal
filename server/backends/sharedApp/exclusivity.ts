// The keys that decide WHICH DOCUMENT a submission claims, frozen once anything
// has claimed one.
//
// `idFrom: "field"` puts the contested thing's id into the record's id, so two
// people wanting one slot write one document and Firestore refuses the second.
// Everything about that rests on one equality — and on both halves of the
// mirror agreeing about where the public projection lives.
//
// Change any of it after records exist and the rules go on enforcing the new
// version perfectly, against an id space the old rows are not in:
//
//   `idField` from `slot` to `slotId`, or `idIn` to another collection, and
//   every existing booking stops holding the slot it was written for. The
//   slot is bookable again, by somebody else, while the original booking sits
//   there looking valid.
//
//   `mirror` or `mirrorOf` moved, and a staff delete consults the NEW
//   destination: the old slot's `state` is never returned to `open`, so it is
//   unsellable for good.
//
// The rules cannot see this. They judge one write at a time and cannot scan the
// rows that came before, so the refusal has to live at the gate — beside the
// migration scan, which asks the neighbouring question about the same records.
//
// `confirm` does NOT override it. The other gate's confirm means "I know these
// records will not fit the new schema": a stated, visible breakage. Here what
// breaks is an exclusivity guarantee, silently, in an app that goes on working.
// The way forward is to empty the collection or to build the new arrangement
// under a new cid.
import { isRecord } from "../../../common/isRecord.js";
import { appSchemasPath, type AuthoredApp, type AuthoredSubmit } from "@receptron/sharedapp";
import type { SharedAppHandle } from "./context.js";

/** Where a shared collection's records live. Built from core's schemas path so
 *  the two cannot drift: `apps/{aid}/collections/{cid}/items`. */
const itemsPath = (aid: string, cid: string): string => `${appSchemasPath(aid)}/${cid}/items`;

/** One frozen value, named as the author wrote it. */
interface Pinned {
  key: string;
  was: string;
  now: string;
}

/** The submission-side keys, rendered so that a change reads as a change.
 *
 *  `idIn` is compared as JSON because it is a small object and every part of
 *  it — the collection, and the state a record must be in — decides which
 *  documents may be claimed. */
const submitPins = (submit: Record<string, unknown> | undefined): Record<string, string> => ({
  idFrom: text(submit?.idFrom),
  idField: text(submit?.idField),
  idIn: text(submit?.idIn),
  mirror: text(submit?.mirror),
});

/** The same four, from the PARSED declaration — where they are typed and no
 *  narrowing is needed. */
const declaredPins = (submit: AuthoredSubmit): Record<string, string> => ({
  idFrom: text(submit.idFrom),
  idField: text(submit.idField),
  idIn: text(submit.idIn),
  mirror: text(submit.mirror),
});

const text = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(canonical(value));
};

/** The same value with every map's keys in a fixed order.
 *
 *  `idIn` is compared as text, and `JSON.stringify` preserves INSERTION order —
 *  so re-ordering the keys in `app.json`, which changes nothing about what the
 *  rules do, would otherwise read as a moved identity key and refuse a
 *  re-publish. The gate is meant to catch a changed CONSTRAINT, not a changed
 *  spelling of the same one. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      // A stable order is all this needs — the strings are never shown, only
      // compared with another canonicalisation of the same shape.
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonical(value[key])]),
  );
};

/** What differs between the live declaration and the one about to be written. */
const changed = (was: Record<string, string>, now: Record<string, string>): Pinned[] =>
  Object.keys(now)
    .filter((key) => (was[key] ?? "") !== (now[key] ?? ""))
    .map((key) => ({ key, was: was[key] ?? "", now: now[key] ?? "" }));

const describe = (pins: Pinned[]): string =>
  pins.map((pin) => `${pin.key}: ${pin.was === "" ? "(absent)" : pin.was} → ${pin.now === "" ? "(absent)" : pin.now}`).join(", ");

/** Does this collection hold anything — or could we not tell?
 *
 *  Three answers rather than two, because the third one is the dangerous one.
 *  Treating a failed listing as "empty" lets a changed identity key through on
 *  a transient error, stranding every existing claim; and the migration scan
 *  next door cannot cover for it, since that is a SEPARATE read which may well
 *  have succeeded a moment earlier. */
type Held = "some" | "none" | "unknown";

const holdsRecords = async (handle: SharedAppHandle, aid: string, cid: string): Promise<Held> => {
  try {
    const docs = await handle.docs.list(itemsPath(aid, cid));
    return docs.length > 0 ? "some" : "none";
  } catch {
    return "unknown";
  }
};

/** One step into a document nobody validated. The app document is read back
 *  from Firestore, so every level of it is `unknown` until proven otherwise —
 *  and a missing level means "not declared", which is the same answer as an
 *  empty one. */
const child = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** Every collection the LIVE app document configures. Its own reader because
 *  the gate has to look at collections the new declaration no longer mentions:
 *  those are exactly the ones whose halves are being dropped. */
const liveCollectionCids = (live: Record<string, unknown> | null): string[] => {
  const collections = child(live, "collections");
  return isRecord(collections) ? Object.keys(collections) : [];
};

/** The live declaration, as the app document has it now. */
const liveSubmit = (live: Record<string, unknown> | null, cid: string): Record<string, unknown> | undefined => {
  const entry = child(child(child(live, "public"), "submit"), cid);
  return isRecord(entry) ? entry : undefined;
};

const liveMirrorOf = (live: Record<string, unknown> | null, cid: string): string => text(child(child(child(live, "collections"), cid), "mirrorOf"));

/** Every exclusivity key that moved under live records.
 *
 *  Empty for the ordinary case — a first publish, a collection with nothing in
 *  it, or a declaration whose identity keys did not move — which is why the
 *  reads only happen for collections that changed. */
export async function frozenKeyProblems(
  authored: AuthoredApp,
  declared: Record<string, { mirrorOf?: string | undefined }>,
  live: Record<string, unknown> | null,
  handle: SharedAppHandle,
): Promise<string[]> {
  const problems: string[] = [];
  // Both halves are published from the MANIFEST, so that is what this compares.
  // The collection side below used to read what a DEPLOY had staged, because
  // that was the version publish promoted; there is one version now.
  for (const [cid, submit] of Object.entries(authored.public?.submit ?? {})) {
    problems.push(
      ...(await movedUnderRecords(
        handle,
        authored.aid,
        cid,
        changed(submitPins(liveSubmit(live, cid)), declaredPins(submit)),
        "the ids those records were written under",
      )),
    );
  }
  // The UNION with what is live, not just what the manifest declares: a
  // collection the repository no longer has is absent from `declared`
  // entirely, and a loop over `declared` alone would never compare it against
  // the live half it is about to drop.
  for (const cid of new Set([...Object.keys(declared), ...liveCollectionCids(live)])) {
    const was = liveMirrorOf(live, cid);
    const now = text(declared[cid]?.mirrorOf);
    if (was === now) continue;
    problems.push(
      ...(await movedUnderRecords(handle, authored.aid, cid, [{ key: "mirrorOf", was, now }], "the projection those records are the public face of")),
    );
  }
  return problems;
}

/** The refusal for one collection whose keys moved — including the one for a
 *  collection we could not read. */
async function movedUnderRecords(handle: SharedAppHandle, aid: string, cid: string, moved: Pinned[], what: string): Promise<string[]> {
  if (moved.length === 0) return [];
  const held = await holdsRecords(handle, aid, cid);
  if (held === "none") return [];
  if (held === "unknown") return [unreadable(cid, moved)];
  return [refusal(cid, moved, what)];
}

const unreadable = (cid: string, moved: Pinned[]): string =>
  `this changes what a submission to '${cid}' claims (${describe(moved)}), and its live records could not be read — so nothing knows whether anything is holding a claim under the old keys. ` +
  "Publishing anyway would strand those claims silently if there are any. This is not something `confirm` overrides: confirming means accepting a KNOWN breakage, and here there is no reading at all. " +
  "Fix the access (or the connection) and try again.";

const refusal = (cid: string, moved: Pinned[], what: string): string =>
  `'${cid}' holds records, and this changes ${what}: ${describe(moved)}. ` +
  "Those keys decide WHICH DOCUMENT a submission claims, and the rules cannot see the rows that came before — so the old records would stop holding what they hold, " +
  "silently, in an app that goes on working. This is not something `confirm` overrides. Empty the collection, or build the new arrangement under a new cid.";

/** Only the identity keys, for the message above and for tests. */
export const EXCLUSIVITY_KEYS = ["idFrom", "idField", "idIn", "mirror", "mirrorOf"] as const;

export type { AuthoredSubmit };
