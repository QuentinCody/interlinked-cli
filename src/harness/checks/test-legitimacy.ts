// Test-legitimacy audit — mutation kills are evidence, not the contract.
//
// This check supplies the static first layer of the test-evidence protocol:
// mutation-directed cases must say which externally meaningful obligation
// they protect, and all JS/TS tests are screened for assertion/import shapes
// that commonly couple a suite to implementation details. Dynamic evidence
// belongs to the mutation factory and is specified in the session synthesis.

import { getExtension, type InlineMatch, isStrictTestFile, JS_TS_EXTS } from "./shared.js";
import { maskCommentsAndStrings } from "./test-hygiene-masking.js";
import { stripComments } from "../strip-helpers.js";

// Exported: mutation-kill-evidence-stop-check.ts (the Stop-time kill-evidence
// nudge) AND mutation-directed-profile.ts (the pre_block severity-remap
// profile, docs/design/luna-gate-audit-2026-08-14.md §3a) reuse this exact
// file-class definition rather than redefining it — a second regex
// expressing "mutation-directed path" would be the same drift the repo's
// own duplicated_policy_constant check exists to catch, just for a pattern
// instead of a numeric literal.
// ONE grammar, two anchorings. `MUTATION_DIRECTED_TOKEN` is the alternation
// itself; the PATH form matches it as a dotted segment anywhere in a path, and
// the SUFFIX form matches it at the END of a test-suffix-stripped basename.
// Consumers that need "what SUT does `foo.mutation-kill.test.ts` name?" use the
// suffix form — before it existed, checkTestMissingSutImport stripped only
// `.test.ts` and looked for a phantom `./foo.mutation-kill` companion, which
// false-fired on every mutation-directed suite in the tree (followup #24).
// A model/wave qualifier may follow the semantic token. This keeps names such
// as `.mutation-kill-luna.test.ts` inside the same policy class instead of
// silently downgrading them to ordinary tests. The dotted boundary remains
// mandatory, so an unrelated basename containing "mutation-kill" is not swept
// in accidentally.
const MUTATION_DIRECTED_TOKEN = "(?:mutation-(?:kill|hardening)|survivors?)(?:-[a-z0-9]+)*";
export const MUTATION_DIRECTED_PATH = new RegExp(`\\.(?:${MUTATION_DIRECTED_TOKEN})\\.`, "i");
export const MUTATION_DIRECTED_SUFFIX = new RegExp(`\\.(?:${MUTATION_DIRECTED_TOKEN})$`, "i");
export const TEST_CASE_LINE =
	/^\s*(?:it|test|specify)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|todo|failing|sequential))*\s*\(/;
const CONTRACT_MARKER =
	/^\s*\/\/\s*test-contract:\s*(public-api|invariant|bug|security|boundary)\s*(?:—|--|:)\s*(\S.*)\s*$/i;
export const BROAD_TRUTHINESS =
	/\bexpect\s*\([^;\n]*\)\s*(?:\.(?:resolves|rejects|not)\s*)*\.toBe(?:Truthy|Falsy)\s*\(/;
const CALL_ORDER =
	/\.(?:toHaveBeenNthCalledWith|toHaveBeenNthCalled|toHaveBeenCalledBefore|toHaveBeenCalledAfter)\s*\(|\.invocationCallOrder\b/;
const IMPORT_DECLARATION =
	/^[ \t]*import\b(?:[\s\S]*?\bfrom\s*)?["']([^"'\n]+)["'][ \t]*;?/gm;
const REQUIRE_DECLARATION = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const PRIVATE_MODULE_SEGMENT = /(?:^|\/)(?:internal|private)(?:\/|$)|(?:^|[/.-])(?:internal|private)$/i;
const PRIVATE_NAMED_IMPORT =
	/(?:^|[,{])\s*(?:type\s+)?(?:_{1,}[A-Za-z$][\w$]*|Internal[A-Za-z$][\w$]*|[A-Za-z$][\w$]*(?:ForTests|ForTestOnly|TestOnly|Internal))\b/;
const GENERIC_RATIONALE =
	/^(?:the\s+)?(?:test|behavior|works?|mutation|mutant|survivor|coverage|requirement|contract|public\s+api)$/i;
const MAX_MATCHES = 20;

function trimmedLine(lines: readonly string[], index: number): string {
	return (lines[index] ?? "").trim().slice(0, 150);
}

function pushMatch(matches: InlineMatch[], lines: readonly string[], index: number): void {
	if (matches.length >= MAX_MATCHES) return;
	matches.push({ line: index + 1, text: trimmedLine(lines, index) });
}

// Exported so mutation-directed-profile.ts can classify checkTestLegitimacy's
// merged output (receipt-missing vs broad-truthiness/call-order) by its
// stable `.text` prefix instead of re-deriving the marker-adjacency scan.
export const RECEIPT_MISSING_PREFIX = "missing test-contract for mutation-directed case: ";

function pushMissingContract(matches: InlineMatch[], lines: readonly string[], index: number): void {
	if (matches.length >= MAX_MATCHES) return;
	const declaration = trimmedLine(lines, index);
	matches.push({
		line: index + 1,
		text: `${RECEIPT_MISSING_PREFIX}${declaration}`.slice(0, 150),
	});
}

function isSpecificContractMarker(line: string): boolean {
	const match = CONTRACT_MARKER.exec(line);
	if (!match) return false;
	const rationale = (match[2] ?? "").trim();
	return rationale.length >= 12 && !GENERIC_RATIONALE.test(rationale);
}

/** A marker grounds exactly the next case, not the rest of the file. */
function hasAdjacentContractMarker(lines: readonly string[], caseLine: number): boolean {
	let inspected = 0;
	for (let i = caseLine - 1; i >= 0 && inspected < 4; i--) {
		const candidate = (lines[i] ?? "").trim();
		if (candidate === "") continue;
		inspected++;
		if (isSpecificContractMarker(candidate)) return true;
		// Other comments may carry a decorator/reference between receipt and case.
		// Executable code means the receipt belongs to a different case.
		if (!candidate.startsWith("//") && !candidate.startsWith("@")) return false;
	}
	return false;
}

function importedPrivateSurface(statement: string, source: string): boolean {
	if (source !== "" && PRIVATE_MODULE_SEGMENT.test(source)) return true;
	const open = statement.indexOf("{");
	const close = statement.indexOf("}", open + 1);
	return open >= 0 && close > open && PRIVATE_NAMED_IMPORT.test(statement.slice(open + 1, close));
}

function lineIndexAt(content: string, offset: number): number {
	let line = 0;
	for (let i = 0; i < offset; i++) {
		if (content.charCodeAt(i) === 10) line++;
	}
	return line;
}

/** Prefix of the trailing count summary, so a consumer can tell a count line
 *  from a finding line without re-deriving its wording. */
export const TRUNCATION_SUMMARY_PREFIX = "…and ";

/**
 * Trailing summary carrying the TRUE total, appended only when the scan saw
 * more than `MAX_MATCHES` allowed it to list. Without it the finding reports
 * exactly 20 for a file with 43 missing contract markers — an under-count that
 * reads as "you are nearly done" (followup #27, measured 2026-08-16). Its line
 * is the last listed finding's; a summary is a count, not a location.
 */
function appendTruncationSummary(matches: InlineMatch[], total: number): void {
	const listed = matches.length;
	if (total <= listed) return;
	matches.push({
		line: matches[listed - 1]?.line ?? 1,
		text: `${TRUNCATION_SUMMARY_PREFIX}${total - listed} more — this file has ${total} test-legitimacy finding(s); the ${listed} above are the first of them.`,
	});
}

/** Scan formatter-shaped multi-line imports after comments are blanked. Returns
 *  how many it SAW; `pushMatch` decides how many of those get listed. */
function pushPrivateImports(matches: InlineMatch[], content: string, lines: readonly string[]): number {
	const commentFree = stripComments(content);
	const codeMask = maskCommentsAndStrings(content);
	let total = 0;
	for (const match of commentFree.matchAll(IMPORT_DECLARATION)) {
		const statement = match[0];
		const source = match[1] ?? "";
		if (!importedPrivateSurface(statement, source)) continue;
		total++;
		pushMatch(matches, lines, lineIndexAt(commentFree, match.index));
	}
	for (const match of commentFree.matchAll(REQUIRE_DECLARATION)) {
		const offset = match.index;
		if ((codeMask[offset] ?? " ").trim() === "") continue;
		if (!PRIVATE_MODULE_SEGMENT.test(match[1] ?? "")) continue;
		total++;
		pushMatch(matches, lines, lineIndexAt(commentFree, offset));
	}
	return total;
}

/**
 * Audit JS/TS tests for missing behavioral grounding and brittle assertion
 * surfaces. Findings are advisory: an internal module, call order, or
 * truthiness assertion can be a published contract, but that needs review.
 *
 * The scan always runs to the end of the file. `MAX_MATCHES` caps the LISTING,
 * never the count — see `appendTruncationSummary`.
 */
export function checkTestLegitimacy(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath) || !JS_TS_EXTS.has(getExtension(filePath))) return [];

	const lines = content.split("\n");
	const codeLines = maskCommentsAndStrings(content).split("\n");
	const matches: InlineMatch[] = [];
	const mutationDirected = MUTATION_DIRECTED_PATH.test(filePath.replace(/\\/g, "/"));
	let total = pushPrivateImports(matches, content, lines);

	for (let i = 0; i < codeLines.length; i++) {
		const codeLine = codeLines[i] ?? "";

		if (mutationDirected && TEST_CASE_LINE.test(codeLine) && !hasAdjacentContractMarker(lines, i)) {
			total++;
			pushMissingContract(matches, lines, i);
			continue;
		}
		if (BROAD_TRUTHINESS.test(codeLine) || CALL_ORDER.test(codeLine)) {
			total++;
			pushMatch(matches, lines, i);
		}
	}

	appendTruncationSummary(matches, total);
	return matches;
}
