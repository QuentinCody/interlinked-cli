import { describe, expect, it } from "vitest";
import { acceptMutant, findMutantRecord, recordDisposition, refuseAcceptance } from "./accept.js";
import { parseDisposition } from "./disposition.js";
import type {
	HumanApproval,
	ProofCertificate,
	ProofMethod,
	SurvivorDisposition,
} from "./disposition.js";
import { acceptedSurvivors, emptyManifest } from "./manifest.js";
import type { MutantRecord, MutationManifest, SymbolRecord } from "./types.js";

/**
 * The last gate before `mode: block`: some survivors are EQUIVALENT — the
 * mutation changes the code but not its behavior ({kind:"not_ready"} vs {} when
 * only "ready"/"gone" are ever branched on), so no test can ever kill them.
 *
 * Since plan 16 §7 the judgment is a TYPED disposition rather than prose. Prose
 * has no invalidation inputs, so an acceptance outlived the code it described;
 * and the untouched/accepted binary had no home for the survivors that are not
 * equivalences at all, which is what made mislabelling attractive. There are two
 * disjoint doors now: `acceptMutant` (proved equivalence only, certificate
 * checked) and `recordDisposition` (everything else, status untouched).
 */
const FILE = "src/a.ts";
const META = {
	engine: "stryker",
	engineVersion: "9",
	dependencyGraphVersion: "1",
	environmentHash: "e",
	authoritativeAt: "t0",
};
const SYMBOL_HASH = "h1";

function rec(mutantId: string): MutantRecord {
	return {
		mutantId,
		siteId: `${mutantId}-site`,
		mutator: "ObjectLiteral",
		originalLexeme: '{ kind: "not_ready" }',
		replacement: "{}",
		ordinalWithinSymbol: 0,
		status: "survived",
		firstSeen: "t0",
	};
}

function manifestWith(mutants: MutantRecord[]): MutationManifest {
	const symbol: SymbolRecord = {
		symbolId: "sym1",
		qualifiedName: "claimOne",
		symbolHash: SYMBOL_HASH,
		mutants: Object.fromEntries(mutants.map((m) => [m.mutantId, m])),
		instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
	};
	return { ...emptyManifest(META), files: { [FILE]: { sym1: symbol } } };
}

/** A certificate that binds to m1 in the fixture manifest's exact state. */
function certificate(overrides: Partial<ProofCertificate["validity"]> = {}): ProofCertificate {
	return {
		producedBy: "equivalence-verifier",
		verifierVersion: "1.0.0",
		producedAt: "2026-07-31T00:00:00Z",
		validity: {
			mutantId: "m1",
			sourceSymbolHash: SYMBOL_HASH,
			environmentHash: META.environmentHash,
			dependencyGraphVersion: META.dependencyGraphVersion,
			...overrides,
		},
	};
}

/** A rewrite lemma whose two normalized hashes MATCH — the mechanism itself. */
const LEMMA: ProofMethod = {
	kind: "rewrite_lemma",
	lemmaId: "unobservable-default-arm",
	normalizedOriginalHash: "n1",
	normalizedMutantHash: "n1",
};

function proved(method: ProofMethod = LEMMA, cert = certificate()): SurvivorDisposition {
	return { kind: "proved_equivalent", method, certificate: cert };
}

const APPROVAL: HumanApproval = {
	approvedBy: "qcody",
	approvedAt: "2026-07-31T00:00:00Z",
	artifactRef: "reviews/2026-07-31-m1.signed",
};

describe("acceptMutant — positive (must accept)", () => {
	it("P1: a proved equivalence flips the survivor to equivalent", () => {
		const out = acceptMutant({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			disposition: proved(),
		});
		expect(out?.files[FILE]?.sym1?.mutants.m1?.status).toBe("equivalent");
	});

	it("P2: stores the typed disposition, not just prose", () => {
		const out = acceptMutant({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			disposition: proved(),
		});
		const stored = parseDisposition(out?.files[FILE]?.sym1?.mutants.m1?.disposition);
		expect(stored?.kind).toBe("proved_equivalent");
		expect(stored?.kind === "proved_equivalent" && stored.method.kind).toBe("rewrite_lemma");
	});

	it("P3: still writes accepted_reason so pre-typed readers see a WHY", () => {
		// Back-compat runs BOTH ways: old manifests stay loadable (see
		// disposition.test.ts) and new ones stay readable by old consumers.
		const out = acceptMutant({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			disposition: proved(),
		});
		expect(out?.files[FILE]?.sym1?.mutants.m1?.accepted_reason).toContain("rewrite_lemma");
	});

	it("P4: keeps the accepted mutant in the accepted-survivor floor", () => {
		// The behavioral consequence: computeNewSurvivors consults this set, so an
		// accepted equivalent never blocks again.
		const out = acceptMutant({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			disposition: proved(),
		});
		expect(out ? [...acceptedSurvivors(out, FILE)] : []).toContain("m1");
	});

	it("P5: accepts a complete bounded-exhaustive enumeration", () => {
		const out = acceptMutant({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			disposition: proved({
				kind: "bounded_exhaustive",
				domain: "MutantStatus × boolean",
				casesEnumerated: 12,
				domainComplete: true,
			}),
		});
		expect(out?.files[FILE]?.sym1?.mutants.m1?.status).toBe("equivalent");
	});

	it("P6: accepts an UNSAT relational solver result", () => {
		const out = acceptMutant({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			disposition: proved({
				kind: "smt_relational",
				solver: "z3",
				solverVersion: "4.13",
				result: "unsat",
				queryHash: "q1",
			}),
		});
		expect(out?.files[FILE]?.sym1?.mutants.m1?.status).toBe("equivalent");
	});
});

describe("acceptMutant — negative (must refuse)", () => {
	function attempt(disposition: SurvivorDisposition): MutationManifest | null {
		return acceptMutant({ base: manifestWith([rec("m1")]), file: FILE, mutantId: "m1", disposition });
	}

	it("N1: dead_code is NOT an equivalence — accepting would seal the defect in", () => {
		// The measured case: structure/adoption.ts, where hasConfigFile cannot alter
		// any return value (14 mutants). The resolution is a source change; recording
		// it as a reviewed acceptance would bury an unimplemented intent.
		expect(attempt({ kind: "dead_code", resolution: "delete" })).toBeNull();
		expect(attempt({ kind: "dead_code", resolution: "implement", issueRef: "#42" })).toBeNull();
	});

	it("N2: unresolved stays unresolved — search evidence is not proof", () => {
		expect(attempt({ kind: "unresolved" })).toBeNull();
		expect(
			attempt({
				kind: "unresolved",
				evidence: {
					strategy: "fuzz",
					runs: 8_000_000,
					seed: "0xdeadbeef",
					budgetMs: 60_000,
					searchedAt: "2026-07-31T00:00:00Z",
				},
			}),
		).toBeNull();
	});

	it("N3: the other certificate-bearing kinds need the judge, not this door", () => {
		expect(attempt({ kind: "proved_unreachable", invariantRef: "INV-3", certificate: certificate() })).toBeNull();
		expect(attempt({ kind: "duplicate", representativeMutantId: "m2", certificate: certificate() })).toBeNull();
	});

	it("N4: approval-gated kinds are not accepted here", () => {
		expect(
			attempt({
				kind: "outside_contract",
				contractHash: "contract-hash-1",
				observationModelHash: "obs-hash-1",
				approval: APPROVAL,
			}),
		).toBeNull();
		expect(
			attempt({
				kind: "accepted_risk",
				owner: "qcody",
				issue: "#7",
				expiresAt: "2026-12-31T00:00:00Z",
				approval: APPROVAL,
			}),
		).toBeNull();
	});

	it("N5: a killed mutant has nothing to accept", () => {
		expect(attempt({ kind: "killed" })).toBeNull();
	});

	it("N6: a rewrite lemma whose normalized hashes differ is a bare claim", () => {
		expect(
			attempt(proved({ ...LEMMA, normalizedMutantHash: "n2" })),
		).toBeNull();
	});

	it("N7: an empty bounded enumeration proves nothing", () => {
		expect(
			attempt(
				proved({
					kind: "bounded_exhaustive",
					domain: "MutantStatus",
					casesEnumerated: 0,
					domainComplete: true,
				}),
			),
		).toBeNull();
	});

	it("N8: a stale certificate is refused — the symbol moved under the proof", () => {
		// The invalidation input prose never had: the defensive-guard class is
		// equivalent only while the guarded call stays last.
		expect(attempt(proved(LEMMA, certificate({ sourceSymbolHash: "h2" })))).toBeNull();
	});

	it("N9: a certificate for a different mutant does not transfer", () => {
		expect(attempt(proved(LEMMA, certificate({ mutantId: "m2" })))).toBeNull();
	});

	it("N10: a certificate from another environment or graph version is stale", () => {
		expect(attempt(proved(LEMMA, certificate({ environmentHash: "other" })))).toBeNull();
		expect(attempt(proved(LEMMA, certificate({ dependencyGraphVersion: "2" })))).toBeNull();
	});

	it("N11: an unknown mutant id does not invent a record", () => {
		expect(
			acceptMutant({ base: manifestWith([rec("m1")]), file: FILE, mutantId: "nope", disposition: proved() }),
		).toBeNull();
	});

	it("N12: a file with no baseline is refused", () => {
		expect(
			acceptMutant({ base: emptyManifest(META), file: FILE, mutantId: "m1", disposition: proved() }),
		).toBeNull();
	});

	it("N13: does not mutate the input manifest", () => {
		const base = manifestWith([rec("m1")]);
		acceptMutant({ base, file: FILE, mutantId: "m1", disposition: proved() });
		expect(base.files[FILE]?.sym1?.mutants.m1?.status).toBe("survived");
		expect(base.files[FILE]?.sym1?.mutants.m1?.disposition).toBeUndefined();
	});
});

describe("refuseAcceptance", () => {
	it("P1: names dead code as a source defect rather than an equivalence", () => {
		expect(refuseAcceptance({ kind: "dead_code", resolution: "delete" })).toContain(
			"should not exist",
		);
	});

	it("P2: explains a mechanism-free method", () => {
		expect(refuseAcceptance(proved({ ...LEMMA, normalizedMutantHash: "n2" }))).toContain(
			"no mechanism",
		);
	});

	it("N1: returns null for a disposition acceptMutant would take", () => {
		expect(refuseAcceptance(proved())).toBeNull();
	});
});

describe("recordDisposition — the honest home for non-equivalences", () => {
	it("P1: attaches dead_code without touching status", () => {
		const out = recordDisposition({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			disposition: { kind: "dead_code", resolution: "delete", issueRef: "#42" },
		});
		const stored = out?.files[FILE]?.sym1?.mutants.m1;
		expect(stored?.status).toBe("survived");
		expect(parseDisposition(stored?.disposition)?.kind).toBe("dead_code");
	});

	it("P2: never writes accepted_reason, so dead code cannot read as accepted", () => {
		const out = recordDisposition({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			disposition: { kind: "dead_code", resolution: "implement" },
		});
		expect(out?.files[FILE]?.sym1?.mutants.m1?.accepted_reason).toBeUndefined();
	});

	it("P3: records unresolved WITH its counterexample-search evidence", () => {
		const out = recordDisposition({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			disposition: {
				kind: "unresolved",
				evidence: {
					strategy: "property",
					runs: 10_000,
					seed: "seed-7",
					budgetMs: 30_000,
					searchedAt: "2026-07-31T00:00:00Z",
				},
			},
		});
		const stored = parseDisposition(out?.files[FILE]?.sym1?.mutants.m1?.disposition);
		expect(stored?.kind === "unresolved" && stored.evidence?.runs).toBe(10_000);
	});

	it("P4: records the approval-gated and duplicate kinds without accepting them", () => {
		const out = recordDisposition({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			disposition: { kind: "duplicate", representativeMutantId: "m2", certificate: certificate() },
		});
		expect(out?.files[FILE]?.sym1?.mutants.m1?.status).toBe("survived");
		expect(parseDisposition(out?.files[FILE]?.sym1?.mutants.m1?.disposition)?.kind).toBe("duplicate");
	});

	it("N1: refuses proved_equivalent — equivalence has exactly one door", () => {
		expect(
			recordDisposition({
				base: manifestWith([rec("m1")]),
				file: FILE,
				mutantId: "m1",
				disposition: proved(),
			}),
		).toBeNull();
	});

	it("N2: refuses an unknown mutant", () => {
		expect(
			recordDisposition({
				base: manifestWith([rec("m1")]),
				file: FILE,
				mutantId: "nope",
				disposition: { kind: "unresolved" },
			}),
		).toBeNull();
	});

	it("N3: preserves a legacy accepted_reason already on the record", () => {
		const legacy: MutantRecord = {
			...rec("m1"),
			status: "equivalent",
			accepted_reason: "poll loop only branches on ready/gone",
		};
		const out = recordDisposition({
			base: manifestWith([legacy]),
			file: FILE,
			mutantId: "m1",
			disposition: { kind: "dead_code", resolution: "delete" },
		});
		expect(out?.files[FILE]?.sym1?.mutants.m1?.accepted_reason).toContain("ready/gone");
	});
});

describe("findMutantRecord", () => {
	it("P1: returns the record for a known mutant", () => {
		expect(findMutantRecord(manifestWith([rec("m1")]), FILE, "m1")?.mutantId).toBe("m1");
	});

	it("N1: returns null for an unknown id or file, so callers can say which", () => {
		expect(findMutantRecord(manifestWith([rec("m1")]), FILE, "nope")).toBeNull();
		expect(findMutantRecord(manifestWith([rec("m1")]), "src/other.ts", "m1")).toBeNull();
	});
});
