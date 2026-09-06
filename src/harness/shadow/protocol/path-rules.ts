// ===========================================
// Shadow protocol v1 — canonical paths, git modes, bytewise ordering
// ===========================================
// Memo §5.1. A path that reaches a hash grammar has already passed
// `checkCanonicalPath`: repo-relative POSIX, valid UTF-8, no `..` segment,
// no leading `/`, no empty or `.` segment, no repeated separator, bounded
// in total and per component. Ordering is over raw UTF-8 BYTES — not UTF-16
// code units and not a locale collation — because two machines must agree
// on the record order or their tree hashes differ for the same tree.
//
// Modes: only `100644` and `100755` are admitted. `120000` (symlink) maps to
// `symlink_escape` and everything else to `invalid_tree`, so a caller can
// report the memo's reason without re-deriving the classification.
//
// FILE/DIRECTORY CONFLICTS. Every path here is checked in isolation, which is
// not enough for a TREE: `a` and `a/child.ts` are each a valid canonical path,
// and together they describe a tree no filesystem can materialize — `a` cannot
// be both a regular file and another entry's parent directory. `ancestorConflict`
// is that whole-set rule; `ancestorConflictAt` is the one-path form a projector
// uses against the files it already knows about.

import { isWellFormedString } from "../../mutation/protocol-v3/canonical.js";
import type { Reason } from "./field-checks.js";
import type { CanonicalPath, GitMode } from "./types-core.js";
import type { ShadowUnavailableReason } from "./types-outcome.js";

export const MAX_PATH_BYTES = 4096;
export const MAX_PATH_COMPONENT_BYTES = 255; // POSIX NAME_MAX
export const ADMITTED_MODES: readonly GitMode[] = ["100644", "100755"];
const SYMLINK_MODE = "120000";

function utf8(value: string): Buffer {
	return Buffer.from(value, "utf8");
}

/** null when the path is a valid canonical path, else the specific reason. */
export function checkCanonicalPath(value: unknown, where: string): Reason {
	if (typeof value !== "string" || value.length === 0) return `${where} must be a non-empty string`;
	if (!isWellFormedString(value)) return `${where} must be valid UTF-8 (no lone surrogates)`;
	if (value.includes("\0")) return `${where} must not contain a NUL byte`;
	if (value.includes("\\")) return `${where} must use POSIX separators, not backslashes`;
	if (value.startsWith("/")) return `${where} must be repo-relative, not absolute`;
	const bytes = utf8(value).length;
	if (bytes > MAX_PATH_BYTES) return `${where} exceeds ${MAX_PATH_BYTES} bytes`;
	return checkSegments(value.split("/"), where);
}

function checkSegments(segments: readonly string[], where: string): Reason {
	for (const segment of segments) {
		if (segment.length === 0) return `${where} must not contain an empty segment`;
		if (segment === "." || segment === "..") return `${where} must not contain a "${segment}" segment`;
		if (utf8(segment).length > MAX_PATH_COMPONENT_BYTES) {
			return `${where} has a component over ${MAX_PATH_COMPONENT_BYTES} bytes`;
		}
	}
	return null;
}

/** Mint a branded path or THROW — never a silent fallback, so an invalid
 *  path cannot enter a hash grammar through a construction helper. */
export function asCanonicalPath(value: string): CanonicalPath {
	const reason = checkCanonicalPath(value, "path");
	if (reason !== null) throw new Error(`invalid canonical path: ${reason}`);
	// SAFETY: the brand is minted only after checkCanonicalPath accepted the
	// value, which is the whole definition of CanonicalPath.
	return value as CanonicalPath;
}

export function checkGitMode(value: unknown, where: string): Reason {
	// SAFETY: widening a readonly GitMode[] to string[] for a membership test
	// on untrusted input; no value flows back out of the comparison.
	return typeof value === "string" && (ADMITTED_MODES as readonly string[]).includes(value)
		? null
		: `${where} must be one of: ${ADMITTED_MODES.join(", ")}`;
}

/** The memo's reason for a mode this protocol refuses, or null when the mode
 *  is admitted. Symlinks are their own reason because they are the escape
 *  hazard, not merely an unsupported shape (memo §12.3). */
export function modeRejectionReason(mode: string): ShadowUnavailableReason | null {
	// SAFETY: membership test only — the widened array is never returned.
	if ((ADMITTED_MODES as readonly string[]).includes(mode)) return null;
	return mode === SYMLINK_MODE ? "symlink_escape" : "invalid_tree";
}

/** Bytewise UTF-8 comparison — the ONE ordering the grammars use. */
export function comparePathBytes(a: string, b: string): number {
	return Buffer.compare(utf8(a), utf8(b));
}

/** Stable sort of records by their path bytes, ascending. */
export function sortByPathBytes<T>(items: readonly T[], pathOf: (item: T) => string): T[] {
	return [...items].sort((a, b) => comparePathBytes(pathOf(a), pathOf(b)));
}

/** The nearest proper ancestor of `path` that `present` carries, or null.
 *  Walks shortest prefix first, so the pair a caller reports is the outermost
 *  file involved. `/` is ASCII and can never appear inside a multi-byte UTF-8
 *  sequence, so slicing at its index is byte-exact for any canonical path. */
function firstPresentAncestor(path: string, present: ReadonlySet<string>): string | null {
	for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) {
		const prefix = path.slice(0, at);
		if (present.has(prefix)) return prefix;
	}
	return null;
}

/** The first `[ancestor, descendant]` pair where `ancestor ‖ "/"` prefixes
 *  `descendant` — one entry is a regular file AND another entry's parent
 *  directory, which no tree can materialize. `null` when the set is a possible
 *  tree.
 *
 *  BYTEWISE, no normalization: the boundary is the `/` byte, so `a` and `a.ts`
 *  are siblings (a prefix WITHOUT the separator is not a conflict) and `A`
 *  never collides with `a/b`. "First" is over the paths in bytewise order with
 *  each path's ancestors walked outermost-first, so the reported pair does not
 *  depend on input order. O(n log n) for the sort, then linear in path bytes. */
export function ancestorConflict(paths: readonly string[]): readonly [string, string] | null {
	const present = new Set(paths);
	for (const path of sortByPathBytes(paths, (value) => value)) {
		const ancestor = firstPresentAncestor(path, present);
		if (ancestor !== null) return [ancestor, path];
	}
	return null;
}

/** The conflict ONE path has against a set of paths known to hold regular
 *  files: an ancestor of it that is a file, or the bytewise-first file under
 *  it. A path the set does not carry says NOTHING — the caller never looked
 *  there, and a whole-set validator (`computeTreeHash`, `applyPostImages`)
 *  owns that proof over the materialized tree. */
export function ancestorConflictAt(path: string, files: Iterable<string>): readonly [string, string] | null {
	const present = new Set(files);
	const ancestor = firstPresentAncestor(path, present);
	if (ancestor !== null) return [ancestor, path];
	const under = `${path}/`;
	const descendant = sortByPathBytes([...present].filter((other) => other.startsWith(under)), (value) => value)[0];
	return descendant === undefined ? null : [path, descendant];
}

/** The ONE sentence every surface reports a file/directory conflict with. */
export function fileDirectoryConflictDetail(pair: readonly [string, string]): string {
	const [ancestor, descendant] = pair;
	return `file/directory conflict: ${ancestor} is a file and an ancestor of ${descendant}`;
}

/** True when no two items share a path — the structural rule that makes
 *  record order unambiguous (memo §12.2, "PostImageSet structural rules"). */
export function duplicatePath<T>(items: readonly T[], pathOf: (item: T) => string): string | null {
	const seen = new Set<string>();
	for (const item of items) {
		const path = pathOf(item);
		if (seen.has(path)) return path;
		seen.add(path);
	}
	return null;
}
