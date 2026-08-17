// unpublish — close the app to anonymous visitors, first thing and on its own.
//
// The exact reverse of publish's order (design D10): `apps/{aid}.public` is the authorization, so
// removing it goes FIRST. A run that stops after that leaves the app closed with a stale public
// projection behind it, which is a tidiness problem; the other order would leave it open with the
// projection gone, which is the failure this ordering exists to make impossible.
//
// The promoted schemas under `collections/{cid}` are deliberately LEFT: nobody can read them
// while the app is closed, so they cost nothing, and re-publishing is then a promotion rather
// than a rebuild.
//
// It deliberately does NOT run the declaration gate that deploy and publish share, and it does
// not mint an `aid` the way they do. Those steps decide whether something may go OUT; taking it
// down has to work when the declaration is broken, which is one of the times an operator most
// wants it. And a take-down must not AUTHOR: minting an aid here would write a fresh id into
// `app.json`, then report "there is no app document at apps/<that id>" — a true sentence about an
// app nobody ever had, in place of the real reason. Only the `aid` is read.
import { isRecord } from "../../../common/isRecord.js";
import { appManifestReason, firestoreHandle, loadAppManifest } from "@mulmoclaude/core/collection/server";
import { APPS_COLLECTION, PUBLIC_CONFIG_DOC, appConfigPath } from "@receptron/sharedapp";
import { PUBLIC_VIEW_DOC } from "./publicView.js";
import type { SharedAppFailure } from "./context.js";
import { runWrites } from "./writes.js";
import { setSlugPublished } from "./slug.js";

export interface UnpublishSuccess {
  ok: true;
  aid: string;
  /** Was it open in the first place? An unpublish of an already-closed app is a no-op worth
   *  saying out loud — the operator asked for a state, and hearing "done" when nothing changed
   *  reads as confirmation that it HAD been open. */
  wasOpen: boolean;
  /** The URL name that stopped resolving, when there was one. */
  slug?: string | undefined;
}

export type UnpublishResult = UnpublishSuccess | SharedAppFailure;

export async function unpublishSharedApp(root: string): Promise<UnpublishResult> {
  const handle = firestoreHandle();
  if (!handle) {
    return { ok: false, partial: false, problems: ["unpublish needs a signed-in Firestore session: connect remote-host first."] };
  }
  const manifest = loadAppManifest(root);
  if (!manifest.ok) return { ok: false, partial: false, problems: [appManifestReason(manifest, root)] };
  const { aid } = manifest.manifest;

  let existing: unknown;
  try {
    existing = await handle.docs.get(APPS_COLLECTION, aid);
  } catch (err) {
    return {
      ok: false,
      partial: false,
      problems: [`unpublish failed while reading the app document (apps/${aid}): ${err instanceof Error ? err.message : String(err)}`, "Nothing was written."],
    };
  }
  if (!isRecord(existing)) {
    return {
      ok: false,
      partial: false,
      problems: [`there is no app document at apps/${aid}, so there is nothing to close. Nothing was written.`],
    };
  }
  // Replacement without the key, because a merge cannot DELETE — and here the deletion IS the
  // operation. Everything else is carried through from the document as it stands rather than
  // re-projected, so closing the app cannot also apply an unrelated edit nobody asked to publish.
  const closed = Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "public"));
  const wasOpen = "public" in existing;

  // The name stops resolving on the way down, after the authorization is gone and before the
  // rendering data. Exactly the reverse of publish, for the reverse reason: what is taken away
  // first is what grants.
  const slug = typeof existing.slug === "string" ? existing.slug : undefined;

  const failure = await runWrites(
    [
      { what: `the public block on apps/${aid} — the authorization itself`, run: () => handle.docs.set(APPS_COLLECTION, aid, closed) },
      ...(slug === undefined ? [] : [{ what: `the URL name '${slug}' (appSlugs/${slug})`, run: () => setSlugPublished(handle, aid, slug, false) }]),
      {
        what: `the public config document (apps/${aid}/config/${PUBLIC_CONFIG_DOC})`,
        run: async () => {
          await handle.docs.delete(appConfigPath(aid), PUBLIC_CONFIG_DOC);
        },
      },
      // The page comes down with the settings. `config/{docId}` is
      // `allow read: if true` whatever else is closed, so a view left behind
      // is a page anybody can still fetch from an app that has been taken
      // down — the same shape of leak as the config document above, and the
      // reason both deletions are here rather than left to the next publish.
      {
        what: `the published view (apps/${aid}/config/${PUBLIC_VIEW_DOC})`,
        run: async () => {
          await handle.docs.delete(appConfigPath(aid), PUBLIC_VIEW_DOC);
        },
      },
      // THE MEMBERS' AND PARTICIPANTS' PAGES STAY, and that is a change of meaning rather than an
      // omission. They used to come down here, because `live:` meant "published" and a take-down
      // took the published things away — the roster went on working from the `staged:` copy at
      // `/staging/{aid}`.
      //
      // There is no such copy any more (`plans/feat-shared-app-no-staging.md`). These documents are
      // the roster's app, read at `/m/{slug}` and `/p/{slug}`, and the rules gate them by
      // `staffOf` / `listedIn` — never by anything unpublish touches. Deleting them would take the
      // front desk's page away from the front desk because the owner closed the app to STRANGERS,
      // and leave no way back but a publish.
    ],
    "unpublish",
  );
  if (failure) return failure;
  return { ok: true, aid, wasOpen, slug };
}
