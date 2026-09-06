// ===========================================
// Shadow projection ORACLE — V4A hunk placement (the sibling of
// `shadow-projection-oracle.mts`, split out 2026-09-05 for the 500-line cap)
// ===========================================
// Same contract as the parent file: this is NOT the product. It is a second,
// deliberately naive reading of `codex-rs/apply-patch` used to compute the
// corpus's expected values, and the generator refuses to write a row the
// product package disagrees with. Nothing here imports
// `src/harness/shadow/protocol/`.
//
// The model is Codex's, transcribed from `file_update.rs` and
// `streaming_parser.rs` (D34):
//   - `NormalizeToLf` line split: `split('\n')`, pop ONE trailing empty
//     element, so a final newline reads as a terminator and not as a phantom
//     last line the hunks could match; the inverse on the way out.
//   - `compute_replacements`: walk the hunks in order behind a FORWARD-ONLY
//     cursor over the ORIGINAL lines, recording `(start, old_len, new_lines)`.
//     A `@@ <ctx>` header moves the cursor to the line after the anchor; a
//     hunk with no old lines is a pure insertion and goes to end-of-file
//     whatever the anchor said; anything else must match the context+deletion
//     block exactly once at or after the cursor.
//   - `apply_replacements`: sort by start, splice back-to-front.
// Because no line is mutated between hunks, a hunk can never match text an
// earlier hunk wrote. Dependent, reversed and overlapping hunk pairs are all
// refused, which is what the real tool does ("Failed to find expected lines").
//
// Where this oracle is deliberately STRICTER than Codex, and why: `seek_sequence`
// matches with a decreasing-strictness ladder (exact, `trim_end`, `trim`,
// Unicode punctuation) and takes the first hit; one comparison here refuses a
// tie instead. The retry that drops a pattern's trailing empty line and the
// `*** End of File` marker are likewise unported. All three cost availability
// (`shadow: unavailable`), never correctness.

export type OracleHunkResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function ok<T>(value: T): OracleHunkResult<T> {
	return { ok: true, value };
}
function err<T>(reason: string): OracleHunkResult<T> {
	return { ok: false, reason };
}

interface PatchHunk {
	anchor: string;
	body: string[];
}

/** `(start_index, old_len, new_lines)` — Codex's `Replacement` tuple. */
type OracleReplacement = [start: number, oldLen: number, newLines: string[]];
interface OraclePlacement {
	replacement: OracleReplacement;
	lineIndex: number;
}

function splitHunks(lines: readonly string[]): OracleHunkResult<PatchHunk[]> {
	const hunks: PatchHunk[] = [];
	for (const line of lines) {
		// Exactly the native grammar's two header spellings: bare `@@`, or `@@ `
		// plus context (parser.rs CHANGE_CONTEXT_MARKER). `@@anchor` is refused by
		// the tool as an unexpected hunk line (session review r2, finding 3).
		if (line === "@@" || line.startsWith("@@ ")) {
			hunks.push({ anchor: line.slice(2).trim(), body: [] });
			continue;
		}
		// Malformed wherever it sits (the tool's "Unexpected line found in update
		// hunk"), decided before "is there a hunk to belong to".
		if (line !== "" && !" -+".includes(line.slice(0, 1))) return err("malformed_hunk_line");
		const current = hunks[hunks.length - 1];
		if (current === undefined) return err("hunk_body_before_marker");
		current.body.push(line);
	}
	return hunks.length === 0 ? err("update_without_hunk") : ok(hunks);
}

/** Codex's default `NormalizeToLf` line model
 *  (`file_update.rs::derive_new_contents_from_chunks`): `split('\n')`, then pop
 *  ONE trailing empty element. */
function updateLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** The inverse: push one empty element back when the last is not empty, then
 *  join with `\n`. So an updated file ends in exactly one `\n`, a file with no
 *  final newline gains one, `a\n\n` collapses to `a\n`, and a file left with
 *  no lines is `""` — never `"\n"`. */
function updateContent(lines: readonly string[]): string {
	const out = [...lines];
	if (out[out.length - 1] !== "") out.push("");
	return out.join("\n");
}

function stripPrefix(line: string): string {
	return line === "" ? "" : line.slice(1);
}

/** Scoped to `[from, end)` — `seek_sequence(…, start = line_index)`. A bare
 *  `@@` leaves the cursor alone; Codex takes the first hit at or after it and
 *  this oracle refuses a tie, because one trimmed comparison cannot name a
 *  site two lines answer to. */
function anchorIndex(lines: readonly string[], anchor: string, from: number): OracleHunkResult<number> {
	if (anchor === "") return ok(from);
	const hits = lines.flatMap((line, index) => (index >= from && line.trim() === anchor ? [index] : []));
	if (hits.length === 0) return err("anchor_not_found");
	if (hits.length > 1) return err("ambiguous_anchor");
	return ok((hits[0] ?? 0) + 1);
}

function matchesAt(lines: readonly string[], block: readonly string[], at: number): boolean {
	return block.every((line, offset) => lines[at + offset] === line);
}

/** Where one hunk lands in the ORIGINAL lines, plus the cursor the next hunk
 *  starts from. The context+deletion block must occur EXACTLY once at or after
 *  the cursor: zero is `context_not_found`; more than one is ambiguous and is
 *  refused — a projector that guessed would produce a post-image the local
 *  apply does not, which is the one thing the binding must never allow.
 *
 *  A hunk with no `-`/context line is a pure insertion, which Codex appends at
 *  END OF FILE regardless of the anchor (`old_lines.is_empty()` branch; the
 *  index is `len`, or `len - 1` when the last popped line is empty) and which
 *  leaves the cursor where the anchor put it. A hunk with no line at all is
 *  refused, as Codex's parser refuses an empty chunk. */
function placeHunk(lines: readonly string[], hunk: PatchHunk, cursor: number): OracleHunkResult<OraclePlacement> {
	const from = anchorIndex(lines, hunk.anchor, cursor);
	if (!from.ok) return err(from.reason);
	const before = hunk.body.filter((line) => !line.startsWith("+")).map(stripPrefix);
	const after = hunk.body.filter((line) => !line.startsWith("-")).map(stripPrefix);
	if (before.length === 0) {
		if (after.length === 0) return err("hunk_without_context_or_deletion");
		const eof = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
		return ok({ replacement: [eof, 0, after], lineIndex: from.value });
	}
	const hits: number[] = [];
	for (let at = from.value; at + before.length <= lines.length; at += 1) {
		if (matchesAt(lines, before, at)) hits.push(at);
	}
	if (hits.length === 0) return err("context_not_found");
	if (hits.length > 1) return err("ambiguous_context");
	const at = hits[0] ?? 0;
	return ok({ replacement: [at, before.length, after], lineIndex: at + before.length });
}

/** One `*** Update File:` section's hunk body applied to its pre-image, in
 *  Codex's two phases: place every hunk against the ORIGINAL lines, then
 *  splice the recorded replacements back-to-front. */
export function oracleApplyHunks(content: string, lines: readonly string[]): OracleHunkResult<string> {
	const hunks = splitHunks(lines);
	if (!hunks.ok) return err(hunks.reason);
	const original = updateLines(content);
	const found: OracleReplacement[] = [];
	let lineIndex = 0;
	for (const hunk of hunks.value) {
		const placed = placeHunk(original, hunk, lineIndex);
		if (!placed.ok) return err(placed.reason);
		found.push(placed.value.replacement);
		lineIndex = placed.value.lineIndex;
	}
	found.sort((left, right) => left[0] - right[0]);
	const out = [...original];
	for (const [start, oldLen, newLines] of [...found].reverse()) out.splice(start, oldLen, ...newLines);
	return ok(updateContent(out));
}
