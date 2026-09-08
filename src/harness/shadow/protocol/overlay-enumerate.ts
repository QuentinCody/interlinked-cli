// ===========================================
// Shadow protocol v1 — overlay ENUMERATION (memo §2 item 2, §5.1)
// ===========================================
// The overlay is a TREE DIFF, not a set of git-status categories: the final
// local filesystem tree MINUS `base_ref`'s tree. The local tree is the union
// of `git ls-files -z` (tracked), `git ls-files --others --exclude-standard
// -z` (ORDINARY untracked — a newly created `src/new.ts` the proposed edit
// imports is in the overlay, or the remote compile is fiction) and the
// manifest-selected ignored paths (§5.1 exact list; credential files never).
//
// It ships as the tagged `shadow-overlay-v1` grammar because a partial set
// over a base tree cannot express deletion by absence:
//   W  the local bytes for a path whose (mode, digest) differs from the base
//   D  a path that exists in the base tree and is absent locally
// A base-file rename is `D old` + `W new`; a file created locally and then
// renamed is just `W new`; create-then-delete produces no record; a `D` for
// a path NOT in the base tree is `invalid_tree` (§5.1, explicit).
//
// THE DENY DECISION IS OWNED HERE, NOT BY THE CALLER (§5.1, "Excluded
// unconditionally, and not overridable by the manifest"). This module takes
// the overlay MANIFEST and RAW candidate paths, then applies the
// broker-owned `SHADOW_OVERLAY_DENY_V1` ruleset and the manifest's include
// selection itself, deny first. A caller cannot widen what travels by
// pre-classifying its inputs, and a manifest that names `config.local.json`
// explicitly still does not carry it. The manifest is canonicalized HERE
// (rather than accepted as already-canonical plus a hash to re-verify)
// because canonicalization is the same total function either way, and doing
// it inside removes the caller's chance to hand in a manifest whose rules
// were never validated at all.
//
// `enumerateOverlay` is PURE over injected inputs — no `child_process`, no
// `fs` — so the diff rules are testable without a repo. The shell boundary is
// the one small `collectLocalTreeInputs` adapter at the bottom of this file,
// which takes an injected `runGit` returning RAW BYTES: a git path is a byte
// string, and decoding it leniently would turn a non-UTF-8 path into U+FFFD
// before the memo's "any path that is not valid UTF-8" rule could reject it.
// The `-z` form is required precisely because paths contain spaces and
// newlines.

import { checkSafeNonNegInt, checkSha256Hex, firstReason, type Reason } from "./field-checks.js";
import { canonicalizeOverlayManifest, isDeniedOverlayPath, selectOverlayPaths } from "./overlay-manifest.js";
import {
	asCanonicalPath,
	checkCanonicalPath,
	comparePathBytes,
	duplicatePath,
	modeRejectionReason,
	sortByPathBytes,
} from "./path-rules.js";
import type { BlobDigest, GitMode, OverlayEntryV1, OverlayIncludeRuleV1, OverlayManifestV1 } from "./types-core.js";
import type { ShadowUnavailableReason } from "./types-outcome.js";

/** How many gitignored candidates the scoped discovery scan will consider
 *  before refusing. The manifest is an allowlist over a bounded set of state
 *  files; a scan returning more than this has escaped its roots
 *  (`reference-repos/`, `node_modules/`), and truncating would silently drop
 *  load-bearing state instead of reporting the problem. */
export const MAX_IGNORED_CANDIDATES = 4096;

// ── inputs ─────────────────────────────────────────────────────────────────

/** One local file, as the enumerator receives it: unbranded, untrusted. */
export interface LocalTreeEntryV1 {
	readonly path: string;
	readonly mode: string;
	readonly blob_digest: string;
	readonly bytes: number;
}

/** One base-tree file, from the mirror. Bytes are not needed: the base tree
 *  participates only in the (mode, digest) equality test. */
export interface BaseTreeEntryV1 {
	readonly mode: string;
	readonly blob_digest: string;
}

export interface EnumerateOverlayInput {
	readonly baseTree: ReadonlyMap<string, BaseTreeEntryV1>;
	/** Canonicalized HERE. Governs only which IGNORED candidates travel — it
	 *  can never admit a denied path, and never affects tracked files. */
	readonly manifest: OverlayManifestV1;
	readonly localTracked: readonly LocalTreeEntryV1[];
	readonly localUntracked: readonly LocalTreeEntryV1[];
	/** RAW gitignored candidates — NOT pre-selected. Selection happens here. */
	readonly ignoredCandidates: readonly LocalTreeEntryV1[];
}

export interface OverlayRejection {
	readonly reason: ShadowUnavailableReason;
	readonly detail: string;
}

export type EnumerateOverlayResult =
	| { readonly ok: true; readonly entries: readonly OverlayEntryV1[] }
	| ({ readonly ok: false } & OverlayRejection);

function fail(reason: ShadowUnavailableReason, detail: string): { ok: false } & OverlayRejection {
	return { ok: false, reason, detail };
}

function manifestRejection(reason: string, detail: string): { ok: false } & OverlayRejection {
	return fail("invalid_tree", `overlay manifest refused (${reason}): ${detail}`);
}

// ── per-entry admission ────────────────────────────────────────────────────

/** The mode check is separate from the rest because the memo gives symlinks
 *  their OWN reason (`symlink_escape`) — they are the escape hazard, not
 *  merely an unsupported shape. */
function checkMode(mode: string, where: string): OverlayRejection | null {
	const reason = modeRejectionReason(mode);
	if (reason === null) return null;
	return { reason, detail: `${where} has refused mode ${mode}` };
}

function checkLocalEntry(entry: LocalTreeEntryV1): OverlayRejection | null {
	const where = `overlay entry ${JSON.stringify(entry.path)}`;
	const pathReason = checkCanonicalPath(entry.path, where);
	if (pathReason !== null) return { reason: "invalid_tree", detail: pathReason };
	const modeRejection = checkMode(entry.mode, where);
	if (modeRejection !== null) return modeRejection;
	const rest: Reason = firstReason(
		checkSha256Hex(entry.blob_digest, `${where}.blob_digest`),
		checkSafeNonNegInt(entry.bytes, `${where}.bytes`),
	);
	return rest === null ? null : { reason: "invalid_tree", detail: rest };
}

function checkBaseEntry(path: string, entry: BaseTreeEntryV1): OverlayRejection | null {
	const where = `base tree entry ${JSON.stringify(path)}`;
	const pathReason = checkCanonicalPath(path, where);
	if (pathReason !== null) return { reason: "invalid_tree", detail: pathReason };
	const modeRejection = checkMode(entry.mode, where);
	if (modeRejection !== null) return modeRejection;
	const digestReason = checkSha256Hex(entry.blob_digest, `${where}.blob_digest`);
	return digestReason === null ? null : { reason: "invalid_tree", detail: digestReason };
}

// ── the diff ───────────────────────────────────────────────────────────────

function writeRecord(entry: LocalTreeEntryV1): OverlayEntryV1 {
	return {
		tag: "W",
		path: asCanonicalPath(entry.path),
		// SAFETY: checkLocalEntry ran modeRejectionReason on this value and
		// admitted it, which is exactly the GitMode membership test.
		mode: entry.mode as GitMode,
		// SAFETY: checkLocalEntry ran checkSha256Hex on this value; the brand
		// records the purpose (a blob digest), not an extra runtime shape.
		blob_digest: entry.blob_digest as BlobDigest,
		bytes: entry.bytes,
	};
}

/** True when the local file is byte- and mode-identical to the base tree, so
 *  the mirror already carries it and no record is needed. */
function matchesBase(entry: LocalTreeEntryV1, base: BaseTreeEntryV1 | undefined): boolean {
	return base !== undefined && base.mode === entry.mode && base.blob_digest === entry.blob_digest;
}

/** The ignored candidates the manifest admits. `selectOverlayPaths` applies
 *  the broker deny ruleset FIRST, so a denied path never reaches `included`
 *  however the manifest names it. */
function selectIgnored(manifest: OverlayManifestV1, candidates: readonly LocalTreeEntryV1[]): LocalTreeEntryV1[] {
	const selection = selectOverlayPaths(
		manifest,
		candidates.map((entry) => entry.path),
	);
	const included = new Set(selection.included);
	return candidates.filter((entry) => included.has(entry.path));
}

function collectLocalEntries(input: EnumerateOverlayInput, manifest: OverlayManifestV1): LocalTreeEntryV1[] {
	const workspace = [...input.localTracked, ...input.localUntracked].filter(
		(entry) => !isDeniedOverlayPath(entry.path),
	);
	return [...workspace, ...selectIgnored(manifest, input.ignoredCandidates)];
}

function admitLocalEntries(entries: readonly LocalTreeEntryV1[]): OverlayRejection | null {
	for (const entry of entries) {
		const rejection = checkLocalEntry(entry);
		if (rejection !== null) return rejection;
	}
	const duplicate = duplicatePath(entries, (entry) => entry.path);
	if (duplicate !== null) {
		return { reason: "invalid_tree", detail: `duplicate local path ${JSON.stringify(duplicate)}` };
	}
	return null;
}

function admitBaseTree(baseTree: ReadonlyMap<string, BaseTreeEntryV1>): OverlayRejection | null {
	for (const [path, entry] of baseTree) {
		const rejection = checkBaseEntry(path, entry);
		if (rejection !== null) return rejection;
	}
	return null;
}

function deletionRecords(
	baseTree: ReadonlyMap<string, BaseTreeEntryV1>,
	localPaths: ReadonlySet<string>,
): OverlayEntryV1[] {
	const records: OverlayEntryV1[] = [];
	for (const path of baseTree.keys()) {
		if (localPaths.has(path) || isDeniedOverlayPath(path)) continue;
		records.push({ tag: "D", path: asCanonicalPath(path) });
	}
	return records;
}

function diffRecords(
	input: EnumerateOverlayInput,
	locals: readonly LocalTreeEntryV1[],
): readonly OverlayEntryV1[] {
	const writes = locals
		.filter((entry) => !matchesBase(entry, input.baseTree.get(entry.path)))
		.map((entry) => writeRecord(entry));
	const localPaths = new Set(locals.map((entry) => entry.path));
	const deletions = deletionRecords(input.baseTree, localPaths);
	return sortByPathBytes([...writes, ...deletions], (entry) => entry.path);
}

/**
 * The final local tree minus the base tree, as `shadow-overlay-v1` records.
 * Pure: every input is injected, so no repo is needed to exercise the rules.
 * The deny ruleset and the manifest selection are applied INTERNALLY.
 */
export function enumerateOverlay(input: EnumerateOverlayInput): EnumerateOverlayResult {
	const canonical = canonicalizeOverlayManifest(input.manifest);
	if (!canonical.ok) return manifestRejection(canonical.reason, canonical.detail);
	const locals = collectLocalEntries(input, canonical.manifest);
	const localRejection = admitLocalEntries(locals);
	if (localRejection !== null) return fail(localRejection.reason, localRejection.detail);
	const baseRejection = admitBaseTree(input.baseTree);
	if (baseRejection !== null) return fail(baseRejection.reason, baseRejection.detail);
	const entries = diffRecords(input, locals);
	const invalid = validateOverlayEntries(entries, input.baseTree);
	if (invalid !== null) return fail(invalid.reason, invalid.detail);
	return { ok: true, entries };
}

// ── shipped-set invariants ─────────────────────────────────────────────────

function checkDeletionsAgainstBase(
	entries: readonly OverlayEntryV1[],
	baseTree: ReadonlyMap<string, BaseTreeEntryV1>,
): OverlayRejection | null {
	for (const entry of entries) {
		if (entry.tag !== "D" || baseTree.has(entry.path)) continue;
		return {
			reason: "invalid_tree",
			detail: `overlay D record for ${JSON.stringify(entry.path)} names a path absent from the base tree`,
		};
	}
	return null;
}

function checkOrder(entries: readonly OverlayEntryV1[]): OverlayRejection | null {
	for (let i = 1; i < entries.length; i += 1) {
		const previous = entries[i - 1];
		const current = entries[i];
		if (previous === undefined || current === undefined) continue;
		if (comparePathBytes(previous.path, current.path) > 0) {
			return {
				reason: "invalid_tree",
				detail: `overlay records out of byte order at ${JSON.stringify(current.path)}`,
			};
		}
	}
	return null;
}

/** The deny ruleset again, on the SHIPPED set — the last gate before the
 *  bytes leave. Broker-owned: there is no caller-supplied deny list to get
 *  wrong. */
function checkDenied(entries: readonly OverlayEntryV1[]): OverlayRejection | null {
	for (const entry of entries) {
		if (!isDeniedOverlayPath(entry.path)) continue;
		return { reason: "invalid_tree", detail: `denied path ${JSON.stringify(entry.path)} must never travel` };
	}
	return null;
}

/**
 * Validate a shipped overlay set — the invariants the materializer relies on:
 * every `D` names a base-tree path, no path repeats, records are in byte
 * order, and no path the broker deny ruleset covers is present. Returns null
 * when the set is legal.
 */
export function validateOverlayEntries(
	entries: readonly OverlayEntryV1[],
	baseTree: ReadonlyMap<string, BaseTreeEntryV1>,
): OverlayRejection | null {
	const duplicate = duplicatePath(entries, (entry) => entry.path);
	if (duplicate !== null) {
		return { reason: "invalid_tree", detail: `duplicate overlay path ${JSON.stringify(duplicate)}` };
	}
	return checkDeletionsAgainstBase(entries, baseTree) ?? checkOrder(entries) ?? checkDenied(entries);
}

// ── the git adapter (the ONE shell boundary) ───────────────────────────────

/** `runGit` returns the command's RAW stdout bytes. Never a string: decoding
 *  belongs to `parseNulSeparated`, which decodes fatally. */
export type GitBytesRunner = (args: readonly string[]) => Uint8Array;

export interface LocalPathSetsV1 {
	readonly tracked: readonly string[];
	readonly untracked: readonly string[];
	readonly ignoredCandidates: readonly string[];
}

export type LocalPathSetsResult =
	| { readonly ok: true; readonly sets: LocalPathSetsV1 }
	| ({ readonly ok: false } & OverlayRejection);

export type NulSplitResult =
	| { readonly ok: true; readonly paths: readonly string[] }
	| { readonly ok: false; readonly detail: string };

const WILDCARD = /[*?[]/;

/** The NUL-delimited byte runs, terminators dropped. Never splits on a
 *  newline: a path may contain one, which is why git has a `-z` form. */
function splitNulBytes(output: Uint8Array): Uint8Array[] {
	const slices: Uint8Array[] = [];
	let start = 0;
	for (let index = 0; index <= output.length; index += 1) {
		if (index < output.length && output[index] !== 0) continue;
		if (index > start) slices.push(output.subarray(start, index));
		start = index + 1;
	}
	return slices;
}

/** One path's bytes as a string, or null when they are not valid UTF-8. The
 *  decoder is FATAL: a lenient one would substitute U+FFFD and destroy the
 *  evidence the memo's "not valid UTF-8" rejection needs. */
function decodeStrictUtf8(slice: Uint8Array): string | null {
	try {
		// `ignoreBOM: true` is stated, not defaulted, for two reasons: a leading
		// U+FEFF in a git PATH is bytes the path carries and must survive decoding
		// (stripping it would silently rename the file), and the Workers type
		// library requires the flag explicitly — a contract-portability finding
		// from compiling the vendored copy in interlinked-cloud (2026-09-04).
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(slice);
	} catch {
		return null;
	}
}

/**
 * Split `-z` output on the NUL BYTE and decode each path fatally. An
 * undecodable path is REFUSED, never replaced — the memo rejects "any path
 * that is not valid UTF-8" (§5.1), and JSON transport cannot carry arbitrary
 * path bytes anyway.
 */
export function parseNulSeparated(output: Uint8Array): NulSplitResult {
	const paths: string[] = [];
	for (const slice of splitNulBytes(output)) {
		const decoded = decodeStrictUtf8(slice);
		if (decoded === null) return { ok: false, detail: `a ${slice.length}-byte git path is not valid UTF-8` };
		paths.push(decoded);
	}
	return { ok: true, paths };
}

/** The literal leading segments of a pattern — where the ignored scan may
 *  start walking. Empty when the first segment is a wildcard. */
function literalPrefix(anchored: string): string[] {
	const literal: string[] = [];
	for (const segment of anchored.split("/")) {
		if (segment.length === 0 || WILDCARD.test(segment)) break;
		literal.push(segment);
	}
	return literal;
}

/** The pathspec one include rule needs the ignored scan to walk. An exact
 *  rule is its own pathspec; a pattern contributes its literal prefix. A rule
 *  that can match at any depth (a bare basename, or a leading wildcard)
 *  collapses to the repo root — narrowing it would drop paths the manifest
 *  legitimately names. */
function ruleRoot(rule: OverlayIncludeRuleV1): string {
	if (rule.kind === "exact") return rule.path;
	const core = rule.pattern.endsWith("/") ? rule.pattern.slice(0, -1) : rule.pattern;
	const anchored = core.startsWith("/") ? core.slice(1) : core;
	if (!anchored.includes("/")) return ".";
	const literal = literalPrefix(anchored);
	return literal.length === 0 ? "." : literal.join("/");
}

/** The bounded set of pathspecs the ignored scan walks, derived from the
 *  manifest's own rules. Exported so a caller can see (and a test can pin)
 *  exactly how wide the discovery is. */
export function overlayScanRoots(manifest: OverlayManifestV1): readonly string[] {
	const roots = new Set<string>();
	for (const rule of manifest.include_rules) roots.add(ruleRoot(rule));
	if (roots.has(".")) return ["."];
	return [...roots].sort(comparePathBytes);
}

/** How many scan roots the over-cap detail names verbatim. A legal manifest
 *  may carry 1024 rules of 4 KiB paths, so an unbounded `roots.join` could
 *  reach ~4 MB — under `outcome_record_bytes`, but a rejection reason is
 *  not the place to ship a manifest. The first roots plus a count is what a
 *  caller can act on. */
const MAX_ROOTS_IN_DETAIL = 8;

/** The over-cap detail is BOUNDED on both axes: it names the cap and at most
 *  `MAX_ROOTS_IN_DETAIL` of the roots that were walked (then "… and N more"),
 *  never the exact overflow count — a scan that escaped its roots can be in
 *  the tens of thousands, and reporting that number verbatim buys nothing a
 *  caller can act on. Only the roots and the cap tell a caller what to narrow. */
function overCapDetail(roots: readonly string[]): string {
	const shown = roots.slice(0, MAX_ROOTS_IN_DETAIL).join(", ");
	const rest = roots.length - MAX_ROOTS_IN_DETAIL;
	const listed = rest > 0 ? `${shown}, … and ${rest} more` : shown;
	return (
		`ignored candidate scan exceeds ${MAX_IGNORED_CANDIDATES} paths under roots [${listed}] ` +
		`(more than ${MAX_IGNORED_CANDIDATES} observed) — narrow the manifest's include rules ` +
		`(a broad gitwildmatch-v1 pattern over a gitignored directory walks its whole tree)`
	);
}

function collectIgnoredCandidates(runGit: GitBytesRunner, manifest: OverlayManifestV1): NulSplitResult {
	const roots = overlayScanRoots(manifest);
	const parsed = parseNulSeparated(
		// These are literal paths/prefixes already derived from manifest rules.
		// Git must not reinterpret filename bytes as glob or pathspec magic.
		runGit(["--literal-pathspecs", "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...roots]),
	);
	if (!parsed.ok) return parsed;
	if (parsed.paths.length > MAX_IGNORED_CANDIDATES) {
		return { ok: false, detail: overCapDetail(roots) };
	}
	return parsed;
}

/** The three enumeration commands, run in order against a canonical
 *  manifest. Split out so the public entry point holds only the manifest
 *  gate. */
function collectPathSets(runGit: GitBytesRunner, manifest: OverlayManifestV1): LocalPathSetsResult {
	const tracked = parseNulSeparated(runGit(["ls-files", "-z"]));
	if (!tracked.ok) return fail("invalid_tree", `tracked path: ${tracked.detail}`);
	const untracked = parseNulSeparated(runGit(["ls-files", "--others", "--exclude-standard", "-z"]));
	if (!untracked.ok) return fail("invalid_tree", `untracked path: ${untracked.detail}`);
	const ignored = collectIgnoredCandidates(runGit, manifest);
	if (!ignored.ok) return fail("invalid_tree", `ignored candidate: ${ignored.detail}`);
	return {
		ok: true,
		sets: { tracked: tracked.paths, untracked: untracked.paths, ignoredCandidates: ignored.paths },
	};
}

/**
 * The memo's two enumeration commands plus a manifest-scoped, BOUNDED scan
 * for gitignored candidates. `runGit` is injected so the shell boundary is
 * one tiny function and callers (and tests) never spawn git through this
 * module. Selection and denial are NOT done here — this returns raw
 * candidates for `enumerateOverlay` to decide on.
 */
export function collectLocalTreeInputs(runGit: GitBytesRunner, manifest: OverlayManifestV1): LocalPathSetsResult {
	const canonical = canonicalizeOverlayManifest(manifest);
	if (!canonical.ok) return manifestRejection(canonical.reason, canonical.detail);
	return collectPathSets(runGit, canonical.manifest);
}
