// ===========================================
// Shadow protocol v1 — STRICT V4A placement for the post-image projector
// ===========================================
// `src/harness/apply-patch-content.ts` reconstructs the same payload for a
// PostToolUse WARNING, so it is deliberately tolerant: it discards the
// `@@ <anchor>` header, takes the FIRST structural match of a hunk, and
// accepts a payload with no `*** End Patch`. Those readings are correct for a
// warning and wrong here. This module mints the bytes the projector hashes
// into `post_tree_hash`, and an executor is BOUND to that hash (memo §5.1), so
// a placement the local apply would not produce is a confident lie about a
// different workspace. Hence memo §8.1: the projector is strict and never
// approximates.
//
// Three rules, each of which the tolerant module breaks:
//  1. A hunk header carrying text NAMES the site. The single line whose
//     trimmed text equals it starts the search; 0 matches or 2+ matches refuse.
//  2. The context+deletion block must match EXACTLY ONE site in the search
//     region. 0 refuses, and so does 2+ — two sites do not name a site.
//  3. The envelope must open with `*** Begin Patch` and its last non-empty
//     line must be `*** End Patch`. Without the terminator a TRUNCATED patch
//     is indistinguishable from a complete one: the sections that arrived
//     project cleanly and the ones that did not are silently absent.
//
// EVERY HUNK IS MATCHED AGAINST THE ORIGINAL LINES, NEVER AGAINST THE RESULT
// OF ITS PREDECESSOR (`file_update.rs::compute_replacements`, D34). Codex walks
// the popped ORIGINAL lines once with a forward cursor `line_index`, collects
// `(start, old_len, new_lines)` replacements, sorts them by `start`, and only
// then applies them in DESCENDING order (`apply_replacements`). Nothing between
// two hunks is ever mutated, so a hunk can only ever see the pre-image. The
// consequences are the whole reason this module was rewritten:
//   - DEPENDENT hunks are refused. `-alpha/+bravo` followed by `-bravo/+charlie`
//     against `alpha\nomega\n` finds no `bravo` in the ORIGINAL and refuses —
//     the reviewer measured the real tool answering "Failed to find expected
//     lines … bravo". Applying hunk 2 to hunk 1's output produced `charlie` and
//     was a confident lie about a tree the local apply never lands on.
//   - REVERSED and OVERLAPPING hunks are refused, because the cursor only moves
//     forward: a site at or before the previous hunk's end is not searched.
//   - Two ORDINARY ordered hunks both apply, each against the original bytes.
// The `-` and ` ` lines of a hunk are Codex's `old_lines`, the `+` and ` ` lines
// its `new_lines`, and a bare line is a context line whose leading space the
// transport dropped (`streaming_parser.rs`: blank => `push_context_line("")`).
//
// TWO CODEX FALLBACKS STAY UNPORTED, both of which cost availability and never
// correctness (D33, D34). (1) The retry that drops a pattern's trailing empty
// line before searching again: a second reading cannot say which reading the
// local apply used. (2) `*** End of File`, which sets `is_end_of_file` and
// makes `seek_sequence` start at `len - pattern.len()`: the strict SECTION
// grammar already refuses that directive as `unknown_section_header`, so a
// patch carrying one is `shadow: unavailable` and never a guessed placement.
// The four-rung fuzzy match ladder (`seek_sequence.rs`) is likewise unported —
// see the `apply-patch-update-crlf-rejects` corpus row.
//
// THE BYTES ARE CODEX'S, NOT A PLAUSIBLE READING OF THEM. `post_tree_hash`
// binds an executor to exact bytes, so the newline rules are transcribed from
// the tool that produces them (`codex-rs/apply-patch`, default
// `ApplyPatchFileUpdateMode::NormalizeToLf`), not inferred from the V4A text:
//   - Add   (`streaming_parser.rs`, the `AddFile` arm): for every `+` line,
//     `contents.push_str(line); contents.push('\n')`. So `+a` alone is the two
//     bytes `a\n`, `+a` `+b` is `a\nb\n`, and an Add with no `+` line at all is
//     the empty file — `AddFile { contents: String::new() }`.
//   - Update (`file_update.rs::derive_new_contents_from_chunks`): split on
//     `\n`, pop ONE trailing empty element, match and replace over THOSE
//     lines, push one empty element back if the last is not empty, join with
//     `\n`. Consequences, all mirrored below: an updated file always ends in
//     exactly one `\n`, a file with no final newline GAINS one, `a\n\n`
//     collapses to `a\n`, and a file left with no lines is `""`, not `"\n"`.
// (An earlier reading of this module claimed "the V4A body cannot encode a
// trailing newline". It was false — the newline is not encoded in the body at
// all, it is appended by the reader.)

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
/** The three prefixes a hunk body line may carry: context, deletion, addition. */
const HUNK_PREFIXES = " -+";

/** Why the V4A envelope is not a complete patch. */
export type PatchEnvelopeFailureV1 = "missing_begin_marker" | "missing_end_marker";

/** Why a hunk has no exactly-determined placement. Each value is the detail
 *  text a rejection carries, so a caller can tell the classes apart. */
export type PatchHunkFailureV1 =
	| "hunk_body_before_marker"
	| "malformed_hunk_line"
	| "update_without_hunk"
	| "hunk_without_context_or_deletion"
	| "anchor_not_found"
	| "ambiguous_anchor"
	| "context_not_found"
	| "ambiguous_context";

export type PatchHunkResultV1 = { ok: true; content: string } | { ok: false; code: PatchHunkFailureV1 };

/** The payload's lines with trailing blank lines dropped. Interior blank lines
 *  are hunk context and are kept. */
function envelopeLines(patch: string): string[] {
	const lines = patch.split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** `null` when the payload is a complete envelope. Trailing blank lines are
 *  tolerated — a transport that appends a newline has not truncated anything. */
export function checkPatchEnvelope(patch: string): PatchEnvelopeFailureV1 | null {
	const lines = envelopeLines(patch);
	if (lines[0] !== BEGIN_MARKER) return "missing_begin_marker";
	if (lines[lines.length - 1] !== END_MARKER) return "missing_end_marker";
	return null;
}

/** The payload cut back to its envelope. The section parser accumulates any
 *  line that is not a `*** ` directive into the CURRENT section's body, so a
 *  blank line after `*** End Patch` would otherwise arrive as a context line
 *  of the last hunk and defeat its match. */
export function trimPatchTrailer(patch: string): string {
	return envelopeLines(patch).join("\n");
}

/** An `*** Add File:` section's bytes: every `+` line plus its own newline
 *  (`streaming_parser.rs`). Zero lines is the empty file, not `"\n"`. */
export function addSectionContent(lines: readonly string[]): string {
	return lines.map((line) => `${line}\n`).join("");
}

/** Codex's `NormalizeToLf` line split: `split('\n')`, then ONE trailing empty
 *  element popped so a final newline reads as a terminator rather than as a
 *  phantom last line. The hunk matcher therefore never sees that empty line —
 *  a hunk whose block ends in one matches nothing here and is refused. Codex
 *  retries such a pattern without its trailing element; this projector does
 *  not, because a retry is a second reading, and a placement the local apply
 *  might not reproduce is exactly what §8.1 forbids. */
function splitForUpdate(before: string): string[] {
	const lines = before.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** The inverse: push one empty element back when the last is not empty, then
 *  join with `\n`. So an updated file ends in exactly one `\n`, a file that
 *  had none gains one, `a\n\n` collapses to `a\n`, and a file left with no
 *  lines joins to `""`. */
function joinAfterUpdate(lines: readonly string[]): string {
	const out = [...lines];
	if (out[out.length - 1] !== "") out.push("");
	return out.join("\n");
}

interface StrictHunkV1 {
	/** The `@@` header's text, trimmed; `""` for a bare `@@`. */
	readonly anchor: string;
	readonly body: string[];
}
type SplitResultV1 = { ok: true; hunks: readonly StrictHunkV1[] } | { ok: false; code: PatchHunkFailureV1 };

/** Apply one `*** Update File:` section's body lines to its pre-image content.
 *  The section header, `*** Move to:` and the envelope markers are consumed by
 *  the section parser before this point, so `body` is `@@` headers and their
 *  ` ` / `-` / `+` lines only.
 *
 *  Two phases, exactly as Codex has them: EVERY hunk is placed against the
 *  original lines with a forward cursor (`computeReplacements`), and only then
 *  are the recorded replacements applied back-to-front (`applyReplacements`).
 *  A hunk therefore never sees another hunk's output. */
export function applyPatchHunksStrict(before: string, body: readonly string[]): PatchHunkResultV1 {
	const split = splitStrictHunks(body);
	if (!split.ok) return split;
	const lines = splitForUpdate(before);
	const computed = computeReplacements(lines, split.hunks);
	if (!computed.ok) return computed;
	return { ok: true, content: joinAfterUpdate(applyReplacements(lines, computed.replacements)) };
}

/** Body → hunks. A line before the first `@@` is refused rather than treated
 *  as an implicit hunk: an implicit hunk carries no anchor and no header, so
 *  its placement was never stated. */
function splitStrictHunks(body: readonly string[]): SplitResultV1 {
	const hunks: StrictHunkV1[] = [];
	for (const line of body) {
		// The native grammar (`codex-rs/apply-patch/src/parser.rs`) knows exactly
		// two header spellings: the bare `@@` (EMPTY_CHANGE_CONTEXT_MARKER) and
		// `@@ ` + context (CHANGE_CONTEXT_MARKER). `@@anchor` is neither — the
		// tool refuses it ("Unexpected line found in update hunk", session review
		// r2 finding 3, measured live) — so it is a malformed hunk line here too,
		// never a header with an implied space.
		if (line === "@@" || line.startsWith("@@ ")) {
			hunks.push({ anchor: line.slice(2).trim(), body: [] });
			continue;
		}
		// A line that is neither a header nor a ` `/`-`/`+` line is malformed
		// wherever it sits — the tool's "Unexpected line found in update hunk" —
		// so that verdict is decided before "is there a hunk to belong to".
		if (line !== "" && !HUNK_PREFIXES.includes(line.slice(0, 1))) return { ok: false, code: "malformed_hunk_line" };
		const current = hunks[hunks.length - 1];
		if (current === undefined) return { ok: false, code: "hunk_body_before_marker" };
		current.body.push(line);
	}
	return hunks.length === 0 ? { ok: false, code: "update_without_hunk" } : { ok: true, hunks };
}

/** A bare blank line is context whose leading space the transport dropped. */
function stripPrefix(line: string): string {
	return line === "" ? "" : line.slice(1);
}

type IndexResultV1 = { ok: true; from: number } | { ok: false; code: PatchHunkFailureV1 };

/** Where the search for the hunk's block starts: the line AFTER the single
 *  line the anchor names, or the CURSOR itself for a bare `@@`.
 *
 *  Scoped to `[cursor, end)`, mirroring `seek_sequence(…, start = line_index)`:
 *  a hunk may only name a site at or after the previous hunk's end, so an
 *  anchor that occurs solely above the cursor is `anchor_not_found` rather than
 *  a wrap-around. Codex takes the FIRST match at or after `start`; this module
 *  refuses when the region holds two, because our one comparison is Codex's
 *  TRIMMED rung and a trimmed tie does not name a site. */
function anchorIndex(lines: readonly string[], anchor: string, cursor: number): IndexResultV1 {
	if (anchor === "") return { ok: true, from: cursor };
	const hits: number[] = [];
	for (let index = cursor; index < lines.length; index += 1) {
		if (lines[index]?.trim() === anchor) hits.push(index);
	}
	if (hits.length === 0) return { ok: false, code: "anchor_not_found" };
	if (hits.length > 1) return { ok: false, code: "ambiguous_anchor" };
	return { ok: true, from: (hits[0] ?? 0) + 1 };
}

function matchesAt(lines: readonly string[], block: readonly string[], at: number): boolean {
	return block.every((line, offset) => lines[at + offset] === line);
}

/** Every site in `lines` at or after `from` where `block` matches. */
function matchSites(lines: readonly string[], block: readonly string[], from: number): number[] {
	const hits: number[] = [];
	for (let at = from; at + block.length <= lines.length; at += 1) {
		if (matchesAt(lines, block, at)) hits.push(at);
	}
	return hits;
}

/** Codex's `Replacement` tuple: remove `oldLen` lines at `start`, insert
 *  `newLines` there. Recorded against the ORIGINAL lines and applied later. */
interface ReplacementV1 {
	readonly start: number;
	readonly oldLen: number;
	readonly newLines: readonly string[];
}
type PlacementResultV1 =
	| { ok: true; replacement: ReplacementV1; cursor: number }
	| { ok: false; code: PatchHunkFailureV1 };
type ReplacementsResultV1 =
	| { ok: true; replacements: readonly ReplacementV1[] }
	| { ok: false; code: PatchHunkFailureV1 };

/** Where a pure insertion lands. Codex ignores the anchor entirely here and
 *  appends at the END of the popped original lines — `len`, or `len - 1` when
 *  the last popped line is itself empty (the shape a `…\n\n` pre-image leaves).
 *  Deterministic, so it is mirrored rather than refused. */
function endOfFileInsertionIndex(lines: readonly string[]): number {
	return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** One hunk against the ORIGINAL lines, searching only at or after `cursor`.
 *  The block must occur EXACTLY once in that region: zero is
 *  `context_not_found`, and more than one is refused rather than resolved to
 *  the first — guessing here produces a post-image the local apply does not.
 *
 *  A hunk with no old lines is a pure insertion and goes to EOF; one with no
 *  old AND no new lines is refused, matching Codex's parser, which rejects an
 *  empty chunk outright ("Update hunk does not contain any lines"). The anchor
 *  is resolved FIRST in both cases, exactly as `compute_replacements` does, so
 *  an unfindable anchor refuses even a hunk that would have gone to EOF. */
function placeHunk(lines: readonly string[], hunk: StrictHunkV1, cursor: number): PlacementResultV1 {
	const start = anchorIndex(lines, hunk.anchor, cursor);
	if (!start.ok) return start;
	const block = hunk.body.filter((line) => !line.startsWith("+")).map(stripPrefix);
	const newLines = hunk.body.filter((line) => !line.startsWith("-")).map(stripPrefix);
	if (block.length === 0) {
		if (newLines.length === 0) return { ok: false, code: "hunk_without_context_or_deletion" };
		// Codex `continue`s here, so the cursor keeps whatever the anchor set.
		return { ok: true, replacement: { start: endOfFileInsertionIndex(lines), oldLen: 0, newLines }, cursor: start.from };
	}
	const hits = matchSites(lines, block, start.from);
	if (hits.length === 0) return { ok: false, code: "context_not_found" };
	if (hits.length > 1) return { ok: false, code: "ambiguous_context" };
	const at = hits[0] ?? 0;
	return { ok: true, replacement: { start: at, oldLen: block.length, newLines }, cursor: at + block.length };
}

/** `compute_replacements`: every hunk placed against the SAME original lines,
 *  in source order, behind a cursor that only moves forward. Sorted by start
 *  before returning, as Codex sorts before applying. */
function computeReplacements(lines: readonly string[], hunks: readonly StrictHunkV1[]): ReplacementsResultV1 {
	const replacements: ReplacementV1[] = [];
	let cursor = 0;
	for (const hunk of hunks) {
		const placed = placeHunk(lines, hunk, cursor);
		if (!placed.ok) return placed;
		replacements.push(placed.replacement);
		cursor = placed.cursor;
	}
	return { ok: true, replacements: [...replacements].sort((left, right) => left.start - right.start) };
}

/** `apply_replacements`: splice back-to-front, so an earlier replacement never
 *  shifts a later one's recorded index. Ties keep hunk order because the sort
 *  above is stable and this walk reverses it, which is what Codex's
 *  `replacements.iter().rev()` over a stable `sort_by_key` does. */
function applyReplacements(lines: readonly string[], replacements: readonly ReplacementV1[]): string[] {
	const out = [...lines];
	for (const replacement of [...replacements].reverse()) {
		out.splice(replacement.start, replacement.oldLen, ...replacement.newLines);
	}
	return out;
}
