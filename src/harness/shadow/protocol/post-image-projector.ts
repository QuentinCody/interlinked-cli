// ===========================================
// Shadow protocol v1 — the STRICT post-image projector (memo §5.1, §8.1)
// ===========================================
// Given a normalized tool input and the PRE-image of the paths it touches,
// produce the exact `PostImageEntryV1` records the edit would leave behind —
// `W` with the resulting bytes, `D` for a deletion, a rename as `D` source +
// `W` destination carrying the moved content at the DESTINATION's own mode
// (`applyMoveTo` carries the transcription and the reason).
//
// NEVER APPROXIMATE. The whole point of Plan 00's exit gate is that the
// remote tree is the local tree; a projection that guesses produces a
// confidently wrong `post_tree_hash`. So every input whose result is not
// exactly determined — an `old_string` that does not occur, one that occurs
// more than once without `replace_all`, a MultiEdit whose Nth edit no longer
// applies, an `apply_patch` whose context does not match, a path whose mode
// v0 refuses — returns a rejection carrying the memo's reason, and the caller
// reports `shadow: unavailable`.
//
// The projector keeps a running draft of the touched files, so a multi-section
// patch sees its own earlier sections (create-then-delete leaves NO record,
// per the content-identity table in §8.0) and a MultiEdit's edit N sees the
// result of edit N−1.
//
// ONLY AN EXPLICIT NULL PROVES ABSENCE. The pre-image map is the caller's
// statement of what it checked: `null` says "I looked, and the path is not
// there"; a path that is simply not in the map was never looked at. Treating
// the second as the first turned an unchecked Write into a confident "new
// file" — so every path an operation touches (Write / Edit / MultiEdit target,
// Add / Delete / Update target, Move source AND destination) must be in the
// map, or the projection rejects with `missing_pre_image: <path>`.
//
// A REGULAR FILE IS NOT A DIRECTORY. Each path the projector handles is
// individually canonical, which says nothing about the SET: a pre-image
// carrying the file `src/a.ts` plus an explicit null for `src/a.ts/child.ts`
// describes a tree no filesystem can hold. `writeFile` refuses a write whose
// conflict the draft can already prove; the full-tree validators own the rest
// (see the note there).

import {
	ancestorConflictAt,
	asCanonicalPath,
	checkCanonicalPath,
	fileDirectoryConflictDetail,
	modeRejectionReason,
	sortByPathBytes,
} from "./path-rules.js";
import { addSectionContent, applyPatchHunksStrict, checkPatchEnvelope, trimPatchTrailer } from "./post-image-patch.js";
import type { PatchHunkFailureV1 } from "./post-image-patch.js";
import { parseStrictPatchSections } from "./post-image-sections.js";
import type { AddSectionV1, DeleteSectionV1, StrictPatchSectionV1, UpdateSectionV1 } from "./post-image-sections.js";
import { blobDigestOf, byteLengthOf } from "./post-image-apply.js";
import type { ShadowTreeFileV1 } from "./post-image-apply.js";
import type { GitMode, MultiEditEntryV1, NormalizedToolInputV1, PostImageEntryV1 } from "./types-core.js";
import type { ShadowUnavailableReason } from "./types-outcome.js";

const NEW_FILE_MODE: GitMode = "100644";

/** A pre-image entry: the bytes plus the mode to preserve. A bare string is
 *  shorthand for a regular file; `null` means "absent locally". */
export interface PreImageFileV1 {
	readonly mode: string;
	readonly content: string;
}
export type PreImageInputV1 = string | PreImageFileV1 | null;
export type PreImageMapV1 = ReadonlyMap<string, PreImageInputV1>;

/** The record plus the bytes it names — the entry itself carries only the
 *  digest and the byte length, so the caller needs the content to stage or
 *  apply it. `content` is null for a `D`. */
export interface ProjectedPostImageV1 {
	readonly entry: PostImageEntryV1;
	readonly content: string | null;
}

/** The memo's reasons a projection can fail with. */
export type ProjectionRejectionReasonV1 = Extract<
	ShadowUnavailableReason,
	"projection" | "invalid_tree" | "symlink_escape"
>;
export interface ProjectionRejectionV1 {
	ok: false;
	reason: ProjectionRejectionReasonV1;
	detail: string;
}
export type ProjectionResultV1 = { ok: true; images: readonly ProjectedPostImageV1[] } | ProjectionRejectionV1;

function fail(reason: ProjectionRejectionReasonV1, detail: string): ProjectionRejectionV1 {
	return { ok: false, reason, detail };
}

// ── the running draft ──────────────────────────────────────────────────────
interface Draft {
	/** The pre-image, so a `D` is emitted only for a path that existed. */
	readonly base: ReadonlyMap<string, ShadowTreeFileV1>;
	readonly files: Map<string, ShadowTreeFileV1>;
	/** Paths this input wrote or removed — the only candidates for a record. */
	readonly touched: Set<string>;
	/** Paths whose state is KNOWN: every key of the pre-image map (a file or
	 *  an explicit null), plus every path an earlier section of this same
	 *  input wrote or removed. Anything else has no pre-image. */
	readonly known: Set<string>;
}

/** A write, or the reason the draft cannot hold one at this path. A regular
 *  file cannot also be another entry's parent directory, so writing under a
 *  known file — or writing a file that known entries already sit under — is a
 *  projection error rather than a tree.
 *
 *  Only `draft.files` is consulted, which is the caller's own statement of
 *  what it looked at. When an ancestor's state is UNKNOWN (never in the
 *  pre-image map) this says nothing and allows the write: guessing "there is
 *  probably a directory there" is the approximation this projector exists to
 *  refuse. The FULL-tree validators own that proof — `applyPostImages` and
 *  `computeTreeHash` re-run the same rule over the materialized tree, where
 *  every entry's state is known by construction. */
function writeFile(draft: Draft, path: string, file: ShadowTreeFileV1): ProjectionRejectionV1 | null {
	const conflict = ancestorConflictAt(path, draft.files.keys());
	if (conflict !== null) return fail("projection", fileDirectoryConflictDetail(conflict));
	draft.files.set(path, file);
	draft.touched.add(path);
	draft.known.add(path);
	return null;
}

function removeFile(draft: Draft, path: string): void {
	draft.files.delete(path);
	draft.touched.add(path);
	draft.known.add(path);
}

/** The rejection for a path the caller never stated a pre-image for. */
function requireKnown(draft: Draft, path: string): ProjectionRejectionV1 | null {
	return draft.known.has(path) ? null : fail("projection", `missing_pre_image: ${path}`);
}

// ── entry point ────────────────────────────────────────────────────────────
export function projectPostImages(input: NormalizedToolInputV1, pre: PreImageMapV1): ProjectionResultV1 {
	const base = new Map<string, ShadowTreeFileV1>();
	for (const [path, value] of pre) {
		const admitted = admitPreImage(path, value, base);
		if (admitted !== null) return admitted;
	}
	const draft: Draft = { base, files: new Map(base), touched: new Set(), known: new Set(pre.keys()) };
	const failure = projectOperationIntoDraft(input, draft);
	return failure ?? { ok: true, images: recordsOf(draft) };
}

/** Adds one pre-image entry to `base`; returns a rejection when v0 refuses its
 *  mode (symlink → `symlink_escape`, anything else → `invalid_tree`). */
function admitPreImage(
	path: string,
	value: PreImageInputV1,
	base: Map<string, ShadowTreeFileV1>,
): ProjectionRejectionV1 | null {
	if (value === null) return null;
	const file: PreImageFileV1 = typeof value === "string" ? { mode: NEW_FILE_MODE, content: value } : value;
	const rejected = modeRejectionReason(file.mode);
	if (rejected === "symlink_escape" || rejected === "invalid_tree") {
		return fail(rejected, `${path} has mode ${file.mode}, which shadow v0 refuses`);
	}
	// SAFETY: modeRejectionReason returned null, which is the definition of an
	// admitted GitMode (`100644` / `100755`).
	base.set(path, { mode: file.mode as GitMode, content: file.content });
	return null;
}

/** Dispatch on the tool the client used: each operation has exactly one
 *  projection rule, and no rule may fall back to an approximation. */
function projectOperationIntoDraft(input: NormalizedToolInputV1, draft: Draft): ProjectionRejectionV1 | null {
	switch (input.tool) {
		case "Write":
			return applyWrite(draft, input.file_path, input.content);
		case "Edit":
			return applyEdit(draft, { path: input.file_path, label: "Edit" }, input);
		case "MultiEdit":
			return applyMultiEdit(draft, input.file_path, input.edits);
		case "apply_patch":
			return applyPatch(draft, input.patch);
	}
}

// ── Edit / MultiEdit ───────────────────────────────────────────────────────
/** `label` names the operation in a rejection — "Edit", or "edit N" for the
 *  Nth entry of a MultiEdit, so a caller can see WHICH edit stopped applying. */
interface EditTargetV1 {
	readonly path: string;
	readonly label: string;
}

/** A Write over a known path keeps that path's mode; over an explicit null
 *  it creates a 100644 file. */
function applyWrite(draft: Draft, path: string, content: string): ProjectionRejectionV1 | null {
	const missing = requireKnown(draft, path);
	if (missing !== null) return missing;
	return writeFile(draft, path, { mode: draft.files.get(path)?.mode ?? NEW_FILE_MODE, content });
}

function applyEdit(draft: Draft, target: EditTargetV1, edit: MultiEditEntryV1): ProjectionRejectionV1 | null {
	const { path, label } = target;
	const missing = requireKnown(draft, path);
	if (missing !== null) return missing;
	const file = draft.files.get(path);
	if (file === undefined) return fail("projection", `${label}: ${path} is absent locally — there is nothing to edit`);
	const replaced = replaceOccurrences(file.content, edit);
	if (!replaced.ok) return fail("projection", `${label} on ${path}: ${replaced.detail}`);
	return writeFile(draft, path, { mode: file.mode, content: replaced.content });
}

function applyMultiEdit(
	draft: Draft,
	path: string,
	edits: readonly MultiEditEntryV1[],
): ProjectionRejectionV1 | null {
	const missing = requireKnown(draft, path);
	if (missing !== null) return missing;
	if (edits.length === 0) return fail("projection", `MultiEdit on ${path} carries no edit`);
	for (const [index, edit] of edits.entries()) {
		const failure = applyEdit(draft, { path, label: `edit ${index + 1}` }, edit);
		if (failure !== null) return failure;
	}
	return null;
}

type ReplacementV1 = { ok: true; content: string } | { ok: false; detail: string };

/** Exactly-determined replacement, or the reason it is not. Splices by index
 *  rather than `String.replace`, so `$&` / `$1` in `new_string` are literal. */
function replaceOccurrences(source: string, edit: MultiEditEntryV1): ReplacementV1 {
	const target = edit.old_string;
	if (target === "") return { ok: false, detail: "old_string is empty — the insertion point is undetermined" };
	// An edit that replaces a string with itself is refused, not projected as an
	// unchanged W: Claude Code's own Edit tool answers that call with "old_string
	// and new_string are exactly the same", so no such write ever reaches disk
	// locally and a W record for it would claim a local apply that never happens.
	// The reference oracle refuses it too (`shadow-projection-oracle.mts`).
	if (edit.new_string === target) return { ok: false, detail: "identical_edit_strings" };
	const count = countOccurrences(source, target);
	if (count === 0) return { ok: false, detail: "old_string not found in the pre-image" };
	if (count > 1 && !edit.replace_all) {
		return { ok: false, detail: `old_string occurs ${count} times without replace_all — the projection is ambiguous` };
	}
	if (edit.replace_all) return { ok: true, content: source.split(target).join(edit.new_string) };
	const at = source.indexOf(target);
	return { ok: true, content: source.slice(0, at) + edit.new_string + source.slice(at + target.length) };
}

function countOccurrences(source: string, target: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const at = source.indexOf(target, from);
		if (at < 0) return count;
		count += 1;
		from = at + target.length;
	}
}

// ── apply_patch ────────────────────────────────────────────────────────────
function applyPatch(draft: Draft, patch: string): ProjectionRejectionV1 | null {
	// The envelope is checked BEFORE any section is interpreted: a truncated
	// payload's surviving sections project cleanly, so projecting them at all
	// would make a truncated patch indistinguishable from a complete one.
	const envelope = checkPatchEnvelope(patch);
	if (envelope !== null) return fail("projection", `apply_patch envelope is incomplete: ${envelope}`);
	// STRICT sections, not `apply-patch-content.ts`'s: that parser is the
	// tolerant one PostToolUse warnings use — it drops an unknown directive,
	// ignores a Delete body, and lets `*** Move to:` retarget an Add or a
	// Delete. Each of those is a payload the local apply reads differently.
	const parsed = parseStrictPatchSections(trimPatchTrailer(patch).split("\n").slice(1, -1));
	if (!parsed.ok) return fail("projection", sectionFailureDetail(parsed.code));
	for (const section of parsed.sections) {
		const failure = applySection(draft, section);
		if (failure !== null) return failure;
	}
	return null;
}

/** `empty_patch` keeps its long-standing sentence; every other class names
 *  its code, so the corpus can pin the grammar rule that refused. */
function sectionFailureDetail(code: string): string {
	if (code === "empty_patch") return "apply_patch carries no file section (empty_patch)";
	return `apply_patch sections are not exactly determined: ${code}`;
}

function applySection(draft: Draft, section: StrictPatchSectionV1): ProjectionRejectionV1 | null {
	if (section.op === "add") return applyAddSection(draft, section);
	if (section.op === "delete") return applyDeleteSection(draft, section);
	return applyUpdateSection(draft, section);
}

/** Path rule first (a non-canonical path is `invalid_tree` whatever the map
 *  says), then the pre-image rule: the path must be KNOWN. */
function pathRejection(draft: Draft, path: string): ProjectionRejectionV1 | null {
	const reason = checkCanonicalPath(path, `apply_patch path "${path}"`);
	if (reason !== null) return fail("invalid_tree", reason);
	return requireKnown(draft, path);
}

function applyAddSection(draft: Draft, section: AddSectionV1): ProjectionRejectionV1 | null {
	const badPath = pathRejection(draft, section.path);
	if (badPath !== null) return badPath;
	if (draft.files.has(section.path)) {
		return fail("projection", `apply_patch adds ${section.path}, which already exists locally`);
	}
	// Codex appends a newline after EVERY `+` line, so one `+a` line is the two
	// bytes "a\n" and an Add with no body is the empty file — measured against
	// the real tool and transcribed from `streaming_parser.rs` (see the byte
	// note in `post-image-patch.ts`). The oracle applies the same rule.
	return writeFile(draft, section.path, { mode: NEW_FILE_MODE, content: addSectionContent(section.lines) });
}

function applyDeleteSection(draft: Draft, section: DeleteSectionV1): ProjectionRejectionV1 | null {
	const badPath = pathRejection(draft, section.path);
	if (badPath !== null) return badPath;
	if (!draft.files.has(section.path)) {
		return fail("projection", `apply_patch deletes ${section.path}, which is absent locally`);
	}
	removeFile(draft, section.path);
	return null;
}

/** An update, or — when `*** Move to:` names a destination — a move: `D` for
 *  the source, `W` for the destination. The source is checked before the
 *  destination, so a rejection names the path the patch itself named first. */
function applyUpdateSection(draft: Draft, section: UpdateSectionV1): ProjectionRejectionV1 | null {
	const source = section.path;
	const move = section.move_to;
	const badPath = pathRejection(draft, source) ?? (move === null ? null : pathRejection(draft, move));
	if (badPath !== null) return badPath;
	// Codex writes the destination and then removes the source, so a move onto
	// ITSELF writes the file and immediately unlinks it. That end state is a
	// deleted file whose bytes the patch just computed — a shape this protocol
	// makes no claim about, so it is refused rather than modelled.
	if (move === source) return fail("projection", `apply_patch moves ${source} onto itself, which shadow v0 makes no claim about`);
	const file = draft.files.get(source);
	if (file === undefined) return fail("projection", `apply_patch updates ${source}, which is absent locally`);
	// STRICT placement, not `reconstructAfterContent`: that reconstructor is
	// the tolerant one PostToolUse warnings use — it drops the `@@ <anchor>`
	// and takes the first structural match, which lands a hunk on the wrong
	// block and applies an ambiguous one (memo §5.1, §8.1).
	const after = applyPatchHunksStrict(file.content, section.body);
	if (!after.ok) return fail("projection", hunkFailureDetail(source, after.code));
	if (move === null) return writeFile(draft, source, { mode: file.mode, content: after.content });
	return applyMoveTo(draft, { source, destination: move, content: after.content });
}

interface MoveV1 {
	readonly source: string;
	readonly destination: string;
	readonly content: string;
}

/** The move half of an Update section, transcribed from Codex's `UpdateFile`
 *  arm (`codex-rs/apply-patch/src/lib.rs`, D34 — NOT memo §5.1, whose
 *  "destination keeps the source's mode" reading the lead has corrected).
 *
 *  Codex derives the new bytes from the SOURCE and then, in this order:
 *  `write_file_with_missing_parent_retry(dest)` — missing parents are created,
 *  but a destination lying under a FILE, or one that is itself a non-empty
 *  directory, fails the write and fails the whole section — and only then
 *  `remove(source)`. Two consequences this projector must not paper over:
 *
 *   1. THE DESTINATION IS JUDGED WITH THE SOURCE STILL PRESENT. `a.txt` moved
 *      to `a.txt/b.txt` fails natively, because `a.txt` is still a regular file
 *      when the destination write runs. Releasing the source first (what this
 *      module used to do) projected a clean `D` + `W` for a patch the tool
 *      refuses, so `writeFile` runs BEFORE `removeFile` and its file/directory
 *      rule sees the source.
 *   2. THE SOURCE'S MODE IS NEVER CARRIED. `write_file` rewrites bytes and
 *      never chmods, so a NEW destination is created at the default 100644 —
 *      the reviewer measured a 100755 source landing at 100644 — and an
 *      EXISTING destination is overwritten in place and keeps its OWN mode. */
function applyMoveTo(draft: Draft, move: MoveV1): ProjectionRejectionV1 | null {
	const mode = draft.files.get(move.destination)?.mode ?? NEW_FILE_MODE;
	const wrote = writeFile(draft, move.destination, { mode, content: move.content });
	if (wrote !== null) return wrote;
	removeFile(draft, move.source);
	return null;
}

/** The rejection text for one placement failure. `context_not_found` keeps its
 *  long-standing sentence; every other class names its code, so a caller can
 *  tell "the file moved on" from "the patch never named a site". */
function hunkFailureDetail(path: string, code: PatchHunkFailureV1): string {
	if (code === "context_not_found") return `apply_patch hunks for ${path} do not match its pre-image content`;
	return `apply_patch hunks for ${path} name no single site: ${code}`;
}

// ── records ────────────────────────────────────────────────────────────────
/** One record per TOUCHED path whose end state differs from absence-by-never-
 *  existing: present → `W`, gone-but-was-there → `D`, created-then-deleted →
 *  no record at all. Sorted by path bytes, the grammars' one ordering. */
function recordsOf(draft: Draft): readonly ProjectedPostImageV1[] {
	const images: ProjectedPostImageV1[] = [];
	for (const path of draft.touched) {
		const file = draft.files.get(path);
		if (file !== undefined) images.push(writeRecord(path, file));
		else if (draft.base.has(path)) images.push({ entry: { tag: "D", path: asCanonicalPath(path) }, content: null });
	}
	return sortByPathBytes(images, (image) => image.entry.path);
}

function writeRecord(path: string, file: ShadowTreeFileV1): ProjectedPostImageV1 {
	return {
		entry: {
			tag: "W",
			path: asCanonicalPath(path),
			mode: file.mode,
			blob_digest: blobDigestOf(file.content),
			bytes: byteLengthOf(file.content),
		},
		content: file.content,
	};
}
