// The migration gate: existing records that would not satisfy the schema about to be written.
//
// Read from FIRESTORE, not from disk — a shared collection's records live in the app, and the
// question is what the LIVE data looks like under the new schema. Reported as a refusal the
// operator can override, because a breaking change is sometimes exactly what is intended; the
// point is that it is a decision rather than a discovery.
//
// It runs at ONE boundary now. It used to run at two (design D10): deploy's `confirm` let a draft
// into staging on purpose — mid-migration, that is the useful thing — so publish re-ran the scan
// against the version it was about to promote rather than trusting that deploy had been clean.
// There is no staged version to disagree with the working tree any more
// (`plans/feat-shared-app-no-staging.md`), so the scan and the `confirm` that overrides it both
// belong to publish, and a confirm buys exactly the publish it was spent on.
import { MAX_RECORD_ISSUES, STORE_UNREADABLE, validateCollectionRecords, type LoadedCollection } from "@mulmoclaude/core/collection/server";

/** How many broken records to name before summarising. A write that would break a thousand rows
 *  is answered by the count and a sample; dumping all of them buries the number, which is the
 *  part the decision turns on. */
const MAX_LISTED_ISSUES = 10;

export interface RecordScan {
  lines: string[];
  records: number;
  capped: boolean;
  /** Collections whose records could not be READ at all. Kept apart from `lines` because
   *  `confirm` may not override them. */
  unreadable: string[];
}

export async function scanRecords(collections: readonly LoadedCollection[], workspaceRoot: string): Promise<RecordScan> {
  const lines: string[] = [];
  const unreadable: string[] = [];
  let records = 0;
  let cappedAnywhere = false;
  for (const collection of collections) {
    const issues = await validateCollectionRecords(collection, { workspaceRoot });
    if (issues.length === 0) continue;
    // "the backend could not be read" is not a broken record, and must not be overridable the way
    // a broken record is: `confirm` means "I know these rows will not fit the new schema", and
    // here nobody knows anything — the gate did not run. Overriding it would write blind.
    const unread = issues.filter((issue) => issue.file === STORE_UNREADABLE);
    if (unread.length > 0) {
      unreadable.push(`${collection.slug}: ${unread.map((issue) => issue.problem).join("; ")}`);
      continue;
    }
    records += issues.length;
    // `validateCollectionRecords` stops at its own cap (25 per collection), so a full batch means
    // "at least this many" and saying otherwise would read as a complete count of the damage.
    const capped = issues.length >= MAX_RECORD_ISSUES;
    cappedAnywhere = cappedAnywhere || capped;
    const count = capped ? `at least ${issues.length}` : String(issues.length);
    const plural = issues.length === 1 ? "" : "s";
    const note = capped ? " (the scan stops there)" : "";
    lines.push(`${collection.slug}: ${count} existing record${plural} would not satisfy the schema about to be written${note}`);
    for (const issue of issues.slice(0, MAX_LISTED_ISSUES)) lines.push(`  - ${issue.file}: ${issue.problem}`);
    if (issues.length > MAX_LISTED_ISSUES) lines.push(`  - … and ${issues.length - MAX_LISTED_ISSUES} more`);
  }
  return { lines, records, capped: cappedAnywhere, unreadable };
}

/** The scan as a refusal, or null when the operation may proceed.
 *
 *  Every message names publish, and does so literally rather than through a
 *  boundary argument. It used to take one, because there were two boundaries
 *  and they differed in what confirming COST: a confirmed deploy was visible
 *  to the roster, a confirmed publish to everyone. There is one boundary now,
 *  so there is one cost to state — everyone. */
export function recordRefusal(scan: RecordScan, confirm: boolean | undefined): string[] | null {
  if (scan.unreadable.length > 0) {
    return [
      ...scan.unreadable,
      "publish stopped: the live records could not be read, so nothing checked whether the schemas about to be written still fit them. " +
        "This is not something `confirm` overrides — confirming means accepting a known breakage, and here there is no reading at all. " +
        "Fix the access (or the connection) and try again.",
    ];
  }
  if (scan.records === 0 || confirm === true) return null;
  return [
    ...scan.lines,
    "publish stopped: this is the version about to become public, and these records do not fit it. " +
      "Migrate the records first, or re-run publish with confirm to accept the breakage for everyone.",
  ];
}
