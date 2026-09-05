// Spec-facts orchestrator: one call extracts everything the ledger and the
// spec checks consume (docs/design/spec-audit-runtime-checks.md §3.1).
// Pure function, no I/O — callers (checks, ledger, session stash) decide
// caching and freshness.

import {
	extractCountClaims,
	extractIdNamespaces,
	extractLooseDefinedIds,
	extractRangeClaims,
} from "./extract-ids.js";
import {
	extractClaimSentences,
	extractDeclaredFacts,
	extractFencedBlocks,
	extractPathRefs,
	fencedLineSet,
} from "./extract-misc.js";
import {
	extractAnchorLinks,
	extractHeadings,
	extractSectionRefs,
} from "./extract-refs.js";
import {
	htmlCommentBlockLines,
	maskCommentsKeepCode,
} from "./extract-refs-masking.js";
import type { SpecFacts } from "./types.js";
import { maskExampleFields, maskQuotedFactText } from "./fact-context.js";

/**
 * A markdown table row — `| a | b |`. Requires two pipes so a line that merely
 * contains one (prose with an inline `a | b` alternation) is left alone.
 */
function isTableRow(line: string): boolean {
	const t = line.trim();
	return t.startsWith("|") && (t.match(/\|/g)?.length ?? 0) >= 2;
}

/**
 * Extract all spec facts from one file's content. ID censuses scan fenced
 * blocks too (registry tables are often TOML/JSON examples); prose-shaped
 * facts (headings, refs, links, paths, claims) exclude fenced lines.
 */
export function extractSpecFacts(content: string, filePath: string): SpecFacts {
	const lines = content.split("\n");
	const exampleLines = maskExampleFields(lines);
	const fencedBlocks = extractFencedBlocks(lines);
	const fenced = fencedLineSet(fencedBlocks);
	// Comment visibility is applied ONCE here so the count/id/range extractors
	// inherit identical rules (round-7 #10): whole-line comment BLOCKS blank
	// entirely; same-line comments blank to spaces with code spans kept
	// VISIBLE (the census deliberately reads fenced/inline code). "<!-- Six
	// bets B1 B2 B3 -->" produces neither a count claim nor a B namespace.
	const commentHidden = htmlCommentBlockLines(lines, fenced);
	const visibleLines = exampleLines.map((l, i) =>
		commentHidden.has(i + 1) ? "" : maskCommentsKeepCode(l),
	);
	const censusLines = visibleLines.map(maskQuotedFactText);
	// Prose-shaped facts exclude fenced lines (round-2 #21): count/range
	// claims inside a documented example are illustration, not assertions.
	// ID censuses still scan fences (registry tables are often examples).
	// Table ROWS are masked for the same reason fenced lines are: a number in a
	// table cell is data ABOUT one row, not a prose assertion about how many rows
	// the registry has. Dogfooded — a status table whose Evidence column read
	// "41 survivors" and "6 cases" was reported as four stale claims about an
	// 11-id namespace. The id census still scans tables (censusLines), so registry
	// tables keep DEFINING ids; only CLAIMS stop being read out of their cells.
	const proseLines = censusLines.map((l, i) => (fenced.has(i + 1) || isTableRow(l) ? "" : l));
	// REPORTED range claims come from prose only (fenced example ranges are
	// illustration). But a SEPARATE census view scans fenced lines too, so a
	// fenced range's own endpoints ("FG-INV-01 through FG-INV-20" in an example)
	// are still excluded from the id census — else they'd seed a spurious
	// namespace with a phantom gap (round-7 #7). Both feed the sol-max #12
	// span-exclusion; only `rangeClaims` is surfaced.
	const rangeClaims = extractRangeClaims(proseLines);
	const censusRangeClaims = extractRangeClaims(censusLines);
	return {
		filePath,
		lineCount: lines.length,
		namespaces: extractIdNamespaces(censusLines, censusRangeClaims),
		looseDefinedIds: extractLooseDefinedIds(censusLines, censusRangeClaims),
		countClaims: extractCountClaims(proseLines),
		rangeClaims,
		headings: extractHeadings(lines, fenced),
		sectionRefs: extractSectionRefs(exampleLines, fenced),
		anchorLinks: extractAnchorLinks(exampleLines, fenced),
		// Path refs and claim sentences don't mask comments internally (unlike
		// headings/refs/links), so feed them the comment-hidden census view — a
		// path or claim inside "<!-- … -->" is not a live fact (round-7 #9).
		pathRefs: extractPathRefs(visibleLines, fenced),
		declaredFacts: extractDeclaredFacts(exampleLines),
		fencedBlocks,
		claimSentences: extractClaimSentences(censusLines, fenced),
	};
}
