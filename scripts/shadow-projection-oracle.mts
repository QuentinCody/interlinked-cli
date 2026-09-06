// ===========================================
// Shadow projection ORACLE — a second, deliberately naive implementation
// ===========================================
// This file is NOT the product. It exists so `protocol/shadow-v1/fixtures/`
// records a result some OTHER implementation produced: the generator computes
// every expected value here and then asserts the product package agrees. A
// corpus whose expectations came from the code under test can only detect
// later drift; it can never establish that the first answer was right.
//
// Written from `docs/design/remote-shadow-execution.md` — §2 (overlay and
// post-image records), §5.1 (the `shadow-tree-v1` / `shadow-postimages-v1` /
// `shadow-overlay-v1` byte grammars), §8.0 (content identity) — plus the
// documented client semantics of Write / Edit / MultiEdit / apply_patch.
// Deliberately naive: string split/join, `node:crypto` sha-256, a sorted
// concatenation. No import from `src/harness/shadow/protocol/` — two
// implementations that agree because one was copied from the other are one
// implementation.
//
// Where the memo is silent the oracle takes the strict reading and says so in
// a comment; a disagreement with the product is then a question for the memo,
// not a bug to paper over.
//
// ONE EXCEPTION, added 2026-09-05: apply_patch BYTE semantics are not the
// memo's to decide — they are whatever the Codex tool writes. Both this oracle
// and the product transcribe `codex-rs/apply-patch` (`streaming_parser.rs` for
// Add, `file_update.rs` for Update, default `NormalizeToLf` mode), and the
// review measured the real tool to settle it. Two implementations that agree
// on a rule they both read from the same source are still two implementations
// of the arithmetic around it — which is the part this file exists to check.

import { createHash } from "node:crypto";
// The V4A hunk-placement half of this oracle, split into a sibling module
// 2026-09-05 when the file reached the 500-line cap. It is the SAME oracle —
// a second reading of `codex-rs/apply-patch`, importing nothing from
// `src/harness/shadow/protocol/` — and it carries its own labeled cases in
// `shadow-projection-oracle-hunks.test.mts`.
import { oracleApplyHunks } from "./shadow-projection-oracle-hunks.mjs";

export type OracleMode = "100644" | "100755";
export interface OracleFile {
	mode: OracleMode;
	content: string;
}
/** §5.1 tagged record: `W` writes bytes, `D` deletes a path. */
export type OracleRecord = { tag: "W"; path: string; mode: OracleMode; content: string } | { tag: "D"; path: string };
export type OracleResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface OracleEdit {
	old_string: string;
	new_string: string;
	replace_all: boolean;
}
/** Structurally the memo's `NormalizedToolInputV1` closed union. */
export type OracleToolInput =
	| { tool: "Write"; file_path: string; content: string }
	| { tool: "Edit"; file_path: string; old_string: string; new_string: string; replace_all: boolean }
	| { tool: "MultiEdit"; file_path: string; edits: readonly OracleEdit[] }
	| { tool: "apply_patch"; patch: string };

function ok<T>(value: T): OracleResult<T> {
	return { ok: true, value };
}
function err<T>(reason: string): OracleResult<T> {
	return { ok: false, reason };
}

// ── bytes ──────────────────────────────────────────────────────────────────

export function oracleBlobDigest(content: string): string {
	return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}
export function oracleByteLength(content: string): number {
	return Buffer.byteLength(content, "utf8");
}
function digestBytes(content: string): Buffer {
	return createHash("sha256").update(Buffer.from(content, "utf8")).digest();
}

// ── canonical structures (memo I5) ─────────────────────────────────────────
// "One canonical profile": every hashed or signed STRUCTURE is the sha-256 of
// its canonical JSON — keys sorted lexicographically at every depth, no
// whitespace. The memo names the profile and the records it covers; the
// naive rendering below is enough for the flat, ASCII-keyed records the
// corpus hashes (`DependencyTreeCacheRecordV1`), and the generator asserts
// the product's digest agrees before any row records it.

function compareKeys(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

function oracleCanonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(oracleCanonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).filter(([, item]) => item !== undefined);
		entries.sort(([left], [right]) => compareKeys(left, right));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${oracleCanonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/** The canonical-JSON rendering a mismatch record carries as `expected` /
 *  `measured` (memo §8.0: values travel as canonical JSON). */
export function oracleCanonicalValue(value: unknown): string {
	return oracleCanonicalJson(value);
}

/** H(canonical(record)) — `cache_record_hash` and every other structure hash. */
export function oracleCanonicalDigest(value: unknown): string {
	return createHash("sha256").update(Buffer.from(oracleCanonicalJson(value), "utf8")).digest("hex");
}

/** §5.1 rejections: not valid UTF-8, a `..` segment, a leading `/`. A NUL
 *  cannot appear because the grammar terminates the path with one, and an
 *  empty or `.` segment is not a repo-relative POSIX path. */
export function oraclePathProblem(path: string): string | null {
	if (path.length === 0) return "empty_path";
	if (path.startsWith("/")) return "absolute_path";
	if (path.includes("\0")) return "nul_in_path";
	if (Buffer.from(path, "utf8").toString("utf8") !== path) return "invalid_utf8_path";
	for (const segment of path.split("/")) {
		if (segment === "") return "empty_segment";
		if (segment === "." || segment === "..") return "dot_segment";
	}
	return null;
}
function entryProblem(path: string, mode: string): string | null {
	if (mode !== "100644" && mode !== "100755") return "rejected_mode";
	return oraclePathProblem(path);
}

/** A regular file cannot also be another entry's parent directory, so a set
 *  holding both `a` and `a/b.ts` describes a tree no filesystem can hold.
 *  Naive O(n²) pair scan over the raw path bytes: the `/` is the boundary, so
 *  `a` and `a.ts` are siblings, not a conflict. This is the oracle — the
 *  product's version is the fast one. */
function oracleFileDirConflict(paths: readonly string[]): boolean {
	for (const ancestor of paths) {
		for (const descendant of paths) {
			if (descendant.startsWith(`${ancestor}/`)) return true;
		}
	}
	return false;
}

/** The paths a state map says hold a file right now — a `null` is "absent". */
function presentPaths(state: ReadonlyMap<string, OracleFile | null>): string[] {
	return [...state.entries()].flatMap(([path, file]) => (file === null ? [] : [path]));
}

/** True when writing `path` would collide with a file the state already knows
 *  about, in either direction. A path the state does not carry says nothing:
 *  the oracle never invents a pre-image it was not given, so the whole-tree
 *  check in `oracleTreeHash` / `oracleApply` is what proves the rest. */
function conflictsWithState(path: string, state: ReadonlyMap<string, OracleFile | null>): boolean {
	return presentPaths(state).some((other) => other !== path && oracleFileDirConflict([other, path]));
}

interface HashRow {
	key: Buffer;
	bytes: Buffer;
}
/** Records sorted by `path_bytes` ascending, bytewise; concatenated with no
 *  separator; sha-256, lowercase hex. A repeated path is not representable. */
function hashRows(rows: HashRow[]): string | null {
	rows.sort((left, right) => Buffer.compare(left.key, right.key));
	const digest = createHash("sha256");
	let previous: Buffer | null = null;
	for (const row of rows) {
		if (previous !== null && Buffer.compare(previous, row.key) === 0) return null;
		previous = row.key;
		digest.update(row.bytes);
	}
	return digest.digest("hex");
}

/** `shadow-tree-v1`: `mode ‖ 0x20 ‖ path ‖ 0x00 ‖ digest32`. */
export function oracleTreeHash(files: ReadonlyMap<string, OracleFile>): OracleResult<string> {
	const rows: HashRow[] = [];
	for (const [path, file] of files) {
		const problem = entryProblem(path, file.mode);
		if (problem !== null) return err(problem);
		const key = Buffer.from(path, "utf8");
		rows.push({ key, bytes: Buffer.concat([Buffer.from(`${file.mode} `, "ascii"), key, Buffer.from([0]), digestBytes(file.content)]) });
	}
	// A FULL tree must be materializable, so no entry may be both a file and
	// another entry's parent directory. The tagged grammar below deliberately
	// does NOT check: a partial set that deletes `a` and writes `a/b.ts` is a
	// legal transition, and only the tree it lands on has to be possible.
	if (oracleFileDirConflict([...files.keys()])) return err("file_dir_conflict");
	const hash = hashRows(rows);
	return hash === null ? err("duplicate_path") : ok(hash);
}

/** `shadow-postimages-v1` / `shadow-overlay-v1` (one grammar, two ids):
 *  `tag ‖ 0x20 ‖ mode ‖ 0x20 ‖ path ‖ 0x00 ‖ digest32`, with `D` carrying
 *  mode `000000` and 32 zero bytes. */
export function oracleTaggedHash(records: readonly OracleRecord[]): OracleResult<string> {
	const rows: HashRow[] = [];
	for (const record of records) {
		const problem = record.tag === "W" ? entryProblem(record.path, record.mode) : oraclePathProblem(record.path);
		if (problem !== null) return err(problem);
		const key = Buffer.from(record.path, "utf8");
		const mode = record.tag === "W" ? record.mode : "000000";
		const digest = record.tag === "W" ? digestBytes(record.content) : Buffer.alloc(32);
		rows.push({ key, bytes: Buffer.concat([Buffer.from(`${record.tag} ${mode} `, "ascii"), key, Buffer.from([0]), digest]) });
	}
	const hash = hashRows(rows);
	return hash === null ? err("duplicate_path") : ok(hash);
}

/** §5.1: the materializer applies the set literally — `W` writes, `D`
 *  unlinks, and a `D` for a path absent in the pre-tree is a projection
 *  error, not a no-op. */
export function oracleApply(base: ReadonlyMap<string, OracleFile>, records: readonly OracleRecord[]): OracleResult<Map<string, OracleFile>> {
	const tree = new Map(base);
	for (const record of records) {
		if (record.tag === "D") {
			if (!tree.has(record.path)) return err("delete_of_absent_path");
			tree.delete(record.path);
			continue;
		}
		tree.set(record.path, { mode: record.mode, content: record.content });
	}
	// The END STATE must be a possible tree — checked once, after the whole
	// set, because the order inside a set is not a filesystem's order.
	if (oracleFileDirConflict([...tree.keys()])) return err("file_dir_conflict");
	return ok(tree);
}

/** Sorted bytewise, like every other path list in the grammar. */
export function oracleTouchedPaths(records: readonly OracleRecord[]): string[] {
	const paths = [...new Set(records.map((record) => record.path))];
	paths.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
	return paths;
}

// ── projection ─────────────────────────────────────────────────────────────

/** Claude Code Edit semantics: the target must exist, `old_string` must be
 *  present, and a non-`replace_all` edit whose `old_string` occurs more than
 *  once is ambiguous and is refused rather than guessed at. */
function applyEdit(content: string, edit: OracleEdit): OracleResult<string> {
	if (edit.old_string === "") return err("empty_old_string");
	if (edit.old_string === edit.new_string) return err("no_op_edit");
	const first = content.indexOf(edit.old_string);
	if (first < 0) return err("old_string_not_found");
	const second = content.indexOf(edit.old_string, first + edit.old_string.length);
	if (second >= 0 && !edit.replace_all) return err("ambiguous_old_string");
	if (edit.replace_all) return ok(content.split(edit.old_string).join(edit.new_string));
	return ok(content.slice(0, first) + edit.new_string + content.slice(first + edit.old_string.length));
}

/** `pre` maps every path the call touches to its pre-image, or to `null` for
 *  "absent". A path missing from the map is not "absent" — the projector is
 *  strict and never approximates a pre-image it was not given. */
export function oracleProject(input: OracleToolInput, pre: ReadonlyMap<string, OracleFile | null>): OracleResult<OracleRecord[]> {
	if (input.tool === "apply_patch") return projectApplyPatch(input.patch, pre);
	const current = pre.get(input.file_path);
	if (current === undefined) return err("missing_pre_image");
	// A regular file cannot also be a parent directory: writing `a/child.ts`
	// when the map says `a` is a file describes an impossible tree.
	if (conflictsWithState(input.file_path, pre)) return err("file_dir_conflict");
	// A Write over an existing path keeps that path's mode; a new file is
	// 100644 (the only mode a client can create through a content write).
	if (input.tool === "Write") return ok([{ tag: "W", path: input.file_path, mode: current?.mode ?? "100644", content: input.content }]);
	if (current === null) return err("target_missing");
	const edits: readonly OracleEdit[] = input.tool === "Edit" ? [input] : input.edits;
	if (edits.length === 0) return err("no_edits");
	let content = current.content;
	for (const edit of edits) {
		// MultiEdit is sequential: edit n applies to the RESULT of edit n-1.
		const next = applyEdit(content, edit);
		if (!next.ok) return err(next.reason);
		content = next.value;
	}
	return ok([{ tag: "W", path: input.file_path, mode: current.mode, content }]);
}

interface PatchSection {
	header: string;
	body: string[];
}
const MOVE_MARKER = "*** Move to: ";

function splitSections(patch: string): OracleResult<PatchSection[]> {
	const lines = patch.split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (lines[0] !== "*** Begin Patch") return err("missing_begin_marker");
	if (lines[lines.length - 1] !== "*** End Patch") return err("missing_end_marker");
	const sections: PatchSection[] = [];
	for (const line of lines.slice(1, -1)) {
		if (line.startsWith("*** ") && !line.startsWith(MOVE_MARKER)) {
			sections.push({ header: line, body: [] });
			continue;
		}
		const current = sections[sections.length - 1];
		if (current === undefined) return err("body_before_section");
		current.body.push(line);
	}
	return sections.length === 0 ? err("empty_patch") : ok(sections);
}

function afterPrefix(line: string, prefix: string): string | null {
	return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

/** The evolving file state a patch's sections are applied to: the pre-images,
 *  then whatever each section did. `null` is "absent". */
type PatchState = Map<string, OracleFile | null>;

/** A post-image set is the DIFF between the pre-images and the state the whole
 *  patch leaves behind — not a log of its sections. That is what makes
 *  create-then-delete collapse to the no-op identity (memo §8.0). */
function diffRecords(pre: ReadonlyMap<string, OracleFile | null>, state: PatchState): OracleRecord[] {
	const records: OracleRecord[] = [];
	for (const [path, after] of state) {
		const before = pre.get(path) ?? null;
		if (after === null) {
			if (before !== null) records.push({ tag: "D", path });
			continue;
		}
		if (before !== null && before.mode === after.mode && before.content === after.content) continue;
		records.push({ tag: "W", path, mode: after.mode, content: after.content });
	}
	return records;
}

function projectApplyPatch(patch: string, pre: ReadonlyMap<string, OracleFile | null>): OracleResult<OracleRecord[]> {
	const sections = splitSections(patch);
	if (!sections.ok) return err(sections.reason);
	const state: PatchState = new Map(pre);
	for (const section of sections.value) {
		const applied = applySection(section, state);
		if (!applied.ok) return err(applied.reason);
	}
	return ok(diffRecords(pre, state));
}

function applySection(section: PatchSection, state: PatchState): OracleResult<null> {
	const added = afterPrefix(section.header, "*** Add File: ");
	if (added !== null) return applyAdd(added, section.body, state);
	const deleted = afterPrefix(section.header, "*** Delete File: ");
	if (deleted !== null) return applyDelete(deleted, section.body, state);
	const updated = afterPrefix(section.header, "*** Update File: ");
	if (updated !== null) return applyUpdate(updated, section.body, state);
	return err("unknown_section_header");
}

function applyAdd(path: string, body: readonly string[], state: PatchState): OracleResult<null> {
	const existing = state.get(path);
	if (existing === undefined) return err("missing_pre_image");
	if (existing !== null) return err("add_of_existing_path");
	for (const line of body) {
		if (!line.startsWith("+")) return err("malformed_add_body");
	}
	if (conflictsWithState(path, state)) return err("file_dir_conflict");
	// Codex writes each `+` line FOLLOWED BY its own newline
	// (`codex-rs/apply-patch/src/streaming_parser.rs`, the AddFile arm:
	// `contents.push_str(line); contents.push('\n')`). So `+a` alone is the
	// two bytes "a\n" and an Add with no `+` line is the empty file. An
	// earlier reading joined with "\n" and produced one byte too few; the
	// reviewer measured the real tool to settle it.
	state.set(path, { mode: "100644", content: body.map((line) => `${line.slice(1)}\n`).join("") });
	return ok(null);
}

function applyDelete(path: string, body: readonly string[], state: PatchState): OracleResult<null> {
	const existing = state.get(path);
	if (existing === undefined) return err("missing_pre_image");
	if (existing === null) return err("delete_of_absent_path");
	if (body.length > 0) return err("delete_section_has_body");
	state.set(path, null);
	return ok(null);
}
/** §5.1: a rename is a `D` for the source paired with a `W` for the
 *  destination carrying the moved content. A destination that already exists
 *  is NOT a collision in this grammar — the destination still carries exactly
 *  one record (a `W`), and applying the set literally overwrites it, which is
 *  what the client does locally. Only a path carrying TWO records would be
 *  unrepresentable.
 *
 *  ORDER AND MODE ARE THE TOOL'S, NOT THE MEMO'S (`codex-rs/apply-patch`'s
 *  `lib.rs`, the `Hunk::UpdateFile` arm; the same exception this file's header
 *  records for the Add/Update byte rules). Codex writes the DESTINATION FIRST
 *  and removes the source afterwards, so:
 *   - the destination write is judged while the source is still a file, which
 *     is why `a.txt` moved to `a.txt/b.txt` fails natively;
 *   - `write_file` never chmods, so a new destination is created at the
 *     default 100644 and an existing one keeps its own mode. The source's mode
 *     is never carried across.
 *  A move onto the SAME path writes and then unlinks it; that is a shape this
 *  protocol makes no claim about, so it is refused. */
function applyUpdate(path: string, body: readonly string[], state: PatchState): OracleResult<null> {
	const source = state.get(path);
	if (source === undefined) return err("missing_pre_image");
	if (source === null) return err("update_of_absent_path");
	const first = body[0] ?? "";
	const moveTo = first.startsWith(MOVE_MARKER) ? first.slice(MOVE_MARKER.length) : null;
	const applied = oracleApplyHunks(source.content, moveTo === null ? body : body.slice(1));
	if (!applied.ok) return err(applied.reason);
	if (moveTo === null) {
		if (conflictsWithState(path, state)) return err("file_dir_conflict");
		state.set(path, { mode: source.mode, content: applied.value });
		return ok(null);
	}
	if (moveTo === path) return err("move_onto_self");
	const destination = state.get(moveTo);
	if (destination === undefined) return err("missing_pre_image");
	if (conflictsWithState(moveTo, state)) return err("file_dir_conflict");
	state.set(moveTo, { mode: destination === null ? "100644" : destination.mode, content: applied.value });
	state.set(path, null);
	return ok(null);
}
