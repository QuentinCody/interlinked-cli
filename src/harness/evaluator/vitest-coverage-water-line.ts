// ===========================================
// Vitest coverage denominator — a ratchet water-line
// ===========================================
// `coverage.include` / `coverage.exclude` in a vitest config decide WHICH
// FILES the coverage percentage is measured over. That set is a water-line in
// exactly the sense `.interlinked/coverage-baseline.json` is: adding one
// `exclude` glob raises every coverage number the ratchet reads without
// testing a single line, and the agent being gated can write the file. So the
// same direction rule applies — the denominator may only grow (or hold), never
// shrink.
//
// Blocking demands ~zero false positives, so the comparison is deliberately
// narrow. It runs on the TypeScript AST (the same optional-`typescript` load
// every other AST gate uses, via `parseTsSource`), reads ONLY string-literal
// array members, and treats anything it cannot decide — a spread, an
// identifier, a call, a template with an expression, a syntax error, a missing
// `typescript` — as ALLOW plus a warning naming what it could not read. A
// water-line gate that guesses is worse than one that abstains.
//
// Reached from `config-loosening-gate.ts` (routing + the event-level entry).
// Bypass, shared with the tsconfig-strictness arm and the baseline gate:
// INTERLINKED_DISABLE_BASELINE_GUARD=1.

import type * as TS from "typescript";
import { parseTsSource, type TsModule } from "../checks/cyclomatic-ast.js";
import type { HarnessDecision } from "../types.js";

/** vitest.config.<ext>, vitest.<lane>.config.<ext>, vite.config.<ext>.
 *  `[cm]?[jt]s` covers ts / mts / cts / js / mjs / cjs. */
const VITEST_CONFIG_BASENAME_RE = /(?:^|\/)(?:vitest(?:\.[^/]+)?|vite)\.config\.[cm]?[jt]s$/;

/** Public API — the routing predicate. `config-loosening-gate.ts` ORs this
 *  into its own basename test so the vitest pattern lives in one place. */
export function isVitestConfigFile(filePath: string): boolean {
	return VITEST_CONFIG_BASENAME_RE.test(filePath.replace(/\\/g, "/"));
}

/** `null` = the key is absent from the coverage block. Absent is NOT the same
 *  as empty: vitest substitutes its own defaults, so an absent side is never
 *  compared against a present one. */
export interface CoverageArrays {
	include: string[] | null;
	exclude: string[] | null;
}

export type CoverageExtraction =
	| { kind: "ok"; arrays: CoverageArrays }
	| { kind: "unavailable" }
	| { kind: "parse_error"; detail: string }
	| { kind: "undecidable"; detail: string };

/** Every extraction outcome that is not a comparable pair of sets. */
type NonOkExtraction = Exclude<CoverageExtraction, { kind: "ok" }>;

export type WaterLineVerdict =
	| { kind: "allow"; warning?: string | undefined }
	| { kind: "block"; reason: string };

const COVERAGE_KEYS = ["include", "exclude"] as const;
type CoverageKey = (typeof COVERAGE_KEYS)[number];

// ==========================================================================
// AST extraction
// ==========================================================================

/** A short, single-line quotation of a node, for naming what we could not
 *  read. Never load-bearing — only ever embedded in a message. */
function snippet(node: TS.Node): string {
	let text: string;
	try {
		text = node.getText();
	} catch {
		return "<unreadable>";
	}
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

function propertyName(ts: TsModule, name: TS.PropertyName): string | null {
	if (ts.isIdentifier(name)) return name.text;
	if (ts.isStringLiteral(name)) return name.text;
	return null;
}

/**
 * `parseDiagnostics` is the only syntax-error signal a standalone
 * `createSourceFile` exposes (a Program would be far too expensive on the hook
 * path). It is a TS-internal field, so an absent one is read as "clean" —
 * fail-open toward allow, matching every other abstention here.
 */
function parseErrorCount(sf: TS.SourceFile): number {
	// SAFETY: `parseDiagnostics` is present on every SourceFile the parser
	// produces but is absent from the PUBLIC `ts.SourceFile` type, so the only
	// way to read it is a structural cast. The cast asserts nothing about the
	// value — the `Array.isArray` guard below narrows it, and an absent or
	// unexpected shape degrades to 0 (allow).
	const diagnostics = (sf as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
	return Array.isArray(diagnostics) ? diagnostics.length : 0;
}

/** Every `coverage: { … }` object literal in the file, at any depth. More than
 *  one means we cannot tell which config vitest actually loads. */
function findCoverageObjects(ts: TsModule, sf: TS.SourceFile): TS.ObjectLiteralExpression[] {
	const found: TS.ObjectLiteralExpression[] = [];
	const visit = (node: TS.Node): void => {
		if (
			ts.isPropertyAssignment(node) &&
			propertyName(ts, node.name) === "coverage" &&
			ts.isObjectLiteralExpression(node.initializer)
		) {
			found.push(node.initializer);
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(sf, visit);
	return found;
}

/** String-literal members of an array-literal initializer, or a human reason
 *  the array cannot be compared. A no-substitution template (`` `a/**` ``) is
 *  a literal; a template WITH an expression is not. */
function readArrayMembers(
	ts: TsModule,
	key: CoverageKey,
	initializer: TS.Expression,
): { members: string[] } | { detail: string } {
	if (!ts.isArrayLiteralExpression(initializer)) {
		return { detail: `coverage.${key} is not an array literal (${snippet(initializer)})` };
	}
	const members: string[] = [];
	for (const element of initializer.elements) {
		if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
			members.push(element.text);
			continue;
		}
		return { detail: `coverage.${key} contains a non-literal member: ${snippet(element)}` };
	}
	return { members };
}

type PropOutcome =
	| { kind: "skip" }
	| { kind: "members"; key: CoverageKey; members: string[] }
	| { kind: "undecidable"; detail: string };

function readCoverageProperty(ts: TsModule, prop: TS.ObjectLiteralElementLike): PropOutcome {
	if (ts.isSpreadAssignment(prop)) {
		return {
			kind: "undecidable",
			detail: `the coverage object contains a spread (${snippet(prop)}), so include/exclude may be inherited from elsewhere`,
		};
	}
	const name = propertyName(ts, prop.name);
	if (name !== "include" && name !== "exclude") return { kind: "skip" };
	if (!ts.isPropertyAssignment(prop)) {
		return {
			kind: "undecidable",
			detail: `coverage.${name} is not a plain property assignment (${snippet(prop)})`,
		};
	}
	const read = readArrayMembers(ts, name, prop.initializer);
	if ("detail" in read) return { kind: "undecidable", detail: read.detail };
	return { kind: "members", key: name, members: read.members };
}

function readIncludeExclude(ts: TsModule, obj: TS.ObjectLiteralExpression): CoverageExtraction {
	const arrays: CoverageArrays = { include: null, exclude: null };
	for (const prop of obj.properties) {
		const outcome = readCoverageProperty(ts, prop);
		if (outcome.kind === "undecidable") return { kind: "undecidable", detail: outcome.detail };
		if (outcome.kind === "members") arrays[outcome.key] = outcome.members;
	}
	return { kind: "ok", arrays };
}

/**
 * Public API — pull `coverage.include` / `coverage.exclude` out of one vitest
 * config's source text. Exported for tests and for any future caller that
 * wants the sets rather than the verdict.
 */
export function extractVitestCoverageArrays(content: string, filePath: string): CoverageExtraction {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return { kind: "unavailable" };
	const { ts, sf } = parsed;
	const errors = parseErrorCount(sf);
	if (errors > 0) return { kind: "parse_error", detail: `${errors} syntax error(s)` };
	const [first, second] = findCoverageObjects(ts, sf);
	if (first === undefined) return { kind: "ok", arrays: { include: null, exclude: null } };
	if (second !== undefined) {
		return {
			kind: "undecidable",
			detail: "more than one `coverage:` object literal in this file",
		};
	}
	return readIncludeExclude(ts, first);
}

// ==========================================================================
// Comparison
// ==========================================================================

/** Members present in `proposed` but not in `head`. Set semantics, so
 *  reordering and duplication are invisible. A `null` on either side means the
 *  two are not comparable (see {@link CoverageArrays}) — never a difference. */
function newMembers(head: string[] | null, proposed: string[] | null): string[] {
	if (head === null || proposed === null) return [];
	const known = new Set(head);
	return [...new Set(proposed)].filter((member) => !known.has(member));
}

function quoteList(members: string[]): string {
	return members.map((member) => `"${member}"`).join(", ");
}

function blockReasonText(filePath: string, lines: string[]): string {
	return (
		`BLOCKED: this edit loosens the vitest coverage denominator in ${filePath}:\n  ${lines.join("\n  ")}\n\n` +
		"The coverage include/exclude set is a ratchet water-line, exactly like `.interlinked/coverage-baseline.json`: " +
		"shrinking the denominator raises every coverage number without adding one test. Cover the code (or delete it) " +
		"instead of removing it from the measurement. Intentional reset: INTERLINKED_DISABLE_BASELINE_GUARD=1."
	);
}

/** A present-vs-absent array pair is not comparable — vitest substitutes its
 *  own defaults for the absent side. Say so rather than guessing. */
function presenceWarning(
	filePath: string,
	key: CoverageKey,
	head: string[] | null,
	proposed: string[] | null,
): string | null {
	if (head === null && proposed !== null) {
		return `[interlinked:coverage-water-line] coverage.${key} was INTRODUCED in ${filePath} where HEAD had none. A declared array replaces vitest's defaults, so the two are not comparable and this edit was not gated — check the denominator by hand.`;
	}
	if (head !== null && proposed === null) {
		return `[interlinked:coverage-water-line] coverage.${key} was REMOVED from ${filePath}. Vitest's defaults apply again, so the two are not comparable and this edit was not gated — check the denominator by hand.`;
	}
	return null;
}

function compareArrays(
	filePath: string,
	head: CoverageArrays,
	proposed: CoverageArrays,
): WaterLineVerdict {
	const addedExcludes = newMembers(head.exclude, proposed.exclude);
	const droppedIncludes = newMembers(proposed.include, head.include);
	const lines: string[] = [];
	if (addedExcludes.length > 0) {
		lines.push(`[coverage.exclude] adds ${addedExcludes.length}: ${quoteList(addedExcludes)}`);
	}
	if (droppedIncludes.length > 0) {
		lines.push(`[coverage.include] drops ${droppedIncludes.length}: ${quoteList(droppedIncludes)}`);
	}
	if (lines.length > 0) return { kind: "block", reason: blockReasonText(filePath, lines) };
	const warning =
		presenceWarning(filePath, "exclude", head.exclude, proposed.exclude) ??
		presenceWarning(filePath, "include", head.include, proposed.include);
	return warning === null ? { kind: "allow" } : { kind: "allow", warning };
}

function nonOkWarning(filePath: string, side: string, result: NonOkExtraction): string {
	if (result.kind === "unavailable") {
		return `[interlinked:coverage-water-line] the optional \`typescript\` dependency is unavailable, so the coverage denominator in ${filePath} was NOT compared against HEAD. Install it to re-arm the gate.`;
	}
	if (result.kind === "parse_error") {
		return `[interlinked:coverage-water-line] the ${side} version of ${filePath} has a parse error (${result.detail}), so its coverage include/exclude sets were NOT compared. Allowing the edit.`;
	}
	return `[interlinked:coverage-water-line] the ${side} version of ${filePath} is undecidable: ${result.detail}. The coverage include/exclude sets were NOT compared. Allowing the edit.`;
}

/**
 * Public API — the whole decision as a pure function of the two texts.
 *
 * Blocks iff the proposed `coverage.exclude` is a strict superset of HEAD's,
 * or the proposed `coverage.include` is a strict subset of HEAD's. Everything
 * else — reordering, dedupe, reformatting, an untracked file, a widened
 * include, a narrowed exclude, and every undecidable shape — allows.
 */
export function decideVitestCoverageWaterLine(
	filePath: string,
	headText: string,
	proposedText: string,
): WaterLineVerdict {
	// No HEAD blob: the file is untracked (or newly added), so there is no
	// committed water-line to ratchet against yet.
	if (!headText) return { kind: "allow" };
	const head = extractVitestCoverageArrays(headText, filePath);
	if (head.kind !== "ok") return { kind: "allow", warning: nonOkWarning(filePath, "HEAD", head) };
	const proposed = extractVitestCoverageArrays(proposedText, filePath);
	if (proposed.kind !== "ok") {
		return { kind: "allow", warning: nonOkWarning(filePath, "proposed", proposed) };
	}
	return compareArrays(filePath, head.arrays, proposed.arrays);
}

// ==========================================================================
// Event-level entry — called from config-loosening-gate.ts
// ==========================================================================

/**
 * Public API — the gate arm. Returns a `block` decision when the edit loosens
 * the denominator; otherwise null (with any abstention warning pushed onto the
 * caller's shared `warnings` array, when one is supplied).
 *
 * `rule_id` is deliberately `config_loosening_gate`: this is one more arm of
 * that gate, and log consumers already group on that id.
 */
export function evaluateVitestCoverageWaterLine(
	filePath: string,
	headText: string,
	proposedText: string,
	warnings?: string[],
): HarnessDecision | null {
	if (process.env.INTERLINKED_DISABLE_BASELINE_GUARD === "1") return null;
	const verdict = decideVitestCoverageWaterLine(filePath, headText, proposedText);
	if (verdict.kind === "allow") {
		if (verdict.warning !== undefined) warnings?.push(verdict.warning);
		return null;
	}
	return {
		decision: "block",
		reason: verdict.reason,
		rule_id: "config_loosening_gate",
		severity: "high",
		category: "config",
	};
}
