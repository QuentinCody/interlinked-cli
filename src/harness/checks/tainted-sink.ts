// Tainted-to-privileged-sink check.
//
// Local intra-file flow: detects when external-input values reach a
// privileged sink (`eval`, `new Function`, `vm.run*`, `child_process.exec*`,
// `fs.writeFile*`, etc.) without passing through a recognized validator
// (zod/valibot `.parse`/`.safeParse`, `.validate`, typeof/instanceof/
// Array.isArray guards, allow-list `.has(...)`).
//
// Does NOT ride `taint-tracker.ts` — that tracker is session/file-level
// Bell-LaPadula sensitivity, not intra-file variable taint. Sits alongside
// `unvalidated_json_boundary` rather than extending its detector.
//
// JS analog of Firefox 2023817 (parent process trusted sandbox-supplied
// input). Advisory until dogfood signal supports promotion.

import { nonNull } from "../../lib/non-null.js";
import { isSanitized, load as loadSanitizerRegistry } from "../sanitizer-registry.js";
import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

/**
 * Lazy-load the sanitizer registry once per process. The registry file is
 * project-local and small; loading on first use avoids paying the I/O cost
 * for callers that never reach the tainted-flow path. The registry is
 * memoized in-memory; the daemon's hot-reload watcher
 * (`watchSanitizerFiles`) will be wired in a later phase.
 */
let cachedRegistry: ReturnType<typeof loadSanitizerRegistry> | null = null;
function getRegistry(): ReturnType<typeof loadSanitizerRegistry> {
	if (cachedRegistry === null) cachedRegistry = loadSanitizerRegistry();
	return cachedRegistry;
}

/**
 * Test-only hook. The lazy registry cache can hold a stale view across test
 * files that mutate the on-disk config; tests call this to drop the cache
 * before reloading. Public API — consumed by future migration tests.
 */
export function _resetSanitizerRegistryCacheForTests(): void {
	cachedRegistry = null;
}

const REPORT_LINE_TRUNC = 150;
const MAX_MATCHES_PER_FILE = 10;

// External input source pattern.
const EXTERNAL_INPUT = String.raw`(?:\b(?:req|request)\.(?:body|query|params)\.\w+|\bprocess\.argv\b|\bprocess\.env\.\w+)`;

// Privileged sink call openings. Each must capture the opening `(` so we
// can scan forward for the first argument.
const SINK_PATTERNS: { re: RegExp; label: string }[] = [
	{ re: /\beval\s*\(/g, label: "eval" },
	{ re: /\bnew\s+Function\s*\(/g, label: "new Function" },
	{ re: /\bvm\.run\w*\s*\(/g, label: "vm.run*" },
	// `<receiver>.exec*(` form (namespace import: cp.exec, child_process.exec).
	{ re: /\b[\w$]+\.exec(?:Sync|File|FileSync)?\s*\(/g, label: "child_process.exec*" },
	// Bare `exec*(` form (named import). Lookbehind excludes `<x>.exec(`,
	// `myExec(`, etc. — only matches standalone `exec(`/`execSync(`/etc.
	{ re: /(?<![\w.$])exec(?:Sync|File|FileSync)?\s*\(/g, label: "exec from child_process" },
	{
		re: /\bfs\.(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\s*\(/g,
		label: "fs.write*",
	},
];

// The previous inline VALIDATOR_PATTERNS list moved to the sanitizer
// registry as the `identity` sink-class defaults
// (`.interlinked/sanitizers.json`). The migration preserves every prior
// tainted-sink.test.ts case — see the parity-pinning suite in
// `src/harness/__tests__/sanitizer-registry.test.ts` for the contract.
// Detector queries the registry via
// `isSanitized(getRegistry(), "identity", rhs)`.

/** Find the matching closing paren for the `(` at `openParenIdx`. */
function findCloseParen(s: string, openParenIdx: number): number {
	let depth = 0;
	const end = Math.min(s.length, openParenIdx + 4000);
	for (let i = openParenIdx; i < end; i++) {
		const c = s.charAt(i);
		if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return -1;
}

/** Extract the first comma-separated argument of a call whose opening
 * paren is at `openParenIdx`. Returns the argument text and its end index
 * within `s`. */
function extractFirstArg(
	s: string,
	openParenIdx: number,
): { arg: string; endIdx: number } | null {
	const close = findCloseParen(s, openParenIdx);
	if (close < 0) return null;
	let depth = 0;
	for (let i = openParenIdx + 1; i < close; i++) {
		const c = s.charAt(i);
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) {
			return { arg: s.slice(openParenIdx + 1, i), endIdx: i };
		}
	}
	return { arg: s.slice(openParenIdx + 1, close), endIdx: close };
}

interface TaintedAssignment {
	offset: number;
	validatedAtAssignment: boolean;
}

/** Shared read-only state for evaluating each sink-call occurrence found in the file. */
interface SinkScanContext {
	stripped: string;
	externalInputRe: RegExp;
	taintedAssignments: Map<string, TaintedAssignment>;
	/** Records a match at `offset`; returns true once the per-file limit is hit. */
	recordMatch: (offset: number) => boolean;
}

/**
 * Decide whether one sink-call occurrence (its opening paren located by
 * `sinkOffset`/`openParenIdx` in `ctx.stripped`) is a tainted-to-sink flow:
 * either the first argument directly contains external input, or it is a
 * bare identifier bound to unvalidated external input with no validator call
 * between the assignment and this sink.
 *
 * Returns true when a match was recorded AND the per-file limit is now
 * reached — the caller's signal to stop scanning entirely. Returns false
 * both when nothing was recorded and when a match was recorded but the
 * limit isn't reached yet (the caller's while loop simply advances either
 * way, exactly as the original inline `continue`/fallthrough did).
 */
function evaluateSinkOccurrence(
	sinkOffset: number,
	openParenIdx: number,
	ctx: SinkScanContext,
): boolean {
	const { stripped, externalInputRe, taintedAssignments, recordMatch } = ctx;
	const argInfo = extractFirstArg(stripped, openParenIdx);
	if (!argInfo) return false;
	const arg = argInfo.arg;

	// Direct: external-input expression appears inside the first arg.
	if (externalInputRe.test(arg)) {
		return recordMatch(sinkOffset);
	}

	// Two-step: arg is a bare identifier matching a tainted assignment, and no
	// validator runs between the assignment and the sink call.
	const bareName = arg.trim().match(/^([A-Za-z_$][\w$]*)$/);
	if (!bareName) return false;
	const bareIdent = nonNull(bareName[1]);
	const tainted = taintedAssignments.get(bareIdent);
	if (!tainted) return false;
	if (tainted.validatedAtAssignment) return false;
	if (tainted.offset > sinkOffset) return false;

	const between = stripped.slice(tainted.offset, sinkOffset);
	const escaped = bareIdent.replace(/[$]/g, "\\$");
	// Validator check is two-tier: any of the generic VALIDATOR_PATTERNS
	// firing somewhere between the assignment and the sink is enough, AND
	// the validator has to plausibly involve `name` (a `.parse(` elsewhere
	// on a different value doesn't count). We check both.
	const namedValidator = new RegExp(
		String.raw`(?:\.(?:parse|safeParse|validate)\s*\(\s*${escaped}\b|\btypeof\s+${escaped}\b|\bArray\.isArray\s*\(\s*${escaped}\b|\b${escaped}\s+instanceof\b|\.has\s*\(\s*${escaped}\b|\bif\b[^;]*\b${escaped}\b[^;]*[;\n])`,
	);
	if (namedValidator.test(between)) return false;

	return recordMatch(sinkOffset);
}

/**
 * Detect external-input values reaching privileged sinks without a
 * recognized validator on the path between source and sink.
 *
 * Up to 10 matches per file.
 */
export function checkTaintedToPrivilegedSink(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	const recordMatch = (offset: number): boolean => {
		const lineNo = stripped.slice(0, offset).split("\n").length;
		if (seen.has(lineNo)) return false;
		seen.add(lineNo);
		matches.push({
			line: lineNo,
			text: (lines[lineNo - 1] || "").trim().slice(0, REPORT_LINE_TRUNC),
		});
		return matches.length >= MAX_MATCHES_PER_FILE;
	};

	const externalInputRe = new RegExp(EXTERNAL_INPUT);
	const exitCheck = (): boolean => matches.length >= MAX_MATCHES_PER_FILE;

	// Track tainted variable names assigned from external input in this file.
	// Map from name -> assignment offset. Only the most recent assignment per
	// name is considered (later assignments shadow earlier ones).
	const taintedAssignments = new Map<string, TaintedAssignment>();
	const assignRe =
		/\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*([^;]+)/g;
	let assignHit: RegExpExecArray | null;
	while ((assignHit = assignRe.exec(stripped))) {
		const name = nonNull(assignHit[1]);
		const rhs = nonNull(assignHit[2]);
		if (!externalInputRe.test(rhs)) continue;
		// If the RHS itself routes through a validator, the bound name is
		// already validated — record but mark validated.
		// The sanitizer registry's `identity` defaults mirror the prior
		// inline VALIDATOR_PATTERNS list verbatim, so this query is exactly
		// equivalent to the previous `.some(re => re.test(rhs))`. See the
		// parity-pinning suite in sanitizer-registry.test.ts.
		const validatedAtAssignment = isSanitized(getRegistry(), "identity", rhs);
		taintedAssignments.set(name, {
			offset: assignHit.index,
			validatedAtAssignment,
		});
	}

	const scanCtx: SinkScanContext = { stripped, externalInputRe, taintedAssignments, recordMatch };

	// Walk each sink pattern.
	for (const { re } of SINK_PATTERNS) {
		const local = new RegExp(re.source, "g");
		let sinkHit: RegExpExecArray | null;
		while ((sinkHit = local.exec(stripped))) {
			if (exitCheck()) return matches;
			const sinkOffset = sinkHit.index;
			const openParenIdx = sinkOffset + sinkHit[0].length - 1;
			if (evaluateSinkOccurrence(sinkOffset, openParenIdx, scanCtx)) return matches;
		}
	}

	return matches;
}
