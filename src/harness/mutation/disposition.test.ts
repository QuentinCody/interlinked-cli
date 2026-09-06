import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	certificateHolds,
	describeDisposition,
	dispositionOf,
	equivalenceRefusal,
	grantsEquivalence,
	methodProves,
	parseDisposition,
	type ProofCertificate,
	type SurvivorDisposition,
} from "./disposition.js";
import { acceptedSurvivors, loadManifest } from "./manifest.js";

/**
 * Typed dispositions replace the free-text `accepted_reason` (plan 16 §7). Two
 * obligations meet here:
 *   1. the union must be parseable out of untrusted JSON without throwing, and
 *   2. a manifest written by the PREVIOUS schema must still load, with its prose
 *      preserved verbatim and never silently promoted to evidence.
 */

const CERT: ProofCertificate = {
	producedBy: "equivalence-verifier",
	verifierVersion: "1.0.0",
	producedAt: "2026-07-31T00:00:00Z",
	validity: {
		mutantId: "m1",
		sourceSymbolHash: "h1",
		environmentHash: "e",
		dependencyGraphVersion: "1",
	},
};

describe("parseDisposition — positive (must parse)", () => {
	function roundTrip(d: SurvivorDisposition): SurvivorDisposition | null {
		// Through JSON on purpose: the manifest is a file, not an object graph.
		return parseDisposition(JSON.parse(JSON.stringify(d)));
	}

	it("P1: killed", () => {
		expect(roundTrip({ kind: "killed" })).toEqual({ kind: "killed" });
	});

	it("P2: dead_code, with and without an issue ref", () => {
		expect(roundTrip({ kind: "dead_code", resolution: "delete" })?.kind).toBe("dead_code");
		const withRef = roundTrip({ kind: "dead_code", resolution: "implement", issueRef: "#42" });
		expect(withRef).toEqual({ kind: "dead_code", resolution: "implement", issueRef: "#42" });
	});

	it("P3: proved_equivalent for all three methods", () => {
		expect(
			roundTrip({
				kind: "proved_equivalent",
				method: {
					kind: "rewrite_lemma",
					lemmaId: "demorgan",
					normalizedOriginalHash: "n1",
					normalizedMutantHash: "n1",
				},
				certificate: CERT,
			})?.kind,
		).toBe("proved_equivalent");
		expect(
			roundTrip({
				kind: "proved_equivalent",
				method: {
					kind: "bounded_exhaustive",
					domain: "enum × bool",
					casesEnumerated: 12,
					domainComplete: true,
				},
				certificate: CERT,
			})?.kind,
		).toBe("proved_equivalent");
		expect(
			roundTrip({
				kind: "proved_equivalent",
				method: {
					kind: "smt_relational",
					solver: "z3",
					solverVersion: "4.13",
					result: "unsat",
					queryHash: "q1",
				},
				certificate: CERT,
			})?.kind,
		).toBe("proved_equivalent");
	});

	it("P4: proved_unreachable and duplicate keep their certificate", () => {
		const unreachable = roundTrip({
			kind: "proved_unreachable",
			invariantRef: "INV-3",
			certificate: CERT,
		});
		expect(unreachable?.kind === "proved_unreachable" && unreachable.certificate.producedBy).toBe(
			"equivalence-verifier",
		);
		const dup = roundTrip({ kind: "duplicate", representativeMutantId: "m2", certificate: CERT });
		expect(dup?.kind === "duplicate" && dup.representativeMutantId).toBe("m2");
	});

	it("P5: outside_contract and accepted_risk keep their approval artifact", () => {
		const approval = {
			approvedBy: "qcody",
			approvedAt: "2026-07-31T00:00:00Z",
			artifactRef: "reviews/m1.signed",
		};
		const outside = roundTrip({
			kind: "outside_contract",
			contractHash: "contract-hash-1",
			observationModelHash: "obs-hash-1",
			approval,
		});
		expect(outside?.kind === "outside_contract" && outside.approval.artifactRef).toBe(
			"reviews/m1.signed",
		);
		const risk = roundTrip({
			kind: "accepted_risk",
			owner: "qcody",
			issue: "#7",
			expiresAt: "2026-12-31T00:00:00Z",
			approval,
		});
		expect(risk?.kind === "accepted_risk" && risk.owner).toBe("qcody");
	});

	it("P6: unresolved, bare and with counterexample-search evidence", () => {
		expect(roundTrip({ kind: "unresolved" })).toEqual({ kind: "unresolved" });
		const searched = roundTrip({
			kind: "unresolved",
			evidence: {
				strategy: "fuzz",
				runs: 8_000_000,
				seed: "0xdeadbeef",
				budgetMs: 60_000,
				searchedAt: "2026-07-31T00:00:00Z",
			},
		});
		expect(searched?.kind === "unresolved" && searched.evidence?.runs).toBe(8_000_000);
	});
});

describe("parseDisposition — negative (must not parse)", () => {
	it("N1: non-objects and unknown kinds are null, never a throw", () => {
		expect(parseDisposition(undefined)).toBeNull();
		expect(parseDisposition(null)).toBeNull();
		expect(parseDisposition("proved_equivalent")).toBeNull();
		expect(parseDisposition([{ kind: "killed" }])).toBeNull();
		// A kind written by a NEWER build: unknown, so unusable — but not fatal.
		expect(parseDisposition({ kind: "proved_by_vibes" })).toBeNull();
	});

	it("N2: dead_code needs a resolution the reader can act on", () => {
		expect(parseDisposition({ kind: "dead_code" })).toBeNull();
		expect(parseDisposition({ kind: "dead_code", resolution: "ignore" })).toBeNull();
	});

	it("N3: a proof without a certificate is not a proof", () => {
		expect(
			parseDisposition({
				kind: "proved_equivalent",
				method: { kind: "rewrite_lemma", lemmaId: "x", normalizedOriginalHash: "n1", normalizedMutantHash: "n1" },
			}),
		).toBeNull();
	});

	it("N4: a certificate missing an invalidation input is rejected", () => {
		const validity: Record<string, string> = { ...CERT.validity };
		delete validity.sourceSymbolHash;
		expect(
			parseDisposition({
				kind: "proved_unreachable",
				invariantRef: "INV-3",
				certificate: { ...CERT, validity },
			}),
		).toBeNull();
	});

	it("N5: a sampled domain is not a bounded exhaustive proof", () => {
		expect(
			parseDisposition({
				kind: "proved_equivalent",
				method: { kind: "bounded_exhaustive", domain: "int32", casesEnumerated: 1000, domainComplete: false },
				certificate: CERT,
			}),
		).toBeNull();
	});

	it("N6: only UNSAT is a solver proof", () => {
		expect(
			parseDisposition({
				kind: "proved_equivalent",
				method: { kind: "smt_relational", solver: "z3", solverVersion: "4.13", result: "unknown", queryHash: "q" },
				certificate: CERT,
			}),
		).toBeNull();
	});

	it("N7: approval-gated kinds without an artifact ref are rejected", () => {
		expect(
			parseDisposition({
				kind: "accepted_risk",
				owner: "qcody",
				issue: "#7",
				expiresAt: "2026-12-31",
				approval: { approvedBy: "qcody", approvedAt: "2026-07-31T00:00:00Z" },
			}),
		).toBeNull();
	});

	it("N8: malformed evidence degrades to bare unresolved, losing no honesty", () => {
		expect(parseDisposition({ kind: "unresolved", evidence: { strategy: "vibes" } })).toEqual({
			kind: "unresolved",
		});
	});

	it("N9: an unrecognized proof method kind is not a proof", () => {
		expect(
			parseDisposition({
				kind: "proved_equivalent",
				method: { kind: "vibes_check", note: "looks fine to me" },
				certificate: CERT,
			}),
		).toBeNull();
	});
});

describe("methodProves / certificateHolds", () => {
	it("P1: matching normalized hashes are the rewrite mechanism", () => {
		expect(
			methodProves({
				kind: "rewrite_lemma",
				lemmaId: "demorgan",
				normalizedOriginalHash: "n1",
				normalizedMutantHash: "n1",
			}),
		).toBe(true);
	});

	it("N1: differing hashes, an empty enumeration, or a blank query prove nothing", () => {
		expect(
			methodProves({
				kind: "rewrite_lemma",
				lemmaId: "demorgan",
				normalizedOriginalHash: "n1",
				normalizedMutantHash: "n2",
			}),
		).toBe(false);
		expect(
			methodProves({ kind: "bounded_exhaustive", domain: "d", casesEnumerated: 0, domainComplete: true }),
		).toBe(false);
		expect(
			methodProves({ kind: "smt_relational", solver: "z3", solverVersion: "4", result: "unsat", queryHash: " " }),
		).toBe(false);
	});

	it("P2: a certificate holds against the state it was proved on", () => {
		expect(
			certificateHolds(CERT, {
				mutantId: "m1",
				sourceSymbolHash: "h1",
				environmentHash: "e",
				dependencyGraphVersion: "1",
			}),
		).toBe(true);
	});

	it("N2: any changed invalidation input breaks it", () => {
		const ctx = {
			mutantId: "m1",
			sourceSymbolHash: "h1",
			environmentHash: "e",
			dependencyGraphVersion: "1",
		};
		expect(certificateHolds(CERT, { ...ctx, mutantId: "m2" })).toBe(false);
		expect(certificateHolds(CERT, { ...ctx, sourceSymbolHash: "h2" })).toBe(false);
		expect(certificateHolds(CERT, { ...ctx, environmentHash: "other" })).toBe(false);
		expect(certificateHolds(CERT, { ...ctx, dependencyGraphVersion: "2" })).toBe(false);
	});
});

describe("grantsEquivalence / equivalenceRefusal", () => {
	it("P1: only proved_equivalent grants equivalence", () => {
		expect(
			grantsEquivalence({
				kind: "proved_equivalent",
				method: { kind: "rewrite_lemma", lemmaId: "x", normalizedOriginalHash: "n", normalizedMutantHash: "n" },
				certificate: CERT,
			}),
		).toBe(true);
		expect(equivalenceRefusal({ kind: "proved_equivalent", method: { kind: "rewrite_lemma", lemmaId: "x", normalizedOriginalHash: "n", normalizedMutantHash: "n" }, certificate: CERT })).toBeNull();
	});

	it("N1: every other kind is refused with a reason naming its real resolution", () => {
		expect(grantsEquivalence({ kind: "dead_code", resolution: "delete" })).toBe(false);
		expect(equivalenceRefusal({ kind: "dead_code", resolution: "delete" })).toContain(
			"should not exist",
		);
		expect(equivalenceRefusal({ kind: "unresolved" })).toContain("honest resting state");
		expect(equivalenceRefusal({ kind: "killed" })).toContain("needs no disposition");
	});
});

describe("describeDisposition", () => {
	it("P1: renders each kind as one auditable line", () => {
		expect(describeDisposition({ kind: "killed" })).toBe("killed");
		expect(describeDisposition({ kind: "dead_code", resolution: "delete", issueRef: "#42" })).toBe(
			"dead code (delete) — #42",
		);
		expect(describeDisposition({ kind: "proved_unreachable", invariantRef: "INV-3", certificate: CERT })).toContain(
			"INV-3",
		);
		expect(describeDisposition({ kind: "duplicate", representativeMutantId: "m2", certificate: CERT })).toContain(
			"m2",
		);
		expect(describeDisposition({ kind: "unresolved" })).toBe("unresolved");
		expect(
			describeDisposition({
				kind: "unresolved",
				evidence: { strategy: "fuzz", runs: 12, seed: "s", budgetMs: 1, searchedAt: "t" },
			}),
		).toContain("no counterexample found");
	});

	it("P2: outside_contract and accepted_risk name the approver in the line", () => {
		expect(
			describeDisposition({
				kind: "outside_contract",
				contractHash: "c1",
				observationModelHash: "obs1",
				approval: { approvedBy: "qcody", approvedAt: "2026-07-31T00:00:00Z", artifactRef: "review#1" },
			}),
		).toBe("outside contract c1 (approved by qcody)");
		expect(
			describeDisposition({
				kind: "accepted_risk",
				owner: "qcody",
				issue: "#7",
				expiresAt: "2026-12-31",
				approval: { approvedBy: "qcody", approvedAt: "2026-07-31T00:00:00Z", artifactRef: "review#1" },
			}),
		).toBe("accepted risk owned by qcody until 2026-12-31 (#7)");
	});
});

describe("dispositionOf — reading both schemas", () => {
	it("P1: a typed disposition wins", () => {
		const view = dispositionOf({
			status: "equivalent",
			accepted_reason: "prose",
			disposition: { kind: "dead_code", resolution: "delete" },
		});
		expect(view.source).toBe("typed");
		expect(view.disposition.kind).toBe("dead_code");
	});

	it("P2: legacy prose reads as unresolved, with the text preserved verbatim", () => {
		// Prose is not a mechanism, so it must not read as proved. Nothing is lost:
		// the text comes back in legacyReason and stays on the record.
		const view = dispositionOf({ status: "equivalent", accepted_reason: "  poll loop only  " });
		expect(view.source).toBe("legacy_prose");
		expect(view.disposition.kind).toBe("unresolved");
		expect(view.legacyReason).toBe("  poll loop only  ");
	});

	it("P3: an unexamined survivor is unresolved with no source", () => {
		const view = dispositionOf({ status: "survived" });
		expect(view.source).toBe("none");
		expect(view.disposition.kind).toBe("unresolved");
	});

	it("P4: a killed mutant reads as killed", () => {
		expect(dispositionOf({ status: "killed" }).disposition.kind).toBe("killed");
	});

	it("N1: a malformed typed disposition falls back instead of throwing", () => {
		const view = dispositionOf({
			status: "equivalent",
			accepted_reason: "prose",
			disposition: { kind: "proved_equivalent" },
		});
		expect(view.source).toBe("legacy_prose");
		expect(view.legacyReason).toBe("prose");
	});

	it("N2: a blank accepted_reason is not treated as prose", () => {
		expect(dispositionOf({ status: "equivalent", accepted_reason: "   " }).source).toBe("none");
	});
});

// ===========================================
// Backward compatibility, proven against a file on disk
// ===========================================
describe("old-shape manifest fixture", () => {
	let dir: string;

	/** Byte-for-byte the PREVIOUS schema: no `disposition` anywhere, an accepted
	 *  equivalent carrying only prose. */
	const OLD_SHAPE = {
		version: 1,
		generation: 3,
		authoritativeAt: "2026-07-28T12:00:00Z",
		engine: "stryker",
		engineVersion: "9",
		dependencyGraphVersion: "1",
		environmentHash: "e",
		files: {
			"src/a.ts": {
				sym1: {
					symbolId: "sym1",
					qualifiedName: "claimOne",
					symbolHash: "h1",
					mutants: {
						m1: {
							mutantId: "m1",
							siteId: "m1-site",
							mutator: "ObjectLiteral",
							originalLexeme: '{ kind: "not_ready" }',
							replacement: "{}",
							ordinalWithinSymbol: 0,
							status: "equivalent",
							firstSeen: "2026-07-01T00:00:00Z",
							accepted_reason: "poll loop only branches on ready/gone; the default arm is unobservable",
						},
						m2: {
							mutantId: "m2",
							siteId: "m2-site",
							mutator: "EqualityOperator",
							originalLexeme: ">",
							replacement: ">=",
							ordinalWithinSymbol: 1,
							status: "survived",
							firstSeen: "2026-07-01T00:00:00Z",
						},
					},
					instability: { events: [], consecutiveStableRuns: 4, quarantined: false },
				},
			},
		},
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mut-disposition-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "mutation-manifest.json"),
			`${JSON.stringify(OLD_SHAPE)}\n`,
			"utf-8",
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("P1: loads without throwing", () => {
		expect(loadManifest(join(dir, ".interlinked"))).not.toBeNull();
	});

	it("P2: loses no data — the prose survives the load verbatim", () => {
		const loaded = loadManifest(join(dir, ".interlinked"));
		const m1 = loaded?.files["src/a.ts"]?.sym1?.mutants.m1;
		expect(m1?.status).toBe("equivalent");
		expect(m1?.accepted_reason).toBe(
			"poll loop only branches on ready/gone; the default arm is unobservable",
		);
		expect(m1?.disposition).toBeUndefined();
	});

	it("P3: the gate's accepted-survivor floor is unchanged by the new schema", () => {
		const loaded = loadManifest(join(dir, ".interlinked"));
		const accepted = loaded ? [...acceptedSurvivors(loaded, "src/a.ts")] : [];
		expect(accepted.sort()).toEqual(["m1", "m2"]);
	});

	it("P4: the old acceptance reads as legacy prose, not as proof", () => {
		const loaded = loadManifest(join(dir, ".interlinked"));
		const m1 = loaded?.files["src/a.ts"]?.sym1?.mutants.m1;
		const view = dispositionOf(m1 ?? {});
		expect(view.source).toBe("legacy_prose");
		expect(view.disposition.kind).toBe("unresolved");
		expect(view.legacyReason).toContain("unobservable");
	});

	it("P5: an untouched old survivor reads as unresolved with no evidence", () => {
		const loaded = loadManifest(join(dir, ".interlinked"));
		const view = dispositionOf(loaded?.files["src/a.ts"]?.sym1?.mutants.m2 ?? {});
		expect(view.source).toBe("none");
		expect(view.disposition).toEqual({ kind: "unresolved" });
	});
});
