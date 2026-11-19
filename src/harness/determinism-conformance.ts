// Determinism-replay conformance harness — proof-of-enforcement §15 step 0.
//
// @determinism-critical — this module IS the determinism substrate; it must not
// itself reach for locale-/FS-order-dependent idioms. The conformance test
// enforces that via `scanDeterminismHazards` + `isDeterminismCritical` below.
//
// `docs/design/proof-of-enforcement.md` rests on ONE empirical assumption: a
// harness check re-executed against the same (content, path, ruleset) produces
// BIT-IDENTICAL findings. If the inline pipeline isn't deterministic
// same-machine, cross-machine refereeing (the whole point of R1) is hopeless —
// so we pin the property here before any signing code gets written.
//
// Scope: the PURE inline detector pipeline (`buildAgentSafetyChecks`: content +
// path -> findings, no FS, no network). External-tool checks (tsc/biome/cargo)
// are a SEPARATE determinism question — their versions get pinned INTO
// `ruleset_hash`, not replayed here.
//
// This module is also the seed of the eventual referee: "compare two runs'
// canonical findings" is the same operation whether the two runs are
// same-process repeats (here) or local-vs-cloud-Sandbox (next).

import { nonNull } from "../lib/non-null.js";
import type { InlineMatch } from "./check-registry/index.js";
import { buildAgentSafetyChecks } from "./check-registry/index.js";
import { stripCommentsAndStrings } from "./checks/shared.js";

/** One finding, flattened from an InlineMatch plus its check's identity. */
export interface ConformanceFinding {
	check_id: string;
	severity: "error" | "warning";
	line: number;
	text: string;
}

/**
 * Run the full-audit inline pipeline once and flatten to findings. Mirrors how
 * `recurrence-scanner.ts` drives the pipeline: a throwing detector is skipped
 * (one buggy check must not abort the run). That skip is itself deterministic
 * given identical input — a detector that throws does so on every run.
 */
export function runInlinePipeline(content: string, filePath: string): ConformanceFinding[] {
	const findings: ConformanceFinding[] = [];
	for (const check of buildAgentSafetyChecks(content, filePath)) {
		let matches: InlineMatch[];
		try {
			matches = check.fn();
		} catch {
			continue;
		}
		for (const m of matches) {
			findings.push({
				check_id: check.name,
				severity: check.severity,
				line: m.line,
				text: m.text,
			});
		}
	}
	return findings;
}

/**
 * Codepoint comparison — deliberately NOT `String.prototype.localeCompare`,
 * which depends on the host locale / ICU version and would itself be a
 * cross-machine determinism bug sitting inside the determinism checker.
 */
function strcmp(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/** Stable total order over findings, every field participating. */
function compareFindings(a: ConformanceFinding, b: ConformanceFinding): number {
	return (
		strcmp(a.check_id, b.check_id) ||
		a.line - b.line ||
		strcmp(a.severity, b.severity) ||
		strcmp(a.text, b.text)
	);
}

/**
 * Canonical, order-independent serialization of a finding set. Sorting makes
 * the comparison insensitive to detector-registration order or per-detector
 * match order — we want to catch CONTENT nondeterminism (timestamps, paths,
 * randomness), not re-flag a legitimate reordering. Two findings differing only
 * in `text` still sort (and serialize) distinctly.
 */
export function canonicalizeFindings(findings: readonly ConformanceFinding[]): string {
	return JSON.stringify([...findings].sort(compareFindings));
}

/** Categories of divergence between two runs, ordered most→least diagnosable. */
export type DivergenceKind = "count" | "timestamp" | "cwd_leak" | "text" | "none";

export interface Divergence {
	kind: DivergenceKind;
	detail: string;
}

// ISO-8601-ish timestamps and 13-digit epoch-millis — the usual `new Date()` /
// `Date.now()` leak shapes if a detector embeds wall-clock in a finding.
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\b\d{13}\b/;

const PREVIEW_CHARS = 80;

function trunc(s: string): string {
	return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s;
}

/**
 * Given two finding sets that are known to differ, name the most likely cause.
 * Operates on canonicalized (sorted) copies, so pure reordering is already
 * normalized away and never surfaces as a divergence.
 */
export function classifyDivergence(
	a: readonly ConformanceFinding[],
	b: readonly ConformanceFinding[],
): Divergence {
	const sa = [...a].sort(compareFindings);
	const sb = [...b].sort(compareFindings);
	if (sa.length !== sb.length) {
		return { kind: "count", detail: `${sa.length} findings vs ${sb.length}` };
	}
	const cwd = process.cwd();
	for (let i = 0; i < sa.length; i++) {
		const fa = sa[i];
		const fb = sb[i];
		if (JSON.stringify(fa) === JSON.stringify(fb)) continue;
		if (nonNull(fa).text !== nonNull(fb).text && (TIMESTAMP_RE.test(nonNull(fa).text) || TIMESTAMP_RE.test(nonNull(fb).text))) {
			return {
				kind: "timestamp",
				detail: `${nonNull(fa).check_id}: "${trunc(nonNull(fa).text)}" vs "${trunc(nonNull(fb).text)}"`,
			};
		}
		if (nonNull(fa).text.includes(cwd) || nonNull(fb).text.includes(cwd)) {
			return { kind: "cwd_leak", detail: `${nonNull(fa).check_id}: working-directory path in finding text` };
		}
		return {
			kind: "text",
			detail: `${nonNull(fa).check_id} L${nonNull(fa).line}: "${trunc(nonNull(fa).text)}" vs "${trunc(nonNull(fb).text)}"`,
		};
	}
	return { kind: "none", detail: "no element-wise difference" };
}

/** First finding whose text embeds the checker's own working directory — a
 *  detector injecting `process.cwd()` is the canonical cross-machine leak. */
function findCwdLeak(findings: readonly ConformanceFinding[]): string | null {
	const cwd = process.cwd();
	for (const f of findings) {
		if (f.text.includes(cwd)) return f.text;
	}
	return null;
}

export interface ConformanceResult {
	stable: boolean;
	runs: number;
	findingCount: number;
	/** Distinct check ids that fired — coverage signal for "this input exercised the pipeline". */
	checkIds: string[];
	/** Present only when `stable` is false. */
	divergence?: Divergence;
	/** Present only when a finding embeds the working directory. */
	cwdLeak?: string;
}

/**
 * Run the pipeline `runs` times on one input and report whether every run
 * produced bit-identical canonical findings.
 */
export function checkRepeatDeterminism(
	content: string,
	filePath: string,
	runs = 3,
): ConformanceResult {
	const first = runInlinePipeline(content, filePath);
	const baseline = canonicalizeFindings(first);
	const checkIds = [...new Set(first.map((f) => f.check_id))].sort(strcmp);
	const cwdLeak = findCwdLeak(first);

	let divergence: Divergence | undefined;
	for (let i = 1; i < runs; i++) {
		const next = runInlinePipeline(content, filePath);
		if (canonicalizeFindings(next) !== baseline) {
			divergence = classifyDivergence(first, next);
			break;
		}
	}

	return {
		stable: !divergence,
		runs,
		findingCount: first.length,
		checkIds,
		...(divergence ? { divergence } : {}),
		...(cwdLeak ? { cwdLeak } : {}),
	};
}

export interface CorpusItem {
	path: string;
	content: string;
}

export interface CorpusReport {
	itemCount: number;
	totalFindings: number;
	distinctChecks: number;
	stableItems: number;
	unstable: Array<{ path: string; divergence: Divergence }>;
	leaks: Array<{ path: string; text: string }>;
}

/** Aggregate `checkRepeatDeterminism` over a corpus. */
export function runCorpusConformance(corpus: readonly CorpusItem[], runs = 3): CorpusReport {
	let totalFindings = 0;
	const allChecks = new Set<string>();
	const unstable: Array<{ path: string; divergence: Divergence }> = [];
	const leaks: Array<{ path: string; text: string }> = [];
	let stableItems = 0;

	for (const item of corpus) {
		const r = checkRepeatDeterminism(item.content, item.path, runs);
		totalFindings += r.findingCount;
		for (const id of r.checkIds) allChecks.add(id);
		if (r.stable) stableItems++;
		else if (r.divergence) unstable.push({ path: item.path, divergence: r.divergence });
		if (r.cwdLeak) leaks.push({ path: item.path, text: r.cwdLeak });
	}

	return {
		itemCount: corpus.length,
		totalFindings,
		distinctChecks: allChecks.size,
		stableItems,
		unstable,
		leaks,
	};
}

// ── Source-level determinism hygiene (opt-in via `@determinism-critical`) ──
//
// The functions above verify the pipeline's RUNTIME determinism. These guard
// the SUBSTRATE's own SOURCE: a file declaring `@determinism-critical` in its
// header must not reach for locale-dependent ordering/formatting or filesystem-
// order iteration — idioms that pass same-machine but diverge across machines.
//
// Scoped by opt-in marker (mirroring `@codegen-data` in large-file-policy.ts) so
// it is zero-FP on the 99% of code that never feeds a hash or canonical form —
// the only place a blanket localeCompare/readdir ban is noise (16 + 102 mostly-
// legitimate sites across this repo, May 2026). Wall-clock/RNG nondeterminism is
// already covered by `checkUntestableTimeInSource` in `checks/agent-laziness.ts`.

const DETERMINISM_CRITICAL_MARKER = "@determinism-critical";

/** True iff the file opts into strict determinism hygiene (header scan, first 30 lines). */
export function isDeterminismCritical(content: string): boolean {
	return content.split("\n", 30).join("\n").includes(DETERMINISM_CRITICAL_MARKER);
}

export interface DeterminismHazard {
	line: number;
	kind: "locale_compare" | "locale_format" | "unsorted_readdir";
	text: string;
}

// `.localeCompare(` — host-locale/ICU-dependent ordering. Use codepoint `<`/`>`
// when the result feeds a hash, canonical form, or cross-machine comparison.
const LOCALE_COMPARE_RE = /\.localeCompare\s*\(/;
// `.toLocale*` — locale-dependent formatting, incl. the Turkish-dotted-I
// `toLocaleLowerCase`/`toLocaleUpperCase` trap.
const LOCALE_FORMAT_RE = /\.toLocale(?:String|DateString|TimeString|LowerCase|UpperCase)\s*\(/;
// `readdir(Sync)(...)` not `.sort()`-ed on the same line — FS enumeration order
// is machine-dependent.
const READDIR_RE = /\breaddir(?:Sync)?\s*\(/;
const SORT_RE = /\.sort\s*\(/;

/**
 * Flag locale-/FS-order-dependent idioms in a file's source. Intended for files
 * that opted in via `isDeterminismCritical` — on those the FP rate is near-zero
 * because the author declared the file must be deterministic. Comments and
 * string literals are stripped first so the words don't match inside prose.
 */
export function scanDeterminismHazards(content: string): DeterminismHazard[] {
	const stripped = stripCommentsAndStrings(content).split("\n");
	const raw = content.split("\n");
	const hazards: DeterminismHazard[] = [];
	for (let i = 0; i < stripped.length; i++) {
		const sl = nonNull(stripped[i]);
		const text = nonNull(raw[i]).trim().slice(0, 110);
		if (LOCALE_COMPARE_RE.test(sl)) hazards.push({ line: i + 1, kind: "locale_compare", text });
		if (LOCALE_FORMAT_RE.test(sl)) hazards.push({ line: i + 1, kind: "locale_format", text });
		if (READDIR_RE.test(sl) && !SORT_RE.test(sl)) {
			hazards.push({ line: i + 1, kind: "unsorted_readdir", text });
		}
	}
	return hazards;
}
