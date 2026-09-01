// Invariant extraction (docs/design/spec-audit-runtime-checks.md §7.4 +
// spike 7): the deterministic half of the invariant registry. From CODE:
// `// INVARIANT:` / `// SAFETY:` comments and assert!/debug_assert! calls.
// From MARKDOWN: numbered-registry definition rows (FG-INV-xx style) and
// MUST/never/always doctrine sentences (the /enforce lexical ladder's
// block-tier markers). Output feeds the taxonomy artifact that scopes
// reviews — extraction only, judgment stays with reviewers.

interface ExtractedInvariant {
	line: number;
	kind: "invariant_comment" | "safety_comment" | "assertion" | "registry_row" | "doctrine";
	/** Verbatim text, trimmed, capped. */
	text: string;
	/** Registry id when the source row carries one (FG-INV-07). */
	id?: string;
}

const TEXT_CAP = 240;

const INVARIANT_COMMENT_RE = /(?:\/\/|\/\*+|#|\*)\s*(INVARIANT|SAFETY)\s*:\s*(.+)/;
const ASSERT_RE = /\b(?:debug_)?assert(?:_eq|_ne)?!\s*\(|\bassert\s*\(/;

/** Invariant-bearing lines from a CODE file. */
export function extractCodeInvariants(content: string): ExtractedInvariant[] {
	const out: ExtractedInvariant[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const comment = INVARIANT_COMMENT_RE.exec(line);
		if (comment) {
			out.push({
				line: i + 1,
				kind: comment[1]?.toUpperCase() === "SAFETY" ? "safety_comment" : "invariant_comment",
				text: (comment[2] ?? "").trim().slice(0, TEXT_CAP),
			});
			continue;
		}
		if (ASSERT_RE.test(line)) {
			out.push({ line: i + 1, kind: "assertion", text: line.trim().slice(0, TEXT_CAP) });
		}
	}
	return out;
}

/** The /enforce block-tier lexical markers — doctrine-grade sentences. */
const DOCTRINE_RE =
	/\b(?:MUST NOT|MUST\b|must never|never\b|always\b|under no circumstances|shall not|forbidden|sole (?:truth|source)|only (?:mutable|source))/;

/** Registry definition row: a definition-shaped line leading with an id.
 *  Flat character class (no nested quantifiers — the extract-ids ReDoS
 *  lesson); segment shape enforced by isValidRegistryId below. */
const REGISTRY_ROW_RE = /^\s*(?:\||-|\*|\d+\.)\s*\**([A-Z][A-Z0-9-]{1,30}-\d{1,4})\**\s*[|:—-]\s*(.+)/;

/** Every dash-separated prefix segment starts with a letter; numeric tail. */
function isValidRegistryId(id: string): boolean {
	const segments = id.split("-");
	const tail = segments.pop() ?? "";
	if (!/^\d{1,4}$/.test(tail) || segments.length === 0) return false;
	return segments.every((seg) => /^[A-Z][A-Z0-9]{0,15}$/.test(seg));
}

/** A run of 3+ backticks/tildes toggles a fenced block. */
function isFenceLine(line: string): boolean {
	return /^\s*(?:`{3,}|~{3,})/.test(line);
}

/** One markdown line → its invariant entry (registry row or doctrine), or null. */
function markdownInvariantFor(line: string, lineNo: number): ExtractedInvariant | null {
	const row = REGISTRY_ROW_RE.exec(line);
	if (row?.[1] && isValidRegistryId(row[1])) {
		return {
			line: lineNo,
			kind: "registry_row",
			id: row[1],
			text: (row[2] ?? "").replace(/\|.*$/, "").trim().slice(0, TEXT_CAP),
		};
	}
	if (DOCTRINE_RE.test(line) && line.trim().length > 20) {
		return { line: lineNo, kind: "doctrine", text: line.trim().slice(0, TEXT_CAP) };
	}
	return null;
}

/** Invariant-grade content from a MARKDOWN file: registry rows + doctrine
 *  sentences. Fenced code and blockquotes are skipped (round-2 #32): an
 *  example or a quoted critique naming an invariant is illustration, not a
 *  policy entry. Doctrine matching is case-sensitive on MUST. */
export function extractMarkdownInvariants(content: string): ExtractedInvariant[] {
	const out: ExtractedInvariant[] = [];
	let inFence = false;
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (isFenceLine(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || line.trimStart().startsWith(">")) continue;
		const entry = markdownInvariantFor(line, i + 1);
		if (entry) out.push(entry);
	}
	return out;
}

/** Render the taxonomy artifact (the Tier-2 policy.md-as-taxonomy shape:
 *  one labeled entry per invariant, verbatim quote, provenance — memo §5). */
export function renderInvariantTaxonomy(
	source: string,
	invariants: ExtractedInvariant[],
): string {
	const head = [
		`# Invariant taxonomy — ${source} (generated)`,
		"",
		"One entry per extracted invariant: classify edits against these",
		"(consistent | contradicts | unrelated). Verbatim quotes; judgment",
		"belongs to the reviewer or the Tier-2 gate, never this extractor.",
		"",
	];
	const rows = invariants.map((inv, i) => {
		const label = inv.id ?? `INV-x${i + 1}`;
		return `- **${label}** (${inv.kind}, ${source}:${inv.line}): ${inv.text}`;
	});
	return [...head, ...rows, ""].join("\n");
}
