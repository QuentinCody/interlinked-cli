// interlinked-tdd: exempt
// Property-test enforcement (B3 "detect-asymmetry"): inverse pairs with no
// round-trip test. An exported inverse pair (encode/decode, serialize/
// deserialize, to<X>/from<X>, …) defined in one module whose round-trip law is
// exercised by NO project test file is a property-test gap: `decode(encode(x))
// === x` is the cheapest high-mutation-kill test you can add, and its absence
// means the round trip is unverified. Advisory — a round-trip test imported
// under an alias, or living in a suite the basename prefilter misses, reads as
// "untested" (FN-tolerant by design; see DEFAULT_ADVISORY_SKIPS rationale).
//
// Deterministic: regex over exported names + a bounded, git-listed test-file
// scan (mirrors checkDeadExports). No execution, no model. Plan:
// docs/plans/free-cli-adoption/21-property-test-enforcement.md.

import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import { getGitSourceFiles } from "./export-ripple.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS } from "./shared.js";

/**
 * Inverse verb-stem pairs whose round-trip law (`inverse(forward(x)) === x`) is
 * a high-value, low-effort property test. High-confidence pairs only — grow
 * from real FPs, not speculation. `read`/`write` and `parse`/`format` are
 * deliberately omitted (frequently NOT round-trippable).
 */
const INVERSE_VERB_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["encode", "decode"],
	["serialize", "deserialize"],
	["stringify", "parse"],
	["marshal", "unmarshal"],
	["compress", "decompress"],
	["encrypt", "decrypt"],
	["pack", "unpack"],
	["pickle", "unpickle"],
];

interface ExportedName {
	name: string;
	/** 1-based declaration line. */
	line: number;
}

/**
 * Extract exported function-like names with their 1-based declaration line.
 * Self-contained regex (mirrors the taste-check exported-function patterns):
 * `export function`, `export const NAME = (…) =>` / `= function`, and
 * `export default function NAME`. Non-function exports (`export const X = 5`)
 * do not match.
 */
function extractExportedNames(content: string): ExportedName[] {
	const out: ExportedName[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i];
		let m = nonNull(t).match(/^\s*export\s+(?:async\s+)?function\s+(\w+)\s*[<(]/);
		if (m) {
			out.push({ name: nonNull(m[1]), line: i + 1 });
			continue;
		}
		m = nonNull(t).match(
			/^\s*export\s+(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\()/,
		);
		if (m) {
			out.push({ name: nonNull(m[1]), line: i + 1 });
			continue;
		}
		m = nonNull(t).match(/^\s*export\s+default\s+(?:async\s+)?function\s+(\w+)\s*[<(]/);
		if (m) out.push({ name: nonNull(m[1]), line: i + 1 });
	}
	return out;
}

interface InversePair {
	forward: ExportedName;
	inverse: ExportedName;
	/** Human-readable law, e.g. "decode(encode(x)) === x". */
	law: string;
}

/**
 * Strip a verb affix from a name, matching a camelCase prefix (`encodeToon` →
 * "toon"), a suffix (`toonEncode` → "toon"), or the bare verb (`encode` → "").
 * Case-insensitive; returns null when the verb is not an affix.
 */
function verbRemainder(name: string, verb: string): string | null {
	const lower = name.toLowerCase();
	if (lower === verb) return "";
	if (lower.startsWith(verb)) return lower.slice(verb.length);
	if (lower.endsWith(verb)) return lower.slice(0, lower.length - verb.length);
	return null;
}

/**
 * Exported (forward, inverse) name pairs for ONE verb pair: both halves share
 * the same remainder once their verb affix is stripped. Declaration order is
 * preserved (forward outer, inverse inner) so callers see a stable sequence.
 */
function verbPairMatches(
	exported: ExportedName[],
	fwdVerb: string,
	invVerb: string,
): Array<readonly [ExportedName, ExportedName]> {
	const found: Array<readonly [ExportedName, ExportedName]> = [];
	for (const fwd of exported) {
		const rFwd = verbRemainder(fwd.name, fwdVerb);
		if (rFwd === null) continue;
		for (const inv of exported) {
			if (inv.name === fwd.name) continue;
			const rInv = verbRemainder(inv.name, invVerb);
			if (rInv === null || rInv !== rFwd) continue;
			found.push([fwd, inv]);
		}
	}
	return found;
}

/** Find confirmed inverse pairs (both halves exported, remainders equal). */
function findInversePairs(exported: ExportedName[]): InversePair[] {
	const pairs: InversePair[] = [];
	const seen = new Set<string>();
	const add = (forward: ExportedName, inverse: ExportedName, law: string): void => {
		const key = `${forward.name}|${inverse.name}`;
		if (seen.has(key)) return;
		seen.add(key);
		pairs.push({ forward, inverse, law });
	};

	for (const [fwdVerb, invVerb] of INVERSE_VERB_PAIRS) {
		for (const [fwd, inv] of verbPairMatches(exported, fwdVerb, invVerb)) {
			add(fwd, inv, `${inv.name}(${fwd.name}(x)) === x`);
		}
	}

	// to<X> / from<X>
	const toMap = new Map<string, ExportedName>();
	const fromMap = new Map<string, ExportedName>();
	for (const e of exported) {
		const toM = e.name.match(/^to([A-Z]\w*)$/);
		if (toM) {
			toMap.set(nonNull(toM[1]).toLowerCase(), e);
			continue;
		}
		const fromM = e.name.match(/^from([A-Z]\w*)$/);
		if (fromM) fromMap.set(nonNull(fromM[1]).toLowerCase(), e);
	}
	for (const [rem, toFn] of toMap) {
		const fromFn = fromMap.get(rem);
		if (fromFn) add(toFn, fromFn, `${toFn.name}(${fromFn.name}(x)) === x`);
	}
	return pairs;
}

/** Whether any candidate test content references BOTH names (a round-trip test). */
function pairHasRoundTripTest(a: string, b: string, testContents: string[]): boolean {
	const reA = new RegExp(`\\b${a}\\b`);
	const reB = new RegExp(`\\b${b}\\b`);
	for (const tc of testContents) {
		if (reA.test(tc) && reB.test(tc)) return true;
	}
	return false;
}

/**
 * Contents of the project test files that could plausibly exercise `filePath`.
 *
 * Path-prefilter (no read): test files whose path mentions this module's
 * basename — a test usually imports the module, so the import path carries the
 * basename. Bounds reads to the handful of co-located suites. Returns null when
 * the file lies outside `cwd`, which callers treat as "nothing to report".
 */
function readCompanionTestContents(filePath: string, cwd: string): string[] | null {
	const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	const relFromRoot = relative(cwd, absPath);
	if (relFromRoot.startsWith("..")) return null;
	const baseNoExt = (relFromRoot.split("/").pop() || "").replace(
		/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/,
		"",
	);

	const candidates = baseNoExt
		? getGitSourceFiles(cwd)
				.filter((f) => f !== relFromRoot && isTestFile(f) && f.includes(baseNoExt))
				.slice(0, 50)
		: [];
	const testContents: string[] = [];
	for (const rel of candidates) {
		let tc: string;
		try {
			tc = readFileSync(join(cwd, rel), "utf-8");
		} catch {
			continue;
		}
		testContents.push(tc);
	}
	return testContents;
}

/**
 * Detect exported inverse pairs (encode/decode, serialize/deserialize,
 * to<X>/from<X>, …) that no project test file round-trips. The hot path returns
 * with ZERO file reads when the edited file has no inverse pair (the common
 * case); only a file that actually declares a pair pays the bounded test scan.
 */
export function checkUntestedInversePair(
	content: string,
	filePath: string,
	cwd: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_EXTS.has(ext)) return [];
	if (filePath.endsWith(".d.ts")) return [];
	if (isTestFile(filePath)) return [];

	const exported = extractExportedNames(content);
	if (exported.length < 2) return [];
	const pairs = findInversePairs(exported);
	if (pairs.length === 0) return [];

	const testContents = readCompanionTestContents(filePath, cwd);
	if (testContents === null) return [];

	const matches: InlineMatch[] = [];
	for (const pair of pairs) {
		if (matches.length >= 10) break;
		if (pairHasRoundTripTest(pair.forward.name, pair.inverse.name, testContents)) continue;
		matches.push({
			line: pair.forward.line,
			text: `[inverse pair ${pair.forward.name}/${pair.inverse.name} has no round-trip test — add a property test asserting ${pair.law}]`,
		});
	}
	return matches;
}

// ===========================================
// B2 — untested idempotent-shaped functions
// ===========================================

/**
 * Normalization / canonicalization verbs whose idempotence law
 * (`f(f(x)) === f(x)`) is a high-value, low-effort property test. These names
 * advertise a stable fixed point: applying the function a second time should
 * change nothing. High-confidence verbs only — grow from real FPs. Matched as a
 * camelCase prefix (`normalizeFoo`) or the whole name (`sanitize`), never as a
 * suffix (`fastNormalize` is a different shape and not asserted here).
 */
const IDEMPOTENT_VERBS: readonly string[] = [
	"normalize",
	"canonicalize",
	"canonical",
	"sanitize",
	"dedupe",
	"dedup",
	"slugify",
	"simplify",
	"clean",
];

/**
 * Whether `name` is shaped like an idempotent operation: it equals one of the
 * idempotent verbs, or begins with one as a camelCase prefix (verb followed by
 * an uppercase letter — `normalizePath` matches, `normalized` does not). Longer
 * verbs are tested first so `canonicalize` wins over its `canonical` prefix.
 */
function idempotentVerbMatch(name: string): string | null {
	const verbs = [...IDEMPOTENT_VERBS].sort((a, b) => b.length - a.length);
	for (const verb of verbs) {
		if (name === verb) return verb;
		if (name.startsWith(verb)) {
			const next = name.charAt(verb.length);
			if (next >= "A" && next <= "Z") return verb;
		}
	}
	return null;
}

/**
 * Whether the exported declaration at `decl.line` takes at least one argument.
 * Reads the signature starting at the declaration line and inspects the first
 * top-level parameter list: a non-empty `(…)` means arity ≥ 1. Used to skip
 * zero-arg names (`sanitize()` with no input has no `x` to feed the law).
 */
function exportTakesArg(content: string, decl: ExportedName): boolean {
	const lines = content.split("\n");
	const startIdx = decl.line - 1;
	if (startIdx < 0 || startIdx >= lines.length) return false;
	let sig = "";
	for (let i = startIdx; i < Math.min(startIdx + 20, lines.length); i++) {
		const line = lines[i];
		if (line === undefined) break;
		sig += line;
		if (line.includes("{") || line.includes("=>")) break;
	}
	return firstParamList(sig).trim().length > 0;
}

/**
 * Contents of the FIRST top-level `(…)` group in a signature, up to the
 * matching close paren. Returns "" when the signature has no `(`.
 */
function firstParamList(sig: string): string {
	const open = sig.indexOf("(");
	if (open === -1) return "";
	let depth = 0;
	let params = "";
	for (let i = open; i < sig.length; i++) {
		const ch = sig[i];
		if (ch === "(") {
			depth++;
			if (depth === 1) continue;
		} else if (ch === ")") {
			depth--;
			if (depth === 0) break;
		}
		if (depth >= 1) params += ch;
	}
	return params;
}

/** Whether any candidate test content references `name`. */
function nameHasTest(name: string, testContents: string[]): boolean {
	const re = new RegExp(`\\b${name}\\b`);
	for (const tc of testContents) {
		if (re.test(tc)) return true;
	}
	return false;
}

/**
 * Detect exported functions that are idempotent-SHAPED — a normalization /
 * canonicalization verb name (`normalize`, `sanitize`, `slugify`, …) taking at
 * least one argument — that no project test file references. The idempotence
 * law `f(f(x)) === f(x)` is the cheapest high-mutation-kill test for such a
 * function, and its absence means the fixed point is unverified. Mirrors
 * `checkUntestedInversePair`'s bounded, git-listed test-file scan: zero file
 * reads when the edited file declares no idempotent-shaped export (the common
 * case). Advisory / FN-tolerant — a test under an aliased import or a suite the
 * basename prefilter misses reads as "untested".
 */
export function checkUntestedIdempotent(
	content: string,
	filePath: string,
	cwd: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_EXTS.has(ext)) return [];
	if (filePath.endsWith(".d.ts")) return [];
	if (isTestFile(filePath)) return [];

	const exported = extractExportedNames(content);
	if (exported.length === 0) return [];
	const idempotent = exported.filter(
		(e) => idempotentVerbMatch(e.name) !== null && exportTakesArg(content, e),
	);
	if (idempotent.length === 0) return [];

	const testContents = readCompanionTestContents(filePath, cwd);
	if (testContents === null) return [];

	const matches: InlineMatch[] = [];
	for (const fn of idempotent) {
		if (matches.length >= 10) break;
		if (nameHasTest(fn.name, testContents)) continue;
		matches.push({
			line: fn.line,
			text: `[idempotent-shaped ${fn.name} has no property test — assert ${fn.name}(${fn.name}(x)) === ${fn.name}(x)]`,
		});
	}
	return matches;
}

// ===========================================
// B4b — property-test scaffold generator
// ===========================================

/**
 * Generate a runnable fast-check property test as a string, with a COMMITTED
 * seed so the generated suite is deterministic and refereeable (the same seed
 * reproduces the same input sequence). Pure function — no I/O, no file reads.
 *
 * - `"inverse-pair"` (needs `names.forward` + `names.inverse`): asserts the
 *   round-trip law `inverse(forward(x)) === x`.
 * - `"idempotent"` (needs `names.forward`): asserts the idempotence law
 *   `forward(forward(x)) === forward(x)`.
 *
 * Defaults to `fc.string()` as the arbitrary with a refine-me TODO. The output
 * is copy-pasteable vitest + fast-check.
 */
export function scaffoldPropertyTest(
	kind: "inverse-pair" | "idempotent",
	names: { forward: string; inverse?: string },
): string {
	// Committed seed → deterministic, refereeable runs (same seed = same inputs).
	const seed = 424242;
	const header =
		'import { describe, expect, it } from "vitest";\n' +
		'import fc from "fast-check";\n' +
		"// TODO: refine arbitrary for non-string inputs\n";

	if (kind === "inverse-pair") {
		const inverse = names.inverse ?? "inverse";
		return (
			`${header}\n` +
			`describe("${names.forward}/${inverse} round-trip", () => {\n` +
			`\tit("${inverse}(${names.forward}(x)) === x", () => {\n` +
			"\t\tfc.assert(\n" +
			"\t\t\tfc.property(fc.string(), (x) => {\n" +
			`\t\t\t\texpect(${inverse}(${names.forward}(x))).toStrictEqual(x);\n` +
			"\t\t\t}),\n" +
			`\t\t\t{ seed: ${seed}, endOnFailure: true },\n` +
			"\t\t);\n" +
			"\t});\n" +
			"});\n"
		);
	}

	return (
		`${header}\n` +
		`describe("${names.forward} idempotence", () => {\n` +
		`\tit("${names.forward}(${names.forward}(x)) === ${names.forward}(x)", () => {\n` +
		"\t\tfc.assert(\n" +
		"\t\t\tfc.property(fc.string(), (x) => {\n" +
		`\t\t\t\texpect(${names.forward}(${names.forward}(x))).toStrictEqual(${names.forward}(x));\n` +
		"\t\t\t}),\n" +
		`\t\t\t{ seed: ${seed}, endOnFailure: true },\n` +
		"\t\t);\n" +
		"\t});\n" +
		"});\n"
	);
}
