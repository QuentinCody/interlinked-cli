import { describe, expect, it } from "vitest";
import { evaluateMutation } from "./evaluate.js";
import { computeSymbolHashes, deriveIdentities, type SymbolHashEntry } from "./identity.js";
import { emptyManifest } from "./manifest.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import type { MutationGateOutcome, MutationManifest, StableId, SymbolRecord, TestRunResult } from "./types.js";

const FILE = "src/x.ts";
const META = {
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	authoritativeAt: "t0",
};
const CONTENT = "function bar(x: number): boolean { return x > 0; }\n";

type Measured = Extract<MutationGateOutcome, { kind: "measured" }>;
type Unavailable = Extract<MutationGateOutcome, { kind: "unavailable" }>;

// Narrowing helpers live outside the it() blocks so the test bodies stay branch-free.
function measured(out: MutationGateOutcome): Measured {
	if (out.kind !== "measured") throw new Error(`expected a measured outcome, got ${out.kind}`);
	return out;
}

function unavailable(out: MutationGateOutcome): Unavailable {
	if (out.kind !== "unavailable") throw new Error(`expected an unavailable outcome, got ${out.kind}`);
	return out;
}

type Adopted = Extract<MutationGateOutcome, { kind: "baseline_adoption_ready" }>;

/** First sighting is ADOPTION, not measurement (review 2026-08-28 item 1).
 *  `_ready` because the evaluator only proposes adoption — the gate layer
 *  declares it after durable persistence (gate-decision.ts::adoptionDecision). */
function adopted(out: MutationGateOutcome): Adopted {
	if (out.kind !== "baseline_adoption_ready") throw new Error(`expected baseline_adoption_ready, got ${out.kind}`);
	return out;
}

function requireHashes(content: string): Map<StableId, SymbolHashEntry> {
	const h = computeSymbolHashes(FILE, content);
	if (!h) throw new Error("typescript unavailable");
	return h;
}

/**
 * A manifest that already has a baseline for FILE, but whose symbol hash differs
 * from CONTENT — so the symbol reads as CHANGED and the ratchet applies.
 *
 * The ratchet tests need this because a manifest with NO entry for the file is a
 * first sighting, where the gate deliberately establishes a baseline instead of
 * verdicting: with no prior, every symbol looks changed and every pre-existing
 * survivor looks new, so judging it rejects on the size of the file rather than
 * the size of the edit.
 */
function priorBaseline(): MutationManifest {
	return manifestFromContent("function bar(x: number): boolean { return x > 1; }\n");
}

function manifestFromContent(content: string): MutationManifest {
	const records: Record<string, SymbolRecord> = {};
	for (const [symbolId, entry] of requireHashes(content)) {
		records[symbolId] = {
			symbolId,
			qualifiedName: entry.qualifiedName,
			symbolHash: entry.symbolHash,
			mutants: {},
			instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
		};
	}
	return { ...emptyManifest(META), files: { [FILE]: records } };
}

function adaptedGt(status: AdaptedMutant["status"]): AdaptedMutant {
	return {
		raw: { file: FILE, mutator: "Eq", originalLexeme: ">", replacement: ">=", startOffset: CONTENT.indexOf("> 0") },
		status,
	};
}

function baselineWithMutants(content = CONTENT, extraMutant = false): MutationManifest {
	const base = manifestFromContent(content);
	const raw = {
		file: FILE,
		mutator: "Eq",
		originalLexeme: ">",
		replacement: ">=",
		startOffset: content.indexOf(">"),
	};
	const identities = deriveIdentities(FILE, content, [raw]);
	if (identities === null || identities.length !== 1) throw new Error("typescript unavailable");
	const identity = identities[0];
	if (identity === undefined) throw new Error("identity missing");
	const symbols = base.files[FILE];
	const symbol = symbols?.[identity.symbolId];
	if (symbols === undefined || symbol === undefined) throw new Error("symbol missing");
	const first = { ...identity, status: "killed" as const, firstSeen: "t0" };
	const mutants = {
		[identity.mutantId]: first,
		...(extraMutant ? { ["f".repeat(16)]: { ...first, mutantId: "f".repeat(16) } } : {}),
	};
	return {
		...base,
		files: { ...base.files, [FILE]: { ...symbols, [identity.symbolId]: { ...symbol, mutants } } },
	};
}

/** A well-formed test run: the suite ran and passed.
 *
 *  This is the DEFAULT for `evalWith` because goal 28 §8 makes test-run evidence
 *  a precondition for certifying clean. Before that, the default was `undefined`
 *  — and an absent `testRun` read as "not red", which is exactly the false clean
 *  the contract closes. Cases that deliberately exercise MISSING evidence pass
 *  `undefined` explicitly, so the absence is visible in the test rather than
 *  inherited from a helper. */
const GREEN_RUN: TestRunResult = { overlayGreen: true, redWitnessSatisfied: null };

function evalWith(
	base: MutationManifest,
	adapted: AdaptedMutant[],
	siteCountThreshold = 50,
	testRun: TestRunResult | undefined = GREEN_RUN,
): MutationGateOutcome {
	// `engineExitCode: 0` is the default for the same reason GREEN_RUN is: strict
	// evidence (2026-08-28) makes a proven engine finish a precondition for
	// clean, so cases probing its ABSENCE call evaluateMutation directly.
	return evaluateMutation({
		file: FILE,
		baseManifest: base,
		overlayContent: CONTENT,
		adapted,
		siteCountThreshold,
		testRun,
		executedTestCount: 1,
		engineExitCode: 0,
		at: "t",
	});
}

describe("evaluateMutation", () => {
	it("blocks a new survivor in a changed symbol and emits a hash-bound receipt", () => {
		const m = measured(evalWith(priorBaseline(), [adaptedGt("survived")]));
		expect(m.decision).toBe("block");
		expect(m.newSurvivors).toHaveLength(1);
		expect(m.receipt.overlayHash).toHaveLength(64);
		expect(m.receipt.sites).toHaveLength(1);
	});

	it("allows when the mutant is killed", () => {
		expect(measured(evalWith(priorBaseline(), [adaptedGt("killed")])).decision).toBe("allow");
	});

	it("N: a missing mutant in an unchanged symbol is not-measured and cannot refresh", () => {
		const base = baselineWithMutants();
		const outcome = unavailable(evalWith(base, []));
		expect(outcome.reason).toContain("unchanged-symbol census");
		expect(outcome.reason).toContain("prior mutant(s) were absent");
	});

	it("P: disappearance in a changed symbol remains eligible for ordinary evaluation", () => {
		const base = baselineWithMutants("function bar(x: number): boolean { return x > 1; }\n");
		const outcome = measured(evalWith(base, [adaptedGt("killed")]));
		expect(outcome.decision).toBe("allow");
		expect(outcome.receipt.sites).toHaveLength(1);
	});

	it("P: a survivor still blocks when another unchanged-symbol mutant is missing", () => {
		const outcome = measured(evalWith(baselineWithMutants(CONTENT, true), [adaptedGt("survived")]));
		expect(outcome.decision).toBe("block");
		expect(outcome.newSurvivors).toHaveLength(1);
	});

	it("blocks on an uncovered changed site", () => {
		const m = measured(evalWith(priorBaseline(), [adaptedGt("uncovered")]));
		expect(m.decision).toBe("block");
		expect(m.uncoveredSites).toHaveLength(1);
	});

	it("blocks a survivor in an UNCHANGED symbol that is not accepted — a test regression (review 2026-08-24 item 1)", () => {
		// The manifest knows the symbol (hash matches) but not this survivor: the
		// mutant used to die and now survives. Allowing it would let the run
		// enlarge the accepted floor silently. It must block instead.
		const m = measured(evalWith(manifestFromContent(CONTENT), [adaptedGt("survived")]));
		expect(m.decision).toBe("block");
		expect(m.newSurvivors).toHaveLength(1);
		expect(m.refreshedManifest).toBeUndefined();
	});

	it("blocks oversize: changed sites over the threshold, even when the mutant is killed", () => {
		// 1 changed site > a threshold of 0 ⇒ "split this patch" overrides the clean kill.
		const m = measured(evalWith(priorBaseline(), [adaptedGt("killed")], 0));
		expect(m.decision).toBe("block");
		expect(m.changedSiteCount).toBeGreaterThan(m.siteCountThreshold);
	});

	it("returns a refreshed manifest ONLY on a measured-clean allow (generation bumped)", () => {
		const clean = measured(evalWith(priorBaseline(), [adaptedGt("killed")]));
		expect(clean.decision).toBe("allow");
		expect(clean.refreshedManifest?.generation).toBe(1);
		expect(Object.keys(clean.refreshedManifest?.files[FILE] ?? {})).not.toHaveLength(0);
	});

	it("returns NO refreshed manifest on a block (dirty run cannot launder the manifest)", () => {
		const dirty = measured(evalWith(priorBaseline(), [adaptedGt("survived")]));
		expect(dirty.decision).toBe("block");
		expect(dirty.refreshedManifest).toBeUndefined();
	});

	it("blocks a killed→survived transition against a clean prior pass — the accepted floor never enlarges from a routine run (review 2026-08-24 item 1)", () => {
		// Run 1: killed mutant → clean → refreshed manifest persisted (simulated).
		const first = measured(evalWith(priorBaseline(), [adaptedGt("killed")]));
		const persisted = first.refreshedManifest;
		if (!persisted) throw new Error("expected a refreshed manifest");
		// Run 2: SAME content, the engine now reports a survivor. The prior run
		// killed this mutant, so a test regression rode in. This used to allow and
		// grandfather the survivor (the reviewer's reproduced defect); it blocks.
		const second = measured(evalWith(persisted, [adaptedGt("survived")]));
		expect(second.decision).toBe("block");
		expect(second.refreshedManifest).toBeUndefined();
	});

	it("still allows a survivor in an unchanged symbol when it is ALREADY accepted (grandfathered)", () => {
		// First sighting ADOPTS the survivor as the baseline (accepted floor).
		const first = adopted(evalWith(emptyManifest(META), [adaptedGt("survived")]));
		const persisted = first.refreshedManifest;
		// Same content, same survivor: it is in the accepted set → no regression.
		const second = measured(evalWith(persisted, [adaptedGt("survived")]));
		expect(second.decision).toBe("allow");
	});

	// --- First sighting: establish a baseline, do not verdict ---
	// Without this the gate could never bootstrap: no manifest ⇒ every symbol
	// reads as changed ⇒ rejected on the size of the FILE ⇒ no clean pass ⇒ still
	// no manifest. Measured live as a one-line comment edit reporting 116
	// "changed sites".
	it("P: a survivor on FIRST sighting is baseline_adopted — recorded, never called clean", () => {
		const m = adopted(evalWith(emptyManifest(META), [adaptedGt("survived")]));
		expect(m.refreshedManifest).toBeDefined();
		expect(m.warning).toContain("baseline adopted");
		expect(m.warning).toContain("NOT certified clean");
		expect(m.warning).toContain("1 pre-existing survivor(s)");
	});

	it("P: an oversize first sighting is baseline_adopted — the count reflects the file, not the edit", () => {
		expect(adopted(evalWith(emptyManifest(META), [adaptedGt("killed")], 0)).warning).toContain("baseline adopted");
	});

	it("P: an uncovered site on first sighting is baseline_adopted", () => {
		expect(adopted(evalWith(emptyManifest(META), [adaptedGt("uncovered")])).warning).toContain("baseline adopted");
	});

	// --- Partial scope + inconclusive statuses (review 2026-08-24, items 2/3/5) ---
	// "Some evidence arrived" and "conclusively measured" are different states.
	// Positive findings stand even from a partial run; a CLEAN verdict needs a
	// full-scope, fully-conclusive run. Anything less is not-measured.
	function evalPartial(base: MutationManifest, adapted: AdaptedMutant[]): MutationGateOutcome {
		return evaluateMutation({
			file: FILE,
			baseManifest: base,
			overlayContent: CONTENT,
			adapted,
			siteCountThreshold: 50,
			at: "t",
			// A well-formed test run, so these cases isolate the PARTIAL-SCOPE
			// reason. Without it they would now stop at the evidence gate and
			// assert the wrong not-measured reason — same verdict, different
			// cause, which would quietly stop testing partiality at all.
			testRun: GREEN_RUN,
			executedTestCount: 1,
			engineExitCode: 0,
			partialScope: true,
		});
	}

	it("P: a partial run on FIRST sighting is not-measured — a partial floor never becomes the baseline", () => {
		const out = unavailable(evalPartial(emptyManifest(META), [adaptedGt("killed")]));
		expect(out.reason).toContain("census");
	});

	it("P: a partial run with NO finding is not-measured, never a clean allow", () => {
		const out = unavailable(evalPartial(manifestFromContent(CONTENT), [adaptedGt("killed")]));
		expect(out.reason).toContain("partial");
	});

	it("N: a partial run's SURVIVOR in the changed region still blocks — positive evidence stands", () => {
		const out = measured(evalPartial(priorBaseline(), [adaptedGt("survived")]));
		expect(out.decision).toBe("block");
		expect(out.refreshedManifest).toBeUndefined();
	});

	it("P: a changed-region timeout is inconclusive — not-measured, not clean (item 5)", () => {
		const out = unavailable(evalWith(priorBaseline(), [adaptedGt("timeout")]));
		expect(out.reason).toContain("inconclusive");
	});

	it("P: a changed-region indeterminate result is inconclusive — not-measured (item 5)", () => {
		const out = evalWith(priorBaseline(), [adaptedGt("indeterminate")]);
		expect(out.kind).toBe("unavailable");
	});

	it("P: a timeout ANYWHERE makes the run inconclusive — no clean receipt, no manifest refresh (review 2026-08-25)", () => {
		// The 2026-08-24 rule only counted changed-region timeouts, so an
		// unchanged-symbol timeout still allowed, issued a receipt, and refreshed
		// the manifest — a not-fully-conclusive run presented as clean.
		const out = unavailable(evalWith(manifestFromContent(CONTENT), [adaptedGt("timeout")]));
		expect(out.reason).toContain("inconclusive");
	});

	it("P: a killed→uncovered transition in an unchanged symbol is a regression and blocks (review 2026-08-25)", () => {
		// Run 1: the mutant is killed and recorded. Run 2 (same content): the
		// test no longer covers it. Coverage loss is a regression too.
		const first = measured(evalWith(priorBaseline(), [adaptedGt("killed")]));
		const persisted = first.refreshedManifest;
		if (!persisted) throw new Error("expected a refreshed manifest");
		const second = measured(evalWith(persisted, [adaptedGt("uncovered")]));
		expect(second.decision).toBe("block");
		expect(second.refreshedManifest).toBeUndefined();
	});

	it("N: a mutant that was ALWAYS uncovered in an unchanged symbol is not a regression", () => {
		// First sighting ADOPTS the uncovered status as the baseline; the same
		// observation later must not read as a coverage loss.
		const first = adopted(evalWith(emptyManifest(META), [adaptedGt("uncovered")]));
		const persisted = first.refreshedManifest;
		const second = measured(evalWith(persisted, [adaptedGt("uncovered")]));
		expect(second.decision).toBe("allow");
	});

	it("P: a RED overlay suite blocks even on a partial first sighting — hard evidence beats scope limits (review 2026-08-25)", () => {
		const out = evaluateMutation({
			file: FILE,
			baseManifest: emptyManifest(META),
			overlayContent: CONTENT,
			adapted: [adaptedGt("killed")],
			siteCountThreshold: 50,
			testRun: { overlayGreen: false, redWitnessSatisfied: null },
			at: "t",
			partialScope: true,
		});
		expect(out.kind).toBe("measured");
		expect(measured(out).decision).toBe("block");
	});

	it("N: STILL blocks a red suite on first sighting — that is the edit, not the baseline", () => {
		const m = measured(
			evalWith(emptyManifest(META), [adaptedGt("killed")], 50, {
				overlayGreen: false,
				redWitnessSatisfied: null,
			}),
		);
		expect(m.decision).toBe("block");
	});

	it("N: the SECOND edit ratchets normally once the baseline exists", () => {
		// Establish (ADOPT) on first sighting, then re-judge the same survivor
		// against it — the second run is the first real MEASUREMENT.
		const first = adopted(evalWith(emptyManifest(META), [adaptedGt("killed")]));
		const persisted = first.refreshedManifest;
		const changed = measured(
			evaluateMutation({
				file: FILE,
				baseManifest: { ...persisted, files: { [FILE]: priorBaseline().files[FILE] ?? {} } },
				overlayContent: CONTENT,
				adapted: [adaptedGt("survived")],
				siteCountThreshold: 50,
				at: "t",
			}),
		);
		expect(changed.decision).toBe("block");
	});

	it("blocks a red overlay suite even when the mutant is killed (spec §7 red/green)", () => {
		const m = measured(evalWith(priorBaseline(), [adaptedGt("killed")], 50, { overlayGreen: false, redWitnessSatisfied: null }));
		expect(m.decision).toBe("block");
		expect(m.suiteRed).toBe(true);
	});

	it("warns (allows) on a failed RED-witness with a green suite + killed mutant", () => {
		const m = measured(evalWith(priorBaseline(), [adaptedGt("killed")], 50, { overlayGreen: true, redWitnessSatisfied: false }));
		expect(m.decision).toBe("allow");
		expect(m.redWitnessFailed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Phase D ratchet: 13 survivors of 90 in the gate's DECISION core — the place
// where an unnoticed wrong answer becomes a forged pass or a false block.
// ---------------------------------------------------------------------------

describe("the site-count ceiling is a strict threshold", () => {
	it("allows a patch sitting exactly ON the threshold", () => {
		// `>` not `>=`: at the limit is still inside it. Off-by-one here turns a
		// legal patch into a "split this up" block.
		const m = measured(evalWith(priorBaseline(), [adaptedGt("killed")], 1));
		expect(m.decision).toBe("allow");
	});

	it("blocks a patch one site over the threshold", () => {
		const m = measured(evalWith(priorBaseline(), [adaptedGt("killed")], 0));
		expect(m.decision).toBe("block");
	});
});

describe("suite verdicts outrank the ratchet", () => {
	it("blocks a red overlay suite even when every mutant was killed", () => {
		const m = measured(
			evalWith(priorBaseline(), [adaptedGt("killed")], 50, { overlayGreen: false, redWitnessSatisfied: null }),
		);
		expect(m.decision).toBe("block");
	});

	it("allows a green overlay suite with killed mutants", () => {
		const m = measured(
			evalWith(priorBaseline(), [adaptedGt("killed")], 50, { overlayGreen: true, redWitnessSatisfied: null }),
		);
		expect(m.decision).toBe("allow");
	});

	it("does NOT block on an unsatisfied red-witness — that is a warning only", () => {
		const m = measured(
			evalWith(priorBaseline(), [adaptedGt("killed")], 50, { overlayGreen: true, redWitnessSatisfied: false }),
		);
		expect(m.decision).toBe("allow");
	});

	it("blocks a red suite on a FIRST sighting too — that is the edit, not the baseline", () => {
		const m = measured(
			evalWith(emptyManifest(META), [adaptedGt("killed")], 50, { overlayGreen: false, redWitnessSatisfied: null }),
		);
		expect(m.decision).toBe("block");
	});
});

describe("zip — pairing identities with measured mutants", () => {
	it("ignores a trailing adapted mutant with no matching identity", () => {
		// The engine can report more mutants than the parser identified; the extra
		// must be dropped, never paired with the wrong identity.
		const m = measured(evalWith(priorBaseline(), [adaptedGt("survived"), adaptedGt("survived")]));
		expect(m.newSurvivors.length).toBeGreaterThanOrEqual(1);
	});

	it("refuses an EMPTY measurement as not-measured — zero mutants is never proof of clean (review 2026-08-24 item 1)", () => {
		// This used to be a measured-clean allow that persisted a clean-looking
		// generation from `{files:{}}` — the reviewer's reproduced forged-clean path.
		const out = unavailable(evalWith(priorBaseline(), []));
		expect(out.reason).toContain("zero mutants");
	});
});

// ---------------------------------------------------------------------------
// Key-normalization + test-file rejection at the live gate orchestrator (spec
// of the 2026-07-31 fix): `evaluateMutation` is where the per-edit gate
// actually calls into the manifest, so it must never key a test file, and its
// reads/write must agree on ONE canonical key even when handed an absolute path.
// ---------------------------------------------------------------------------

describe("evaluateMutation — never keys a test/spec file", () => {
	it("N: a test-file target is unavailable, not measured — never blocks, never writes", () => {
		const out = unavailable(
			evaluateMutation({
				file: "src/x.test.ts",
				baseManifest: emptyManifest(META),
				overlayContent: CONTENT,
				adapted: [adaptedGt("survived")],
				siteCountThreshold: 50,
				at: "t",
			}),
		);
		expect(out.warning).toContain("test file");
	});

	it("N: still refuses a test target reached through an absolute path", () => {
		const out = evaluateMutation({
			file: "/repo/root/src/x.test.ts",
			baseManifest: emptyManifest(META),
			overlayContent: CONTENT,
			adapted: [adaptedGt("survived")],
			siteCountThreshold: 50,
			at: "t",
			cwd: "/repo/root",
		});
		expect(out.kind).toBe("unavailable");
	});
});

describe("evaluateMutation — an absolute `file` reads and writes the SAME manifest key", () => {
	const CWD = "/repo/root";

	it("a first-sighting adoption, persisted, is visible to the NEXT call keyed by the repo-relative twin", () => {
		const first = adopted(
			evaluateMutation({
				file: "/repo/root/src/x.ts",
				baseManifest: emptyManifest(META),
				overlayContent: CONTENT,
				adapted: [adaptedGt("killed")],
				siteCountThreshold: 50,
				at: "t",
				// Well-formed run: this case is about manifest KEYING, not evidence.
				testRun: GREEN_RUN,
				executedTestCount: 1,
				engineExitCode: 0,
				cwd: CWD,
			}),
		);
		const persisted = first.refreshedManifest;
		expect(Object.keys(persisted.files)).toEqual(["src/x.ts"]);

		// Same content, now a survivor — evaluated with the REPO-RELATIVE path this
		// time. If the two calls keyed differently, this would read as another
		// first-sighting (no prior baseline) instead of a real ratchet violation.
		const second = measured(
			evaluateMutation({
				file: "src/x.ts",
				baseManifest: persisted,
				overlayContent: CONTENT,
				adapted: [adaptedGt("survived")],
				siteCountThreshold: 50,
				at: "t",
			}),
		);
		expect(second.decision).toBe("block");
	});
});

// Goal 28 §8. The audited #1 false-clean path, reachable with ONE config line:
// point `runner_url` at any mutants-only runner and every mutant comes back
// `Killed` — because no test ever ran — while an absent `testRun` read as
// "not red". The gate allowed the edit AND refreshed the manifest.
describe("evaluateMutation — test-run evidence is a precondition for clean", () => {
	// NOTE: these call `evaluateMutation` directly rather than through
	// `evalWith`. A default parameter fires on an explicitly-passed `undefined`,
	// so the helper cannot express "the runner sent no test run at all" — the
	// absence has to be built at the call.
	function evalNoTestRun(base: MutationManifest, adapted: AdaptedMutant[]): MutationGateOutcome {
		return evaluateMutation({
			file: FILE,
			baseManifest: base,
			overlayContent: CONTENT,
			adapted,
			siteCountThreshold: 50,
			// The engine finished; only the test-run evidence is absent, so these
			// cases isolate exactly the condition their titles name.
			engineExitCode: 0,
			at: "t",
		});
	}

	it("N: mutants with NO test-run evidence are not-measured, never allowed", () => {
		const out = unavailable(evalNoTestRun(manifestFromContent(CONTENT), [adaptedGt("killed")]));
		expect(out.reason).toContain("no test-run evidence");
	});

	// test-contract: invariant — goal 28 §8 "Any not-measured path performs zero
	// manifest and receipt writes". Asserted on the outcome KIND rather than a
	// truthiness check, so the absence of a write is proven by the discriminant
	// the persister actually keys off.
	it("N: an all-killed report with no test run yields an outcome that cannot persist", () => {
		const out = evalNoTestRun(manifestFromContent(CONTENT), [adaptedGt("killed")]);
		expect(out.kind).toBe("unavailable");
	});

	it("P: the SAME report WITH a green test run is measured clean", () => {
		expect(measured(evalWith(manifestFromContent(CONTENT), [adaptedGt("killed")])).decision).toBe("allow");
	});

	// The ordering that must never regress: missing evidence explains why a run
	// cannot CERTIFY; it must never discard what the run did prove.
	it("P: a RED suite still blocks — adverse evidence outranks the evidence gate", () => {
		const red = { overlayGreen: false, redWitnessSatisfied: null };
		expect(measured(evalWith(manifestFromContent(CONTENT), [adaptedGt("killed")], 50, red)).decision).toBe(
			"block",
		);
	});

	// test-contract: invariant — goal 28 §8 census ("generated = executable +
	// approved exclusions"). The adapter used to `continue` past any row it
	// could not parse, so one truncated `location.end` on the SURVIVING mutants
	// made them vanish while the killed ones remained: measuredCount > 0,
	// nothing inconclusive, verdict clean. No adversary required.
	it("N: a short census (dropped report rows) is not-measured, never clean", () => {
		const out = unavailable(
			evaluateMutation({
				file: FILE,
				baseManifest: manifestFromContent(CONTENT),
				overlayContent: CONTENT,
				adapted: [adaptedGt("killed")],
				siteCountThreshold: 50,
				testRun: GREEN_RUN,
				executedTestCount: 1,
				engineExitCode: 0,
				droppedMutants: 2,
				at: "t",
			}),
		);
		expect(out.reason).toContain("incomplete census");
		expect(out.reason).toContain("2 report row(s)");
	});

	// test-contract: invariant — the same run with nothing dropped must still
	// certify, so the census check cannot be satisfied by refusing everything.
	it("P: the same run with a COMPLETE census is measured clean", () => {
		expect(
			measured(
				evaluateMutation({
					file: FILE,
					baseManifest: manifestFromContent(CONTENT),
					overlayContent: CONTENT,
					adapted: [adaptedGt("killed")],
					siteCountThreshold: 50,
					testRun: GREEN_RUN,
					executedTestCount: 1,
					engineExitCode: 0,
					droppedMutants: 0,
					at: "t",
				}),
			).decision,
		).toBe("allow");
	});

	// test-contract: invariant — goal 28 §8 "Red tests remain adverse evidence
	// even with zero or malformed mutants"; missing evidence must never discard
	// a finding the run actually proved.
	it("P: a proven SURVIVOR still blocks even though evidence is missing", () => {
		expect(measured(evalNoTestRun(priorBaseline(), [adaptedGt("survived")])).decision).toBe("block");
	});
});

describe("evaluateMutation — executed-test count is a precondition for clean", () => {
	function evalExecuted(count: number | null | undefined, adapted: AdaptedMutant[]): MutationGateOutcome {
		return evaluateMutation({
			file: FILE,
			baseManifest: manifestFromContent(CONTENT),
			overlayContent: CONTENT,
			adapted,
			siteCountThreshold: 50,
			testRun: GREEN_RUN,
			engineExitCode: 0,
			...(count === undefined ? {} : { executedTestCount: count }),
			at: "t",
		});
	}

	it("N: an absent executed-test count is not-measured", () => {
		const out = unavailable(evalExecuted(undefined, [adaptedGt("killed")]));
		expect(out.reason).toContain("no executed-test count");
	});

	it("N: a malformed executed-test count is not-measured", () => {
		const out = unavailable(evalExecuted(null, [adaptedGt("killed")]));
		expect(out.reason).toContain("no executed-test count");
	});

	it("N: a zero executed-test count is not-measured", () => {
		const out = unavailable(evalExecuted(0, [adaptedGt("killed")]));
		expect(out.reason).toContain("executed-test count was 0");
	});

	it("P: a positive executed-test count permits otherwise-complete evidence", () => {
		expect(measured(evalExecuted(1, [adaptedGt("killed")])).decision).toBe("allow");
	});

	it("P: a proven survivor still blocks without an executed-test count", () => {
		expect(measured(evalExecuted(undefined, [adaptedGt("survived")])).decision).toBe("block");
	});
});

// Goal 28 §8 "engine exit 0", made STRICT 2026-08-28: absence refuses.
// `runner_url` is configurable, so an old runner, proxy, replay, or misdeployed
// Worker can omit the field — and a crashed engine's partial report would then
// read as complete, its unreached survivors invisible.
describe("evaluateMutation — engine-exit evidence is a precondition for clean", () => {
	function evalEngine(exit: number | null | undefined, adapted: AdaptedMutant[]): MutationGateOutcome {
		return evaluateMutation({
			file: FILE,
			baseManifest: manifestFromContent(CONTENT),
			overlayContent: CONTENT,
			adapted,
			siteCountThreshold: 50,
			// Green suite: the engine dimension is the only one under probe.
			testRun: GREEN_RUN,
			executedTestCount: 1,
			...(exit !== undefined ? { engineExitCode: exit } : {}),
			at: "t",
		});
	}

	it("N: ABSENT engine-exit evidence is not-measured, never allowed", () => {
		const out = unavailable(evalEngine(undefined, [adaptedGt("killed")]));
		expect(out.reason).toContain("no engine-exit evidence");
	});

	it("N: a NON-ZERO engine exit is not-measured — a crashed engine's report is partial", () => {
		const out = unavailable(evalEngine(1, [adaptedGt("killed")]));
		expect(out.reason).toContain("engine exited 1");
	});

	it("N: an UNRECOVERABLE status (null) is not-measured — null must never collapse to 0", () => {
		const out = unavailable(evalEngine(null, [adaptedGt("killed")]));
		expect(out.reason).toContain("unrecoverable");
	});

	it("P: an explicit engine exit 0 certifies — the check cannot be satisfied by refusing everything", () => {
		expect(measured(evalEngine(0, [adaptedGt("killed")])).decision).toBe("allow");
	});

	// Review 2026-08-28 second pass, finding 5: the receipt's outcome must state
	// what actually happened — a blocked result's receipt says "finding", and
	// only a clean allow's says "measured_clean". (The gate never persists a
	// block's receipt; this pins the type-level truth, not persistence.)
	it("P: a measured BLOCK's receipt says 'finding', never 'measured_clean'", () => {
		const blocked = measured(evalEngine(0, [adaptedGt("survived")]));
		expect(blocked.decision).toBe("block");
		expect(blocked.receipt.outcome).toBe("finding");
	});

	it("N: a measured-clean allow's receipt says 'measured_clean'", () => {
		expect(measured(evalEngine(0, [adaptedGt("killed")])).receipt.outcome).toBe("measured_clean");
	});

	// The ordering that must never regress: adverse evidence outranks every
	// missing-evidence refusal, including this one.
	it("P: a proven SURVIVOR still blocks even with NO engine-exit evidence", () => {
		expect(measured(evalEngine(undefined, [adaptedGt("survived")])).decision).toBe("block");
	});
});
