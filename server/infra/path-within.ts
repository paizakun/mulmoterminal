// One rule, one place: is this path the same as, or inside, that one?
//
// It was hand-rolled in eight places as `target === base || target.startsWith(base + sep)`.
// Six of those are safe only by construction — the target is derived from the base with
// `path.resolve(base, rel)`, so the prefix is the same bytes — and the two where the sides
// come from DIFFERENT sources were both wrong on Windows (#802): a base that was never
// resolved compares against a resolved target (`\home\u\…` vs `C:\home\u\…`), and an
// equality check between a client-supplied directory and a stored one misses on casing.
//
// `platform` is a parameter so both arms are checkable from any host, and the matching
// `path` implementation is chosen from it — `path.resolve` itself is platform-dependent
// (drive qualification), which is the very thing that broke.
import path from "node:path";

const platformPath = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

// Windows compares paths case-insensitively at the OS level, so `C:\Users\u` and
// `c:\users\u` name one directory and must compare equal. macOS is usually
// case-insensitive too, but a case-sensitive APFS volume is a supported setup — and
// several callers here are containment GUARDS, where folding on a guess would widen
// what passes. So only win32 folds.
//
// Not modelled: Windows 10+ can mark an individual directory case-SENSITIVE (fsutil, for
// WSL interop), where two names folding together are genuinely two directories. Every guard
// that matters here also re-checks against realpath, and the opt-in setup is rare enough
// that failing the common case to serve it would be the worse trade.
const normalize = (p: string, platform: NodeJS.Platform): string => {
  const resolved = platformPath(platform).resolve(p);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
};

/** One spelling per directory, for a path that is STORED rather than compared: `/a/b/` and
 *  `/a/b` name one directory, and `path.resolve` is the whole rule (it drops the trailing
 *  separator except on a filesystem root, and collapses `.` / `..`).
 *
 *  Case is deliberately NOT folded here, unlike `normalize` above. That one exists to compare;
 *  this value is handed to a PTY, shown in the UI, and written to config.json, and lowercasing
 *  a Windows path would corrupt all three. Fold when comparing (`isSamePath`), never when keeping.
 *
 *  **Absolute input only** — `path.resolve` splices a relative string onto the server's own cwd,
 *  which invents a directory the caller never named. Every caller checks `isAbsolute` first. */
export function canonicalDir(dir: string, platform: NodeJS.Platform = process.platform): string {
  return platformPath(platform).resolve(dir);
}

/** Do these name the same path? Both sides are resolved first, so a drive-relative or
 *  un-normalized spelling of the same directory still matches — separator style included, since
 *  `.resolve()` folds `/` and `\` to one native form on win32 (`path.win32.resolve` accepts
 *  both) before the case fold runs. */
export function isSamePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalize(a, platform) === normalize(b, platform);
}

/** Is `target` `base` itself, or inside it? Note what this does NOT do: resolve symlinks.
 *  A lexical answer only constrains the path string, so a caller guarding a security
 *  boundary must canonicalize (realpath) both sides first and ask again — that is why
 *  files/pathContainment.ts has both a lexical and a real check. */
export function isWithin(base: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const root = normalize(base, platform);
  const candidate = normalize(target, platform);
  if (candidate === root) return true;
  // `resolve` leaves a trailing separator only on a filesystem root ("/" , "C:\"), where
  // appending another would match nothing.
  const sep = platformPath(platform).sep;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Inside `base`, but not `base` itself — for callers whose base is a container that is
 *  not a member of itself (a worktrees root is not a worktree). */
export function isStrictlyWithin(base: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  return isWithin(base, target, platform) && !isSamePath(base, target, platform);
}
