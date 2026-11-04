// ===========================================
// Differential fuzz — the engine
// ===========================================
// Given ONE surviving mutant, search for an input on which the pristine and the
// mutated function disagree. Inputs come from fast-check arbitraries derived from
// the function's DECLARED parameter types (differential-fuzz-arbitraries.ts); the
// two modules are built and loaded by differential-fuzz-execute.ts; this file
// wires them into one search and reports a `FuzzOutcome`.
//
// A `kill` carries fast-check's own minimized counterexample. `no_divergence` is
// search evidence only — never a proof of equivalence. Same seed, same result.
//
// A NON-exported top-level function is fuzzed through a synthetic
// `export { fn as __fuzz_target__ }` appended to both module sources before
// transpiling (outcomes carry `targetExported: false`).
//
// Limitations (v0): mutants inside class methods and nested closures (a function
// inside another function) are `unsupported_target`; `import.meta.url`, `__dirname`
// and `require()` inside the target file see the temp-dir copy, not the original;
// the function is called in-process, so a mutant with side effects (file or
// network writes) really performs them — fuzz only pure-ish code.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type Arb,
	type FcApi,
	type RunDetails,
	asFcApi,
	collectDictionary,
	deriveArbitraries,
} from "./differential-fuzz-arbitraries.js";
import { loadCorpusSeeds } from "./differential-fuzz-corpus.js";
import {
	type TsModule,
	loadFastCheck,
	loadTsModule,
	transpileMutantModule,
} from "./differential-fuzz-deps.js";
import {
	UnsupportedOutputError,
	loadModulePair,
	outcomesEqual,
	renderValue,
	rewriteImports,
	summarizeCall,
} from "./differential-fuzz-execute.js";
import {
	type FunctionTarget,
	applyMutant,
	findExportedFunction,
	locateMutantOffset,
	parseSource,
	syntheticExportSuffix,
} from "./differential-fuzz-locate.js";
import {
	type CallOutcomeSummary,
	DEFAULT_FUZZ_CALL_TIMEOUT_MS,
	DEFAULT_FUZZ_RUNS,
	DEFAULT_FUZZ_TIME_BUDGET_MS,
	type FuzzCorpusConfig,
	type FuzzMutantTarget,
	type FuzzOutcome,
	type FuzzRunConfig,
	type ParamArbitrarySpec,
} from "./differential-fuzz-types.js";
import { deriveIdentities } from "./identity.js";
import type { RawMutant } from "./types.js";

type AnyCallable = (...args: never[]) => unknown;

/** Everything the search needs, resolved before any input is generated. */
interface Plan {
	fc: FcApi;
	arbs: Arb[];
	specs: ParamArbitrarySpec[];
	/** Name looked up on the loaded module namespace (the synthetic export for a non-exported target). */
	exportName: string;
	/** Name in the file's own scope; used in the proposed regression test. */
	callName: string;
	targetExported: boolean;
	pristineJs: string;
	mutantJs: string;
}

type Planned = { ok: true; plan: Plan } | { ok: false; outcome: FuzzOutcome };

const unsupported = (target: FuzzMutantTarget, reason: string): Planned => ({
	ok: false,
	outcome: { kind: "unsupported_target", target, reason },
});
const unavailable = (target: FuzzMutantTarget, reason: string): Planned => ({
	ok: false,
	outcome: { kind: "unavailable", target, reason },
});

function readSource(target: FuzzMutantTarget): string | null {
	if (target.source !== undefined) return target.source;
	try {
		return readFileSync(target.absPath, "utf8");
	} catch {
		return null;
	}
}

function missingDeps(ts: TsModule | null, fc: FcApi | null): string | null {
	const missing = [ts === null ? "typescript not installed" : "", fc === null ? "fast-check not installed (or missing API)" : ""];
	const reasons = missing.filter((m) => m !== "");
	return reasons.length > 0 ? `fuzz unavailable: ${reasons.join("; ")}` : null;
}

/** A non-exported target gets the synthetic export appended to BOTH sources before transpiling. */
function buildModules(ts: TsModule, target: FuzzMutantTarget, source: string, mutated: string, located: FunctionTarget) {
	const suffix = located.exported ? "" : syntheticExportSuffix(located.localName);
	const pristine = transpileMutantModule(rewriteImports(ts, source + suffix, target.absPath), target.absPath);
	const mutant = transpileMutantModule(rewriteImports(ts, mutated + suffix, target.absPath), target.absPath);
	return { pristine, mutant };
}

async function planTarget(target: FuzzMutantTarget, corpus: FuzzCorpusConfig | undefined): Promise<Planned> {
	const ts = loadTsModule();
	const fc = asFcApi(await loadFastCheck());
	const missing = missingDeps(ts, fc);
	if (missing !== null || ts === null || fc === null) return unavailable(target, missing ?? "fuzz unavailable");
	const source = readSource(target);
	if (source === null) return unsupported(target, `cannot read ${target.absPath}`);

	const site = locateMutantOffset(ts, target, source);
	if (!site.ok) return unsupported(target, site.reason);
	const sf = parseSource(ts, target.file, source);
	const located = findExportedFunction(ts, sf, site.offset);
	if (!located.ok) return unsupported(target, located.reason);
	// No corpus option ⇒ type-driven generation only (an empty `{ files: [] }` still uses companion-test literals).
	const seeds = corpus === undefined ? undefined : loadCorpusSeeds(ts, target.absPath, corpus);
	const derived = deriveArbitraries(ts, sf, fc, located.fn, collectDictionary(ts, located.fn), seeds);
	if (!derived.ok) return unsupported(target, derived.reason);

	const mutated = applyMutant(source, site.offset, target.originalLexeme, target.replacement);
	if (mutated === source) return unsupported(target, "mutant is textually identical to the original");
	const built = buildModules(ts, target, source, mutated, located);
	if (built.pristine === null || built.mutant === null) return unavailable(target, "typescript unavailable to build modules");
	if (built.mutant.diagnostics.length > 0) {
		return unavailable(target, `mutant module does not build: ${built.mutant.diagnostics.slice(0, 2).join(" | ")}`);
	}
	return {
		ok: true,
		plan: {
			fc,
			arbs: derived.arbs,
			specs: derived.specs,
			exportName: located.exportName,
			callName: located.localName,
			targetExported: located.exported,
			pristineJs: built.pristine.js,
			mutantJs: built.mutant.js,
		},
	};
}

function randomSeed(): number {
	return Math.floor(Math.random() * 0x7fffffff);
}

function clone(args: unknown[]): unknown[] {
	return structuredClone(args);
}

interface Search {
	details: RunDetails;
	/** Set when the search must be reported as unsupported rather than as a verdict. */
	abort: string | null;
}

/** One differential comparison; returns true when the two sides agree. */
async function agrees(
	pristine: AnyCallable,
	mutant: AnyCallable,
	args: unknown[],
	timeoutMs: number,
): Promise<{ equal: boolean; stable: boolean }> {
	const p1 = await summarizeCall(pristine, clone(args), timeoutMs);
	const m = await summarizeCall(mutant, clone(args), timeoutMs);
	if (outcomesEqual(p1, m)) return { equal: true, stable: true };
	const p2 = await summarizeCall(pristine, clone(args), timeoutMs);
	return { equal: false, stable: outcomesEqual(p1, p2) };
}

type ResolvedFuzzConfig = Required<Omit<FuzzRunConfig, "corpus">>;

async function search(
	plan: Plan,
	pristine: AnyCallable,
	mutant: AnyCallable,
	config: ResolvedFuzzConfig,
): Promise<Search> {
	let abort: string | null = null;
	const width = plan.arbs.length;
	const arbs = width > 0 ? plan.arbs : [plan.fc.constant(undefined)];
	const property = plan.fc.asyncProperty(...arbs, async (...generated: unknown[]) => {
		if (abort !== null) return true;
		try {
			const verdict = await agrees(pristine, mutant, generated.slice(0, width), config.callTimeoutMs);
			if (!verdict.equal && !verdict.stable) abort = "pristine function is non-deterministic on the same input";
			return verdict.equal;
		} catch (err) {
			if (!(err instanceof UnsupportedOutputError)) throw err;
			abort = err.message;
			return false;
		}
	});
	const details = await plan.fc.check(property, {
		numRuns: config.runs,
		seed: config.seed,
		interruptAfterTimeLimit: config.timeBudgetMs,
		markInterruptAsFailure: false,
	});
	return { details, abort };
}

function callSource(exportName: string, args: unknown[]): string {
	return `${exportName}(${args.map((a) => renderValue(a)).join(", ")})`;
}

function regressionFixture(target: FuzzMutantTarget, plan: Plan, args: unknown[], expected: CallOutcomeSummary): string {
	const exportName = plan.callName;
	const call = callSource(exportName, args);
	const assertion = expected.threw
		? `expect(() => ${call}).toThrow(${expected.errorMessage ? JSON.stringify(expected.errorMessage) : ""});`
		: `expect(${call}).toEqual(${expected.valueJson});`;
	const notExported = plan.targetExported ? [] : [`// NOTE: ${exportName} is not exported by its module; export it or call it through a public caller.`];
	return [
		`// Pins behaviour that surviving mutant ${target.mutantId} (${target.originalLexeme} -> ${target.replacement}) changes.`,
		...notExported,
		`it(${JSON.stringify(`${exportName} pins mutant ${target.mutantId}`)}, () => {`,
		`\t${assertion}`,
		"});",
	].join("\n");
}

async function reportFailure(
	target: FuzzMutantTarget,
	plan: Plan,
	pristine: AnyCallable,
	mutant: AnyCallable,
	found: Search,
	timeoutMs: number,
): Promise<FuzzOutcome> {
	const args = found.details.counterexample;
	if (args === null) return { kind: "unsupported_target", target, reason: "fast-check reported a failure with no counterexample" };
	const width = plan.arbs.length;
	const counterexample = args.slice(0, width);
	const originalOutcome = await summarizeCall(pristine, clone(counterexample), timeoutMs);
	const mutantOutcome = await summarizeCall(mutant, clone(counterexample), timeoutMs);
	if (outcomesEqual(originalOutcome, mutantOutcome)) {
		return { kind: "unsupported_target", target, reason: "divergence did not replay on the minimized counterexample" };
	}
	return {
		kind: "kill",
		target,
		counterexample,
		originalOutcome,
		mutantOutcome,
		numRuns: found.details.numRuns,
		seed: found.details.seed,
		regressionFixture: regressionFixture(target, plan, counterexample, originalOutcome),
		params: plan.specs,
		targetExported: plan.targetExported,
	};
}

function noDivergence(target: FuzzMutantTarget, plan: Plan, details: RunDetails): FuzzOutcome {
	const weakParams = plan.specs.filter((s) => s.weak).map((s) => s.name);
	const stop = details.interrupted ? "; stopped by the time budget" : "";
	return {
		kind: "no_divergence",
		target,
		numRuns: details.numRuns,
		seed: details.seed,
		params: plan.specs,
		targetExported: plan.targetExported,
		weakGeneration: weakParams.length > 0,
		weakParams,
		dispositionWritten: false,
		dispositionNote: `search evidence only (${details.numRuns} runs, seed ${details.seed}${stop}); not proof of equivalence`,
	};
}

function exportedFunction(mod: Record<string, unknown>, name: string): AnyCallable | null {
	const value = mod[name];
	// SAFETY: the typeof check proves it is callable; the argument types are the fuzzed function's own.
	return typeof value === "function" ? (value as AnyCallable) : null;
}

/**
 * Search for an input that separates the mutant from the original.
 * Never throws for a bad target: every failure mode is a `FuzzOutcome`.
 */
export async function runDifferentialFuzz(target: FuzzMutantTarget, config: FuzzRunConfig = {}): Promise<FuzzOutcome> {
	const planned = await planTarget(target, config.corpus);
	if (!planned.ok) return planned.outcome;
	const { plan } = planned;
	const resolved: ResolvedFuzzConfig = {
		runs: config.runs ?? DEFAULT_FUZZ_RUNS,
		seed: config.seed ?? randomSeed(),
		timeBudgetMs: config.timeBudgetMs ?? DEFAULT_FUZZ_TIME_BUDGET_MS,
		callTimeoutMs: config.callTimeoutMs ?? DEFAULT_FUZZ_CALL_TIMEOUT_MS,
	};
	let pair: Awaited<ReturnType<typeof loadModulePair>>;
	try {
		pair = await loadModulePair(plan.pristineJs, plan.mutantJs);
	} catch (err) {
		return { kind: "unavailable", target, reason: `module failed to load: ${err instanceof Error ? err.message : String(err)}` };
	}
	try {
		const pristine = exportedFunction(pair.pristine, plan.exportName);
		const mutant = exportedFunction(pair.mutant, plan.exportName);
		if (pristine === null || mutant === null) {
			return { kind: "unsupported_target", target, reason: `export "${plan.exportName}" is not a function at runtime` };
		}
		const found = await search(plan, pristine, mutant, resolved);
		if (found.abort !== null) return { kind: "unsupported_target", target, reason: found.abort };
		if (!found.details.failed) return noDivergence(target, plan, found.details);
		return await reportFailure(target, plan, pristine, mutant, found, resolved.callTimeoutMs);
	} finally {
		pair.dispose();
	}
}

/**
 * Build a fuzz target from a file's text and one engine-reported raw mutant.
 * Identity fields come from identity.ts (empty when typescript is unavailable);
 * the name is that of the enclosing exported function when one is found.
 */
export function buildFuzzTarget(file: string, content: string, raw: RawMutant, absPath: string = resolve(file)): FuzzMutantTarget {
	const identity = deriveIdentities(file, content, [raw])?.[0];
	const ts = loadTsModule();
	const located = ts === null ? null : findExportedFunction(ts, parseSource(ts, file, content), raw.startOffset);
	return {
		file,
		absPath,
		qualifiedName: located?.ok ? located.localName : (identity?.qualifiedName ?? "(unknown)"),
		symbolId: identity?.symbolId ?? "",
		mutantId: identity?.mutantId ?? "",
		mutator: raw.mutator,
		originalLexeme: raw.originalLexeme,
		replacement: raw.replacement,
		ordinalWithinSymbol: identity?.ordinalWithinSymbol ?? 0,
		startOffset: raw.startOffset,
		source: content,
	};
}
