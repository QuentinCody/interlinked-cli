// The coverage-edit arm of the baseline-integrity gate (sibling of
// lint-baseline-integrity.ts / e2e-baseline-integrity.ts; split out of
// baseline-integrity-gate.ts by the 2026-10-21 red-team hardening so the gate
// stays under the per-file line cap).
//
// `.interlinked/coverage-edit-baseline.json` is the per-edit coverage ledger:
// `{ "<rel path>": <fraction> | { f: <fraction>, scope: <scope id>, hw?: <fraction> } }`
// where `hw` is the cross-scope full-suite high-water (implied by a bare
// number or a full-scope `f`). A hand edit may never lower or delete `hw`. The
// runtime (coverage-obligation-ledger.ts) writes it through internal fs calls
// that never reach this gate, and it re-anchors a changed test scope itself
// (coverage-write-decision.ts `dropVerdict`). So the ONLY legitimate hand move
// on a kept entry is raising `f` with the scope untouched. Everything else a
// hand edit can do to an entry is a loosening:
//   - lowering `f` under ANY scope (the old same-scope-only comparison let
//     `{f: 0.95, scope: S}` → `{f: 0.10, scope: S + " "}` and legacy `1` →
//     `{f: 0.1, scope: "x"}` through as "re-anchors");
//   - moving the scope at an equal `f` (primes the runtime to re-anchor lower
//     on the next edit);
//   - a scope the runtime grammar never produces (typed, not measured);
//   - replacing the value with something undecodable (the runtime reads that
//     as "no baseline" and reseeds — the same exemption as deleting the key).

import { isJsonObject } from "../../lib/json-types.js";
import { coverageHighWaterOf } from "../coverage-obligation-ledger.js";
import type { BaselineGamingFinding } from "./baseline-integrity-gate.js";

/** A decoded ledger entry: the fraction and the scope that measured it (null
 *  for the legacy bare-number shape or an object without a scope). */
interface CovValue {
	f: number;
	scope: string | null;
}

/** The scope grammar the per-edit runtime writes (coverage-scope.ts): the full
 *  suite, or a 12-hex-digit hash of the sorted selected-test list. */
const COVERAGE_SCOPE_GRAMMAR = /^(?:full|scoped:[0-9a-f]{12})$/;

function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function fmt(file: string, rule: string, before: unknown, after: unknown, message: string): BaselineGamingFinding {
	return { file, rule, before, after, message };
}

/** A coverage-edit baseline value in either shape: a legacy bare fraction, or
 *  a scoped `{f, scope}` object (mirrors coverage-obligation-ledger). */
function decodeCovValue(value: unknown): CovValue | null {
	if (isNum(value)) return { f: value, scope: null };
	const obj = isJsonObject(value) ? value : {};
	const f = obj.f;
	if (isNum(f)) return { f, scope: typeof obj.scope === "string" ? obj.scope : null };
	return null;
}

/** A scope string a hand edit put on an entry that the runtime could never
 *  have written — including the cosmetic variants (trailing space) the red
 *  team used to make `scope !== scope` read as a re-anchor. */
function malformedScopeFinding(file: string, path: string, av: CovValue): BaselineGamingFinding | null {
	if (av.scope === null || COVERAGE_SCOPE_GRAMMAR.test(av.scope)) return null;
	return fmt(
		file,
		`coverage-edit-scope:${path}`,
		undefined,
		av.scope,
		`coverage-edit-baseline scope for ${path} is ${JSON.stringify(av.scope)}, which the per-edit runtime never writes (expected "full" or "scoped:<12 hex>"). Scopes are measured, not typed.`,
	);
}

/** A hand edit that lowers or deletes an entry's high-water — the highest
 *  fraction ever accepted under the full suite, derived exactly as the runtime
 *  ledger derives it (`coverageHighWaterOf`: explicit `hw`, raised to `f` when
 *  `f` is a full-suite value — scope "full", no scope, or a bare number). The runtime
 *  never lowers `hw` (only a full-suite write may raise it), so a lower or
 *  missing one is always a hand loosening — even when `f` and the scope are
 *  untouched (deleting `hw` from `{f: 0.996, scope: S, hw: 1}` would let the
 *  next narrowed measurement re-anchor below the full-suite line). */
function highWaterFinding(file: string, path: string, bRaw: unknown, aRaw: unknown, fLoweredFrom: number | null): BaselineGamingFinding | null {
	const before = coverageHighWaterOf(bRaw);
	if (before === null) return null;
	const after = coverageHighWaterOf(aRaw);
	if (after !== null && after >= before) return null;
	// Already reported: the `f` lowering finding names this same line when the
	// high-water was no higher than the lowered `f` (a bare number, a full-scope f).
	if (fLoweredFrom !== null && before <= fLoweredFrom) return null;
	return fmt(
		file,
		`coverage-edit-hw:${path}`,
		before,
		after ?? undefined,
		`coverage-edit-baseline high-water for ${path} ${after === null ? "removed" : `lowered ${before}→${after}`}. The full-suite high-water may only rise, and only from a full-suite measurement.`,
	);
}

/** Findings for one pre-existing entry the edit keeps (both sides decoded). */
function keptEntryFindings(file: string, path: string, bv: CovValue, av: CovValue): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	if (av.f < bv.f) {
		out.push(
			fmt(file, `coverage-edit:${path}`, bv.f, av.f, `coverage-edit-baseline for ${path} lowered ${bv.f}→${av.f}. Per-edit coverage may only rise; the runtime re-anchors a changed test scope itself, a hand edit never does.`),
		);
	}
	if (av.scope !== bv.scope) {
		out.push(
			fmt(
				file,
				`coverage-edit-scope:${path}`,
				bv.scope,
				av.scope,
				`coverage-edit-baseline scope for ${path} re-keyed by hand (${JSON.stringify(bv.scope)}→${JSON.stringify(av.scope)}). Only the per-edit runtime writes a scope; a hand re-key lets the next measurement re-anchor below the recorded water-line.`,
			),
		);
	}
	const malformed = malformedScopeFinding(file, path, av);
	if (malformed) out.push(malformed);
	return out;
}

/** Findings for one entry present before the edit. */
function existingEntryFindings(
	file: string,
	path: string,
	bv: CovValue,
	bRaw: unknown,
	aRaw: unknown,
	exists: (rel: string) => boolean,
): BaselineGamingFinding[] {
	if (aRaw === undefined) {
		if (!exists(path)) return [];
		return [fmt(file, `coverage-edit:${path}`, bv.f, undefined, `coverage-edit-baseline entry for ${path} removed while the source still exists.`)];
	}
	const av = decodeCovValue(aRaw);
	if (av === null) {
		return [
			fmt(file, `coverage-edit:${path}`, bv.f, aRaw, `coverage-edit-baseline entry for ${path} replaced by a value the runtime cannot decode — that drops its ${bv.f} water-line to nothing.`),
		];
	}
	const out = keptEntryFindings(file, path, bv, av);
	const hw = highWaterFinding(file, path, bRaw, aRaw, av.f < bv.f ? bv.f : null);
	if (hw) out.push(hw);
	return out;
}

/**
 * Pure detector for a hand edit of `coverage-edit-baseline.json`: every kept
 * entry may only rise with its scope untouched, a removed entry needs its
 * source gone, and a NEW entry may carry only a scope the runtime grammar
 * admits. `exists` answers whether a repo-relative source path is still on disk.
 */
export function detectCoverageEdit(
	file: string,
	before: unknown,
	after: unknown,
	exists: (rel: string) => boolean,
): BaselineGamingFinding[] {
	const out: BaselineGamingFinding[] = [];
	const b = isJsonObject(before) ? before : {};
	const a = isJsonObject(after) ? after : {};
	for (const [path, bRaw] of Object.entries(b)) {
		const bv = decodeCovValue(bRaw);
		if (bv === null) continue;
		out.push(...existingEntryFindings(file, path, bv, bRaw, a[path], exists));
	}
	for (const [path, aRaw] of Object.entries(a)) {
		if (path in b) continue;
		const av = decodeCovValue(aRaw);
		const malformed = av === null ? null : malformedScopeFinding(file, path, av);
		if (malformed) out.push(malformed);
	}
	return out;
}
