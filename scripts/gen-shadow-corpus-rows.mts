// The PROJECTION rows of `protocol/shadow-v1/fixtures/projection-corpus.json`,
// split out of `gen-shadow-corpus.mts` 2026-09-05 when that file reached the
// 500-line cap. Pure DATA plus the tool-input builders the rows are written
// with; every expected value is still computed by the generator, from the
// oracle, and asserted against the product package before a row is written.
//
// A row's `reviewed` field is the claim a human signed off on — write it as
// the sentence a reader needs to see the row is right, not as a restatement
// of `note`. Where a claim was WRONG and has been corrected, say so in the
// field: a fixture that silently changes its mind teaches nothing.

import type { NormalizedToolInputV1 } from "../src/harness/shadow/protocol/types-core.js";

// ── tool-input builders ────────────────────────────────────────────────────
const SCHEMA = "shadow-tool-input-v1" as const;
const CC = "claude-code" as const;
// SAFETY: `CanonicalPath` is a compile-time brand over `string`; the corpus is
// data on disk, and the strict parsers are what mint branded values from it.
const asInput = (value: Record<string, unknown>): NormalizedToolInputV1 => value as unknown as NormalizedToolInputV1;

export function write(file_path: string, content: string): NormalizedToolInputV1 {
	return asInput({ schema: SCHEMA, client: CC, tool: "Write", semantics_version: 1, file_path, content });
}
export function edit(file_path: string, old_string: string, new_string: string, replace_all = false): NormalizedToolInputV1 {
	return asInput({ schema: SCHEMA, client: CC, tool: "Edit", semantics_version: 1, file_path, old_string, new_string, replace_all });
}
export function multiEdit(file_path: string, edits: readonly [string, string][]): NormalizedToolInputV1 {
	const entries = edits.map(([old_string, new_string]) => ({ old_string, new_string, replace_all: false }));
	return asInput({ schema: SCHEMA, client: CC, tool: "MultiEdit", semantics_version: 1, file_path, edits: entries });
}
function rawPatch(patchText: string): NormalizedToolInputV1 {
	return asInput({ schema: SCHEMA, client: "codex", tool: "apply_patch", semantics_version: 1, patch: patchText, raw_source_field: "command" });
}
export function patch(...body: readonly string[]): NormalizedToolInputV1 {
	return rawPatch(["*** Begin Patch", ...body, "*** End Patch"].join("\n"));
}

// ── row shape ──────────────────────────────────────────────────────────────
export interface Row {
	id: string;
	note: string;
	reviewed: string;
	input: NormalizedToolInputV1;
	/** Every path the pre-image map CARRIES: a base-tree path maps to its file,
	 *  any other path to an explicit `null` ("I looked, it is not there"). */
	touches: readonly string[];
	/** Paths the input names that the map deliberately OMITS — not even a
	 *  null. Only an explicit null proves absence, so every such row must be
	 *  rejected naming the omitted path; the builder refuses a path listed
	 *  in both. */
	omits: readonly string[];
	/** Set ONLY where the two implementations genuinely disagree and the memo
	 *  says which one is right. The row is still generated and still executed,
	 *  but it records BOTH answers plus this adjudication instead of pretending
	 *  to an agreed expectation. A disputed row that starts agreeing is a hard
	 *  failure — the dispute is then over and must be deleted. */
	disputed?: string;
}
export function row(id: string, note: string, reviewed: string, input: NormalizedToolInputV1, touches: readonly string[]): Row {
	return { id, note, reviewed, input, touches, omits: [] };
}
/** A row whose pre-image map omits `omitted` on purpose. */
export function omittingRow(omitted: string, base: Row): Row {
	if (base.touches.includes(omitted)) throw new Error(`[${base.id}] ${omitted} cannot be both touched and omitted`);
	return { ...base, omits: [omitted] };
}
/** Public API of this module even while no row uses it: the generator's
 *  dispute machinery (`disputeOf`) is live and this is the only intended way
 *  to reach it. No row should be marked disputed unless the memo says which
 *  implementation is right — an ordinary disagreement is a bug in one of them. */
export function disputedRow(adjudication: string, base: Row): Row {
	return { ...base, disputed: adjudication };
}

export const PROJECTION_ROWS: readonly Row[] = [
	row("write-new-file", "a Write of a path the tree does not have", "the new file is mode 100644 and its bytes are the tool's `content` verbatim", write("src/new.ts", "export const n = 1;\n"), ["src/new.ts"]),
	row("write-over-existing", "a Write over an existing file replaces every byte and keeps the mode", "one W record, mode 100644 carried over from the pre-image, not re-derived", write("src/a.ts", "const x = 9;\n"), ["src/a.ts"]),
	row("write-over-executable", "a Write over a 100755 file preserves the executable mode", "mode is 100755 in the post-image; a Write must never silently de-execute a script", write("bin/run.sh", "#!/bin/sh\necho bye\n"), ["bin/run.sh"]),
	row("write-new-unicode-path", "a Write of an astral-plane path", "the path round-trips as UTF-8 and sorts by BYTES against the other docs/ entries", write("docs/\u{10001}.md", "# 𐀁 ✅\n"), ["docs/\u{10001}.md"]),
	row("edit-single-occurrence", "an Edit whose old_string occurs exactly once", "only the second line changes; the first is byte-identical", edit("src/a.ts", "const y = 1;", "const y = 2;"), ["src/a.ts"]),
	row("edit-replace-all", "replace_all rewrites every occurrence", "BOTH occurrences of `= 1` became `= 2` — this is the row that distinguishes replace_all identity", edit("src/a.ts", "= 1", "= 2", true), ["src/a.ts"]),
	row("edit-multibyte-content", "an Edit over multi-byte content", "the emoji swap changes the byte length, not just the character count", edit("docs/Ａ.md", "🌍", "🪐"), ["docs/Ａ.md"]),
	row("edit-preserves-executable-mode", "an Edit of a 100755 file", "mode stays 100755", edit("bin/run.sh", "echo hi", "echo bye"), ["bin/run.sh"]),
	row("edit-ambiguous-rejects", "an Edit whose old_string occurs twice without replace_all", "REJECTED, not applied to the first match — guessing would produce a post-image local apply does not", edit("src/a.ts", "= 1", "= 2"), ["src/a.ts"]),
	row("edit-old-string-absent-rejects", "an Edit whose old_string is not in the file", "REJECTED; no post-image is invented", edit("src/a.ts", "const z = 1;", "const z = 2;"), ["src/a.ts"]),
	row("edit-identical-strings-rejects", "an Edit whose old_string EQUALS its new_string", "REJECTED by both implementations — Claude Code's own Edit tool refuses that call (\"old_string and new_string are exactly the same\"), so no local write happens and an unchanged W record would sign for an apply the client never performs", edit("src/a.ts", "const x = 1;", "const x = 1;"), ["src/a.ts"]),
	row("edit-target-absent-rejects","an Edit of a path that does not exist", "REJECTED; Edit never creates a file", edit("src/missing.ts", "a", "b"), ["src/missing.ts"]),
	row("multiedit-sequential", "edit 2 applies to the RESULT of edit 1", "the final bytes show `const x = 3;` — proof the edits composed rather than both matching the original", multiEdit("src/a.ts", [["const x = 1;", "const x = 2;"], ["const x = 2;", "const x = 3;"]]), ["src/a.ts"]),
	row("multiedit-second-edit-absent-rejects", "a MultiEdit whose second edit does not match", "REJECTED WHOLE — no partial application of edit 1 leaks into a post-image", multiEdit("src/a.ts", [["const x = 1;", "const x = 2;"], ["const q = 1;", "const q = 2;"]]), ["src/a.ts"]),
	row("apply-patch-add", "a Codex apply_patch Add File section", "one W record at mode 100644 whose bytes are the `+` line FOLLOWED BY a newline (bytes = 24, not 23): Codex appends a newline after every added line — `codex-rs/apply-patch/src/streaming_parser.rs` AddFile arm, `contents.push_str(line); contents.push('\\n')`, pinned by its own tests (`+hello` => \"hello\\n\"). The pre-2026-09-05 note here claimed the V4A body cannot encode a trailing newline; that was false — the newline is not in the body at all, the reader appends it", patch("*** Add File: src/added.ts", "+export const added = 1;"), ["src/added.ts"]),
	row("apply-patch-add-review-probe", "the reviewer's native measurement, reproduced byte for byte", "the review ran the REAL apply_patch tool with one `+shadow-review-probe` line and measured 20 bytes, sha256 b552907b209538ebb94283b8f808edf1d559c1d419faa36deb1d819863f89b5b. The projector used to emit 19 bytes / 87267e64dcc739609a85276706a319697d7b7106b6b5dcf65e238f0552e9ea0d — this row is the pin that the fix reproduces the measurement and not merely the code's own opinion", patch("*** Add File: src/probe.txt", "+shadow-review-probe"), ["src/probe.txt"]),
	row("apply-patch-add-multiline", "an Add File with two `+` lines", "\"a\\nb\\n\" — EVERY added line carries its own newline, so the last one does too (`streaming_parser.rs` test: two lines => \"hello\\nworld\\n\")", patch("*** Add File: src/two.ts", "+a", "+b"), ["src/two.ts"]),
	row("apply-patch-add-empty-body", "an Add File section with no `+` line at all", "the EMPTY file, not \"\\n\": Codex opens an AddFile with `contents: String::new()` and only a `+` line appends anything (`streaming_parser.rs` L109-111, and `AddFile { contents: String::new() }` appears verbatim in the parser's own tests). Both grammars admit the section, so this is a projected row, not a rejection", patch("*** Add File: src/empty.ts"), ["src/empty.ts"]),
	row("apply-patch-update-no-final-newline", "an Update of a pre-image with NO final newline", "the post bytes END with exactly one newline the pre-image never had: Codex's NormalizeToLf split pops a trailing empty element only if there is one, then always pushes one back before joining (`file_update.rs::derive_new_contents_from_chunks`)", patch("*** Update File: src/no-eol.ts", "@@", "-const tail = 1;", "+const tail = 2;"), ["src/no-eol.ts"]),
	row("apply-patch-update-collapses-double-final-newline", "an Update of a pre-image ending in TWO newlines", "the post bytes end in ONE: exactly one trailing empty element is popped and at most one pushed back, so `...;\\n\\n` becomes `...;\\n`. An updated file is normalized whether or not the hunk went near the end", patch("*** Update File: src/two-eol.ts", "@@", "-const tail = 1;", "+const tail = 2;"), ["src/two-eol.ts"]),
	row("apply-patch-update-crlf-rejects", "an Update whose pre-image lines end in CRLF, against an LF-only hunk pattern", "REJECTED as context_not_found by BOTH implementations, and that is a DELIBERATE strictness gap, not a bug. Codex would place this hunk: `seek_sequence.rs` tries exact match, then `trim_end()`, then `trim()`, then a Unicode-punctuation normalization, and the second pass matches \"const x = 1;\" against \"const x = 1;\\r\". This projector has exactly ONE match strategy, because a four-rung fuzzy ladder cannot say WHICH rung the local apply used — and in NormalizeToLf mode the matched region is rewritten from the hunk's own lines, so the CR is dropped from every replaced line and kept on every untouched one. Refusing yields `shadow: unavailable`; guessing would yield a confidently wrong post_tree_hash. The post bytes Codex would produce for a CRLF file are NOT pinned by this corpus", patch("*** Update File: src/crlf.ts", "@@", "-const x = 1;", "+const x = 7;"), ["src/crlf.ts"]),
	row("apply-patch-update-empty-result", "a hunk that deletes the file's only line", "the result is the EMPTY file (0 bytes), never \"\\n\": with no lines left the push-then-join produces \"\". It is still a W — emptying a file is not deleting it", patch("*** Update File: src/one-line.ts", "@@", "-gone"), ["src/one-line.ts"]),
	row("apply-patch-add-unicode", "an Add File whose path and body are multi-byte", "the added path sorts by UTF-8 bytes among the docs/ entries", patch("*** Add File: docs/\u{10002}.md", "+# 𐀂 café"), ["docs/\u{10002}.md"]),
	row("apply-patch-update", "a Codex apply_patch update section", "the hunk applied at the only matching site; the untouched line is byte-identical", patch("*** Update File: src/a.ts", "@@", "-const x = 1;", "+const x = 7;"), ["src/a.ts"]),
	row("apply-patch-update-anchored", "an @@ anchor selects WHICH of two identical blocks the hunk edits", "only `function b`'s body changes; `function a`'s is byte-identical — the anchor, not the first structural match, decides. The anchor is also what moves Codex's `line_index` cursor: `seek_sequence` is called with `start = line_index`, so the block search runs over [anchor + 1, end) and the copy inside `function a` is not a candidate", patch("*** Update File: src/anchored.ts", "@@ function b() {", "-\treturn 1;", "+\treturn 2;"), ["src/anchored.ts"]),
	row("apply-patch-delete", "a Delete File section", "exactly one D record and no W — a delete is a tombstone, never empty bytes", patch("*** Delete File: src/keep.ts"), ["src/keep.ts"]),
	row("apply-patch-move", "a rename is D source + W destination carrying the moved content", "two records; the destination carries the edited content at ITS OWN mode — 100644 here, because src/moved.ts does not exist and `write_file` creates it at the default. The pre-2026-09-05 note claimed the destination keeps the SOURCE's mode; that was false, and it read as true only because both paths are 100644 (see `apply-patch-move-executable-destination-is-100644`)", patch("*** Update File: src/a.ts", "*** Move to: src/moved.ts", "@@", "-const x = 1;", "+const x = 8;"), ["src/a.ts", "src/moved.ts"]),
	row("apply-patch-move-onto-existing", "a rename onto a path that already exists OVERWRITES it", "src/keep.ts's original bytes are GONE from the post tree and appear nowhere else — a destination collision is a silent overwrite, not a rejection. The destination record carries the DESTINATION's own mode (100644, src/keep.ts's), not the source's: `write_file` rewrites bytes in place and never chmods", patch("*** Update File: src/a.ts", "*** Move to: src/keep.ts", "@@", "-const x = 1;", "+const x = 8;"), ["src/a.ts", "src/keep.ts"]),
	row("apply-patch-ambiguous-context-rejects", "a hunk whose context matches two places", "REJECTED as ambiguous rather than applied to the first match — a guessed site makes every binding hash a claim about a tree local apply may never produce", patch("*** Update File: src/dup.ts", "@@", "-same();", "+other();"), ["src/dup.ts"]),
	row("apply-patch-context-absent-rejects", "a hunk whose context is not in the file", "REJECTED; the patch is not silently dropped", patch("*** Update File: src/a.ts", "@@", "-const q = 1;", "+const q = 2;"), ["src/a.ts"]),
	row("apply-patch-add-existing-rejects", "an Add File over a path that exists", "REJECTED; Add is not an overwrite", patch("*** Add File: src/keep.ts", "+export const keep = 2;"), ["src/keep.ts"]),
	row("apply-patch-delete-absent-rejects", "a Delete File of a path that does not exist", "REJECTED; a D for a path absent in the pre-tree is a projection error, not a no-op", patch("*** Delete File: src/gone.ts"), ["src/gone.ts"]),
	row("apply-patch-create-then-delete", "one patch that adds a path and then deletes it", "ZERO records and empty touched_paths — the post-image set is the DIFF the whole patch leaves behind, not a log of its sections, so this collapses to the no-op identity (memo §8.0)", patch("*** Add File: src/tmp.ts", "+tmp", "*** Delete File: src/tmp.ts"), ["src/tmp.ts"]),
	row("apply-patch-truncated-envelope", "a patch with no End Patch marker", "REJECTED at the envelope, before any section is interpreted — otherwise a truncated patch is indistinguishable from a complete one, the arrived sections projecting cleanly and the lost ones silently absent", rawPatch("*** Begin Patch\n*** Delete File: src/keep.ts"), ["src/keep.ts"]),
	// ── second review: ONLY AN EXPLICIT NULL PROVES ABSENCE ──────────────────
	// A path the map does not carry was never looked at. Every operation's
	// target — Write / Edit / MultiEdit, Add / Delete / Update, Move source AND
	// destination — must be in the map, or the projection is `missing_pre_image`.
	omittingRow("src/new.ts", row("write-omitted-pre-image-rejects", "a Write whose target is OMITTED from the pre-image map", "REJECTED naming src/new.ts — an unchecked Write must not become a confident new file", write("src/new.ts", "x\n"), [])),
	row("write-explicit-null-creates", "the positive control: the same Write with an EXPLICIT null pre-image", "one W 100644 src/new.ts — null is the caller saying it looked, and that is what licenses a create", write("src/new.ts", "x\n"), ["src/new.ts"]),
	omittingRow("src/a.ts", row("edit-omitted-pre-image-rejects", "an Edit whose target is omitted from the map", "REJECTED naming src/a.ts, BEFORE the absent-target rule — omitted is not absent", edit("src/a.ts", "const x = 1;", "const x = 2;"), [])),
	omittingRow("src/a.ts", row("multiedit-omitted-pre-image-rejects", "a MultiEdit whose target is omitted from the map", "REJECTED naming src/a.ts; no edit is attempted", multiEdit("src/a.ts", [["const x = 1;", "const x = 2;"]]), [])),
	omittingRow("src/new.ts", row("apply-patch-add-omitted-pre-image-rejects", "an Add File whose path is omitted from the map", "REJECTED naming src/new.ts — an Add needs the caller's word that the path is absent", patch("*** Add File: src/new.ts", "+x"), [])),
	omittingRow("src/keep.ts", row("apply-patch-delete-omitted-pre-image-rejects", "a Delete File whose path is omitted from the map", "REJECTED naming src/keep.ts", patch("*** Delete File: src/keep.ts"), [])),
	omittingRow("src/keep.ts", row("apply-patch-update-omitted-pre-image-rejects", "an Update File whose path is omitted from the map", "REJECTED naming src/keep.ts", patch("*** Update File: src/keep.ts", "@@", "-export const keep = 1;", "+export const keep = 2;"), [])),
	omittingRow("src/renamed.ts", row("apply-patch-move-destination-omitted-rejects", "a Move whose DESTINATION is omitted (source present)", "REJECTED naming src/renamed.ts — the destination is a touched path and needs a pre-image like any other (an existing destination is overwritten and keeps its own mode, so the projector must know whether one exists)", patch("*** Update File: src/keep.ts", "*** Move to: src/renamed.ts", "@@", "-export const keep = 1;", "+export const keep = 2;"), ["src/keep.ts"])),
	omittingRow("src/keep.ts", row("apply-patch-move-source-omitted-rejects", "a Move whose SOURCE is omitted (destination present)", "REJECTED naming src/keep.ts — the source is checked first, so the rejection names the path the patch itself named first", patch("*** Update File: src/keep.ts", "*** Move to: src/renamed.ts", "@@", "-export const keep = 1;", "+export const keep = 2;"), ["src/renamed.ts"])),
	row("apply-patch-move-onto-existing-overwrites", "a Move onto a destination that EXISTS", "D src/keep.ts + W src/a.ts carrying the moved content — a destination collision is an overwrite, and both implementations agree. The 100644 on the destination record is src/a.ts's OWN mode; the source happens to share it, which is why this row cannot tell the two readings apart and `apply-patch-move-onto-existing-keeps-destination-mode` exists", patch("*** Update File: src/keep.ts", "*** Move to: src/a.ts", "@@", "-export const keep = 1;", "+export const keep = 2;"), ["src/keep.ts", "src/a.ts"]),
	// ── second review: STRICT sections, matched to the oracle ───────────────
	// The tolerant PostToolUse splitter skips an unknown directive, ignores a
	// Delete body and lets a Move retarget anything; the projector may not.
	row("apply-patch-unknown-directive-rejects", "an unknown `*** ` directive", "REJECTED as unknown_section_header — skipping it would project the Delete that follows and sign for a patch the local apply reads differently. `*** End of File` reaches this same rule, which is how the unported end-of-file placement stays a refusal rather than a guess", patch("*** Bogus Directive: x", "*** Delete File: src/keep.ts"), ["src/keep.ts"]),
	row("apply-patch-body-before-section-rejects", "a body line before the first section", "REJECTED as body_before_section — a stray line has no section to belong to", patch("+stray", "*** Delete File: src/keep.ts"), ["src/keep.ts"]),
	row("apply-patch-delete-with-body-rejects", "a Delete File section carrying a body", "REJECTED as delete_section_has_body — a Delete has no body, and a body that is ignored is a body that was never checked", patch("*** Delete File: src/keep.ts", "+ignored"), ["src/keep.ts"]),
	row("apply-patch-malformed-add-line-rejects", "an Add File body line without its `+`", "REJECTED as malformed_add_body — every Add line starts with `+`", patch("*** Add File: src/new.ts", "+ok", "bare"), ["src/new.ts"]),
	row("apply-patch-malformed-hunk-header-rejects", "an `@@anchor` header with no space after the marker", "REJECTED as malformed_hunk_line by BOTH implementations — the native grammar knows exactly `@@` and `@@ <context>` (parser.rs CHANGE_CONTEXT_MARKER = \"@@ \"), and the live tool refused this exact patch with \"Unexpected line found in update hunk: '@@anchor'\" (session review r2, finding 3, 2026-09-05); before this row both parsers read `@@anchor` as a header and projected `anchor\\nbravo\\n` for an operation the tool cannot perform", patch("*** Update File: src/a.ts", "@@anchor", "-const x = 1;", "+const x = 2;"), ["src/a.ts"]),
	row("apply-patch-misplaced-move-rejects", "a Move after a hunk line", "BOTH reject; the reason strings differ BY DESIGN — the oracle sees a malformed hunk line, the product a misplaced Move (it is legal only as the first body line of an Update). Same verdict, two grammars' names for it", patch("*** Update File: src/keep.ts", "@@", "-export const keep = 1;", "+export const keep = 2;", "*** Move to: src/renamed.ts"), ["src/keep.ts", "src/renamed.ts"]),
	row("apply-patch-move-on-delete-rejects", "a Move attached to a Delete", "BOTH reject — the oracle as a Delete with a body, the product as move_on_non_update; the tolerant splitter would have retargeted the Delete", patch("*** Delete File: src/keep.ts", "*** Move to: src/renamed.ts"), ["src/keep.ts", "src/renamed.ts"]),
	row("apply-patch-move-on-add-rejects", "a Move attached to an Add", "BOTH reject — the oracle as a malformed Add body, the product as move_on_non_update", patch("*** Add File: src/new.ts", "*** Move to: src/renamed.ts", "+x"), ["src/new.ts", "src/renamed.ts"]),
	row("apply-patch-delete-then-add-same-path", "one patch that deletes a path and then adds it", "one W 100644 src/keep.ts with the fresh bytes — the patch's own Delete makes the path known to its Add, and the diff against the pre-image is a single W", patch("*** Delete File: src/keep.ts", "*** Add File: src/keep.ts", "+fresh"), ["src/keep.ts"]),
	// ── third review: A REGULAR FILE IS NOT A DIRECTORY ─────────────────────
	// Each path is individually canonical, so only the SET can show that a
	// file is also another entry's parent. Before this rule the pair below
	// projected, applied and hashed cleanly — a confident post_tree_hash for
	// a tree no filesystem can hold.
	row("write-under-regular-file-rejects", "a Write of a path UNDER an existing regular file, with the child explicitly null", "REJECTED by both: the pre-image says src/a.ts is a file, so src/a.ts/child.ts cannot exist. The null proves the child is absent — it does not license writing under a file", write("src/a.ts/child.ts", "x\n"), ["src/a.ts", "src/a.ts/child.ts"]),
	row("apply-patch-delete-file-then-add-under-it", "one patch that deletes src/a.ts and then adds src/a.ts/child.ts", "ALLOWED: D + W. The patch's own Delete releases the path before the Add, so the draft no longer holds a file there and the tree the set lands on is possible — the rule is about the END STATE, not about any path spelling", patch("*** Delete File: src/a.ts", "*** Add File: src/a.ts/child.ts", "+child"), ["src/a.ts", "src/a.ts/child.ts"]),
	// ── fourth review, finding 2: hunks are placed against the ORIGINAL ─────
	// `file_update.rs::compute_replacements` walks the popped original lines
	// once behind a forward cursor and applies the recorded replacements
	// back-to-front, so no hunk ever sees another hunk's output (D34).
	row("apply-patch-update-two-hunks", "two ordinary ordered hunks in one Update section", "BOTH apply, each against the pre-image at its own site: `const x = 2;\\nconst y = 2;\\n`. The replacements are recorded as (0,1) and (1,1) against the ORIGINAL lines and spliced back-to-front, which is why the second one's index is still valid once the first is applied", patch("*** Update File: src/a.ts", "@@", "-const x = 1;", "+const x = 2;", "@@", "-const y = 1;", "+const y = 2;"), ["src/a.ts"]),
	row("apply-patch-update-dependent-hunks-reject", "hunk 2 deletes a line hunk 1 INTRODUCES", "REJECTED as context_not_found by both implementations, and the reviewer measured the real tool giving the same verdict on this shape (\"Failed to find expected lines ... bravo\"). The pre-2026-09-05 applier ran the hunks sequentially and answered with hunk 2 applied to hunk 1's output — a post_tree_hash for a tree the local apply never lands on, which is the exact failure the strict projector exists to prevent", patch("*** Update File: src/a.ts", "@@", "-const x = 1;", "+const w = 1;", "@@", "-const w = 1;", "+const v = 1;"), ["src/a.ts"]),
	row("apply-patch-update-reversed-hunks-reject", "hunk 2's site lies entirely BEFORE hunk 1's", "REJECTED: the cursor only moves forward (`line_index = start_idx + pattern.len()`), so `const x = 1;` is no longer searchable once hunk 1 consumed line 1. Codex refuses out-of-order hunks and so does this projector", patch("*** Update File: src/a.ts", "@@", "-const y = 1;", "+const y = 2;", "@@", "-const x = 1;", "+const x = 2;"), ["src/a.ts"]),
	row("apply-patch-update-overlapping-hunks-reject", "hunk 2's site OVERLAPS the block hunk 1 replaced", "REJECTED: hunk 1's block covers both lines, so the cursor sits past the end of the file and hunk 2's `const y = 1;` has no site at or after it. Overlapping replacements are unrepresentable in Codex's model — it never checks for them because the forward cursor already makes them impossible", patch("*** Update File: src/a.ts", "@@", "-const x = 1;", "-const y = 1;", "+merged();", "@@", "-const y = 1;", "+const y = 2;"), ["src/a.ts"]),
	row("apply-patch-update-anchor-before-cursor-rejects", "hunk 2's anchor occurs only ABOVE hunk 1's site", "REJECTED as anchor_not_found, never wrapped around: the anchor seek is `seek_sequence(..., start = line_index)`, which searches [cursor, end) only. `function a() {` is line 0 and the cursor is past line 4", patch("*** Update File: src/anchored.ts", "@@ function b() {", "-\treturn 1;", "+\treturn 2;", "@@ function a() {", "-}", "+};"), ["src/anchored.ts"]),
	row("apply-patch-update-cursor-disambiguates", "a bare hunk whose block ALSO occurs before the cursor", "ACCEPTED at the single site at or after the cursor. `\\treturn 1;` appears twice in the file, so hunk 2 would be ambiguous on its own; hunk 1's context block consumes lines 0-1 and leaves exactly one candidate. This is the row that shows the CURSOR — not just the anchor — doing the scoping", patch("*** Update File: src/anchored.ts", "@@", " function a() {", "-\treturn 1;", "+\treturn 9;", "@@", "-\treturn 1;", "+\treturn 8;"), ["src/anchored.ts"]),
	row("apply-patch-update-pure-insertion-at-eof", "a hunk with only `+` lines", "APPENDED AT END OF FILE, not at the cursor: Codex's `old_lines.is_empty()` branch pushes `(insertion_idx, 0, new_lines)` with `insertion_idx = original_lines.len()` and then `continue`s without moving the cursor. The pre-2026-09-05 projector refused every pure insertion as `hunk_without_context_or_deletion`; that code now covers only a hunk with NO line at all, which Codex's parser refuses outright (\"Update hunk does not contain any lines\")", patch("*** Update File: src/keep.ts", "@@", "+export const added = 2;"), ["src/keep.ts"]),
	row("apply-patch-update-pure-insertion-ignores-anchor", "a pure insertion carrying an @@ anchor", "STILL appended at end of file — the anchor is resolved first (an unfindable one still refuses) but the insertion index ignores it. `function a() {` is line 0 and the new line lands after line 5", patch("*** Update File: src/anchored.ts", "@@ function a() {", "+// tail"), ["src/anchored.ts"]),
	// ── fourth review, finding 3: a move writes the DESTINATION first ───────
	// `lib.rs`, the `Hunk::UpdateFile` move branch: derive the bytes from the
	// source, `write_file_with_missing_parent_retry(dest)`, then `remove(src)`.
	// `write_file` never chmods, so the source's mode is never carried (D34).
	row("apply-patch-move-executable-destination-is-100644", "a 100755 source moved to an ABSENT destination", "the destination is 100644, NOT the source's 100755 — the reviewer measured the real tool doing exactly this. Codex writes the destination with `write_file`, which creates it at the default mode and never chmods; the source's mode dies with the source. This is the row `apply-patch-move` could not catch, because there both paths are 100644", patch("*** Update File: bin/run.sh", "*** Move to: src/moved.sh", "@@", "-echo hi", "+echo bye"), ["bin/run.sh", "src/moved.sh"]),
	row("apply-patch-move-onto-existing-keeps-destination-mode", "a 100644 source moved onto an EXISTING 100755 destination", "the destination stays 100755 and its bytes are replaced. An existing destination is overwritten in place, so it keeps its own mode — the mirror image of the row above, and together they pin that the mode comes from the DESTINATION in both directions", patch("*** Update File: src/keep.ts", "*** Move to: bin/run.sh", "@@", "-export const keep = 1;", "+export const keep = 2;"), ["src/keep.ts", "bin/run.sh"]),
	row("apply-patch-move-under-source-rejects", "a move whose destination lies UNDER the source path", "REJECTED as a file/directory conflict by both implementations, and the reviewer measured the real tool failing it. Codex writes the destination BEFORE removing the source, so src/keep.ts is still a regular file when the write to src/keep.ts/child.ts runs and the write fails. Until 2026-09-05 both implementations released the source first and projected a clean D + W — a confident post-image for a patch the tool refuses (the judgment call D33 recorded with no corpus row is settled the other way here)", patch("*** Update File: src/keep.ts", "*** Move to: src/keep.ts/child.ts", "@@", "-export const keep = 1;", "+export const keep = 2;"), ["src/keep.ts", "src/keep.ts/child.ts"]),
	row("apply-patch-move-onto-self-rejects", "a move whose destination IS the source", "REJECTED as a stated non-claim. Natively this writes the file and then unlinks the same path, leaving no file and bytes nobody can read; shadow v0 does not model that shape, and refusing costs availability while guessing would cost correctness", patch("*** Update File: src/keep.ts", "*** Move to: src/keep.ts", "@@", "-export const keep = 1;", "+export const keep = 2;"), ["src/keep.ts"]),
];
