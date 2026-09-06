// ===========================================
// Shadow protocol v1 — STRICT V4A section parser for the post-image projector
// ===========================================
// `src/harness/apply-patch-content.ts` splits the same payload for a
// PostToolUse WARNING, so it is deliberately tolerant: an unknown `*** `
// directive is skipped, a Delete section's body is ignored, and a
// `*** Move to:` retargets WHATEVER section precedes it, Add and Delete
// included. Those readings are fine for a warning and wrong here: the
// projector mints the bytes hashed into `post_tree_hash`, so a section it
// interprets differently from the local apply is a confident lie about a
// different workspace (memo §5.1, §8.1).
//
// The grammar, matched to the adjudicated oracle
// (`scripts/shadow-projection-oracle.mts`):
//   - a section opens with EXACTLY `*** Add File: `, `*** Delete File: ` or
//     `*** Update File: `; the path is everything after, verbatim;
//   - any other `*** ` line except a Move is `unknown_section_header`;
//   - a line before the first section is `body_before_section`;
//   - a Delete has no body at all (`delete_section_has_body`);
//   - every Add body line starts with `+` (`malformed_add_body`);
//   - a Move is legal ONLY as the first body line of an Update
//     (`move_on_non_update`, `misplaced_move`);
//   - no section at all is `empty_patch`.
// Hunk placement is `post-image-patch.ts`'s job; this module hands it the
// Update body untouched.

const ADD_PREFIX = "*** Add File: ";
const DELETE_PREFIX = "*** Delete File: ";
const UPDATE_PREFIX = "*** Update File: ";
const MOVE_PREFIX = "*** Move to: ";
const DIRECTIVE_PREFIX = "*** ";

/** Public API: why the payload's sections are not exactly determined. Each
 *  value is the detail text a rejection carries, so the corpus can pin the
 *  class; the projector's `sectionFailureDetail` formats it. */
export type SectionParseFailureV1 =
	| "empty_patch"
	| "unknown_section_header"
	| "body_before_section"
	| "delete_section_has_body"
	| "malformed_add_body"
	| "misplaced_move"
	| "move_on_non_update";

export interface AddSectionV1 {
	readonly op: "add";
	readonly path: string;
	/** The file's lines, `+` prefix stripped. */
	readonly lines: readonly string[];
}
export interface DeleteSectionV1 {
	readonly op: "delete";
	readonly path: string;
}
export interface UpdateSectionV1 {
	readonly op: "update";
	readonly path: string;
	/** The `*** Move to:` destination, or null for an in-place update. */
	readonly move_to: string | null;
	/** The raw hunk lines (`@@` headers and their ` ` / `-` / `+` lines). */
	readonly body: readonly string[];
}
export type StrictPatchSectionV1 = AddSectionV1 | DeleteSectionV1 | UpdateSectionV1;

export type SectionParseResultV1 =
	| { ok: true; sections: readonly StrictPatchSectionV1[] }
	| { ok: false; code: SectionParseFailureV1 };

/** A section under construction: mutable body, then frozen into a record. */
interface OpenSectionV1 {
	readonly op: StrictPatchSectionV1["op"];
	readonly path: string;
	move_to: string | null;
	readonly body: string[];
}

function afterPrefix(line: string, prefix: string): string | null {
	return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

/** The section a header line opens, or null when the line is not a header. */
function openSection(line: string): OpenSectionV1 | null {
	const added = afterPrefix(line, ADD_PREFIX);
	if (added !== null) return { op: "add", path: added, move_to: null, body: [] };
	const deleted = afterPrefix(line, DELETE_PREFIX);
	if (deleted !== null) return { op: "delete", path: deleted, move_to: null, body: [] };
	const updated = afterPrefix(line, UPDATE_PREFIX);
	if (updated !== null) return { op: "update", path: updated, move_to: null, body: [] };
	return null;
}

/** A Move is legal only as the first body line of an Update. */
function attachMove(section: OpenSectionV1, destination: string): SectionParseFailureV1 | null {
	if (section.op !== "update") return "move_on_non_update";
	if (section.move_to !== null || section.body.length > 0) return "misplaced_move";
	section.move_to = destination;
	return null;
}

/** One body line into the open section, under that section's own rule. */
function attachBodyLine(section: OpenSectionV1, line: string): SectionParseFailureV1 | null {
	if (section.op === "delete") return "delete_section_has_body";
	if (section.op === "add") {
		if (!line.startsWith("+")) return "malformed_add_body";
		section.body.push(line.slice(1));
		return null;
	}
	section.body.push(line);
	return null;
}

/** One non-header line: a Move directive, an unknown directive, or body. */
function attachLine(section: OpenSectionV1 | null, line: string): SectionParseFailureV1 | null {
	const moveTo = afterPrefix(line, MOVE_PREFIX);
	if (moveTo === null && line.startsWith(DIRECTIVE_PREFIX)) return "unknown_section_header";
	if (section === null) return "body_before_section";
	if (moveTo !== null) return attachMove(section, moveTo);
	return attachBodyLine(section, line);
}

function freeze(section: OpenSectionV1): StrictPatchSectionV1 {
	if (section.op === "add") return { op: "add", path: section.path, lines: section.body };
	if (section.op === "delete") return { op: "delete", path: section.path };
	return { op: "update", path: section.path, move_to: section.move_to, body: section.body };
}

/** Parse the lines BETWEEN `*** Begin Patch` and `*** End Patch` into
 *  sections, in source order. The first failure in source order wins. */
export function parseStrictPatchSections(lines: readonly string[]): SectionParseResultV1 {
	const open: OpenSectionV1[] = [];
	for (const line of lines) {
		const header = openSection(line);
		if (header !== null) {
			open.push(header);
			continue;
		}
		const failure = attachLine(open[open.length - 1] ?? null, line);
		if (failure !== null) return { ok: false, code: failure };
	}
	if (open.length === 0) return { ok: false, code: "empty_patch" };
	return { ok: true, sections: open.map(freeze) };
}
