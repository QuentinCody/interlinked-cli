// ===========================================
// Reconciliation — mutation-hardening tests
// ===========================================
// Each test pins one documented behavior of reconcile() that a single-change
// mutant of graph-prediction-reconcile.ts survived against the original test
// file. Basis for each claim is cited next to the test: the module header
// (graph-prediction-reconcile.ts:4-23), the doc comments on ReconcileInputs /
// isFieldAbstained / SECTION_WEIGHTS, and the prompt format in
// graph-prediction-flow.ts:221-222.

import { describe, expect, it } from "vitest";
import type { PerSectionScore } from "../graph-prediction-cache.js";
import type { ParsedGraphPrediction } from "../graph-prediction-parser.js";
import { reconcile } from "../graph-prediction-reconcile.js";
import type { SupermodelGraph } from "../supermodel-graph.js";

type Impact = NonNullable<SupermodelGraph["impact"]>;

function impactOf(overrides: Partial<Impact> = {}): Impact {
	return { risk: "MEDIUM", domains: [], direct: 5, transitive: 12, affects: [], ...overrides };
}

function oracleOf(overrides: Partial<SupermodelGraph> = {}): SupermodelGraph {
	return {
		shardPath: "/abs/foo.graph.ts",
		sourcePath: "/abs/foo.ts",
		impact: impactOf(),
		deps: { imports: [], importedBy: [] },
		calls: { callers: [], callees: [] },
		...overrides,
	};
}

function predOf(overrides: Partial<ParsedGraphPrediction> = {}): ParsedGraphPrediction {
	return {
		file: "src/foo.ts",
		deps: { imports: [], imported_by: [] },
		calls: { callers: [], callees: [] },
		impact: { risk: "medium", domains: [], direct: 5, transitive: 12, affects: [] },
		parse_status: "ok",
		...overrides,
	};
}

const ALL_ABSTAINED: Partial<ParsedGraphPrediction> = {
	deps: { imports: "unknown", imported_by: "unknown" },
	calls: { callers: "unknown", callees: "unknown" },
	impact: {
		risk: "unknown",
		domains: "unknown",
		direct: "unknown",
		transitive: "unknown",
		affects: "unknown",
	},
};

const ALL_KEYS: Array<keyof PerSectionScore> = [
	"deps.imports",
	"deps.imported_by",
	"calls.callers",
	"calls.callees",
	"impact.risk",
	"impact.domains",
	"impact.direct",
	"impact.transitive",
	"impact.affects",
];

function allExcept(...keep: Array<keyof PerSectionScore>): ReadonlySet<keyof PerSectionScore> {
	return new Set(ALL_KEYS.filter((k) => !keep.includes(k)));
}

const names = (prefix: string, n: number): string[] =>
	Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, "0")}.ts`);

describe("reconcile — high-impact oracle boundaries (header lines 18-20: direct >= 10 OR transitive >= 50)", () => {
	// m02: `direct >= 10` mutated to `> 10`.
	it("treats an oracle with direct exactly 10 as high impact", () => {
		const r = reconcile({
			prediction: predOf(ALL_ABSTAINED),
			oracle: oracleOf({ impact: impactOf({ direct: 10, transitive: 10 }) }),
		});
		expect(r.high_impact_oracle).toBe(true);
		expect(r.decision).toBe("ack_required");
	});

	// m03: `transitive >= 50` mutated to `> 50`.
	it("treats an oracle with transitive exactly 50 as high impact", () => {
		const r = reconcile({
			prediction: predOf(ALL_ABSTAINED),
			oracle: oracleOf({ impact: impactOf({ direct: 1, transitive: 50 }) }),
		});
		expect(r.high_impact_oracle).toBe(true);
		expect(r.decision).toBe("ack_required");
	});

	// m04: guard `if (!oracle.impact) return false` removed (throws TypeError).
	it("reports an oracle without an impact section as not high impact instead of throwing", () => {
		const r = reconcile({ prediction: predOf(), oracle: oracleOf({ impact: null }) });
		expect(r.high_impact_oracle).toBe(false);
	});
});

describe("reconcile — oracle without impact section (ReconcileInputs.unavailable doc, lines 96-102)", () => {
	// m10: guard `if (!oracle.impact) return` in scoreScalarSections removed.
	it("scores no impact.direct/transitive/risk section when the oracle has no impact section", () => {
		const r = reconcile({ prediction: predOf(), oracle: oracleOf({ impact: null }) });
		expect(r.per_section_score["impact.direct"]).toBeUndefined();
		expect(r.per_section_score["impact.transitive"]).toBeUndefined();
		expect(r.per_section_score["impact.risk"]).toBeUndefined();
	});

	// m13: unavailable guard for impact.risk removed.
	it("excludes impact.risk from scoring when it is marked unavailable", () => {
		const r = reconcile({
			prediction: predOf(),
			oracle: oracleOf(),
			unavailable: new Set<keyof PerSectionScore>(["impact.risk"]),
		});
		expect(r.per_section_score["impact.risk"]).toBeUndefined();
		expect(r.miss_set["impact.risk"]).toBeUndefined();
		expect(r.per_section_score["impact.direct"]).toBeDefined();
	});
});

describe("reconcile — call-edge formats (graph-prediction-flow.ts:221-222: callers 'fn ← caller', callees 'fn → callee')", () => {
	// m07: caller key built as `${caller} ← ${fn}`.
	it("scores a prediction written as 'fn ← caller' as a perfect match for that oracle caller edge", () => {
		const r = reconcile({
			prediction: predOf({ calls: { callers: ["F ← C"], callees: [] } }),
			oracle: oracleOf({
				calls: { callers: [{ fn: "F", caller: "C", file: "x.ts", line: 1 }], callees: [] },
			}),
		});
		expect(r.per_section_score["calls.callers"]).toBe(1);
	});

	// m08: callee key built with "->" instead of "→".
	it("scores a prediction written as 'fn → callee' as a perfect match for that oracle callee edge", () => {
		const r = reconcile({
			prediction: predOf({ calls: { callers: [], callees: ["F → G"] } }),
			oracle: oracleOf({
				calls: { callers: [], callees: [{ fn: "F", callee: "G", file: "x.ts", line: 1 }] },
			}),
		});
		expect(r.per_section_score["calls.callees"]).toBe(1);
	});
});

describe("reconcile — miss_set and weighted average telemetry", () => {
	// m16: weights never accumulated, so weighted_avg is always 0.
	it("reports weighted_avg 1 when every section matches the oracle exactly", () => {
		const r = reconcile({
			prediction: predOf({
				deps: { imports: ["i.ts"], imported_by: ["b.ts"] },
				calls: { callers: ["F ← C"], callees: ["F → G"] },
				impact: {
					risk: "medium",
					domains: ["D"],
					direct: 5,
					transitive: 12,
					affects: ["b.ts"],
				},
			}),
			oracle: oracleOf({
				deps: { imports: ["i.ts"], importedBy: ["b.ts"] },
				calls: {
					callers: [{ fn: "F", caller: "C", file: "x.ts", line: 1 }],
					callees: [{ fn: "F", callee: "G", file: "x.ts", line: 1 }],
				},
				impact: impactOf({ domains: ["D"], affects: ["b.ts"] }),
			}),
		});
		expect(r.weighted_avg).toBeCloseTo(1, 10);
	});

	// m17: `if (miss) acc.missSet[key] = miss` removed.
	it("records what was missed in miss_set and leaves exact sections out of it", () => {
		const r = reconcile({
			prediction: predOf({
				deps: { imports: [], imported_by: [] },
				impact: { risk: "low", domains: [], direct: 5, transitive: 12, affects: [] },
			}),
			oracle: oracleOf({ deps: { imports: [], importedBy: ["a.ts"] } }),
		});
		expect(r.miss_set["deps.imported_by"]?.missed).toEqual(["a.ts"]);
		expect(r.miss_set["impact.risk"]).toMatchObject({ predicted: "low", oracle: "MEDIUM" });
		expect(r.miss_set["impact.direct"]).toBeUndefined();
	});

	// m18: impact.risk weight lowered to equal impact.direct (SECTION_WEIGHTS doc, lines 61-64:
	// "impact.risk is the highest").
	it("weights a correct impact.risk above a correct impact.direct in the weighted average", () => {
		const unavailable = allExcept("impact.risk", "impact.direct");
		const riskWrongDirectRight = reconcile({
			prediction: predOf({
				impact: { risk: "high", domains: [], direct: 5, transitive: 12, affects: [] },
			}),
			oracle: oracleOf(),
			unavailable,
		});
		const riskRightDirectWrong = reconcile({
			prediction: predOf({
				impact: { risk: "medium", domains: [], direct: 0, transitive: 12, affects: [] },
			}),
			oracle: oracleOf(),
			unavailable,
		});
		expect(riskRightDirectWrong.weighted_avg).toBeGreaterThan(riskWrongDirectRight.weighted_avg);
	});

	// m19: deps.imported_by weight lowered to equal deps.imports (SECTION_WEIGHTS doc:
	// "harder-to-predict sections (imported_by, callers) carry more weight").
	it("weights a correct deps.imported_by above a correct deps.imports in the weighted average", () => {
		const unavailable = allExcept("deps.imports", "deps.imported_by");
		const oracle = oracleOf({ deps: { imports: ["x.ts"], importedBy: ["y.ts"] } });
		const importsRight = reconcile({
			prediction: predOf({ deps: { imports: ["x.ts"], imported_by: [] } }),
			oracle,
			unavailable,
		});
		const importedByRight = reconcile({
			prediction: predOf({ deps: { imports: [], imported_by: ["y.ts"] } }),
			oracle,
			unavailable,
		});
		expect(importedByRight.weighted_avg).toBeGreaterThan(importsRight.weighted_avg);
	});

	// m20: `weightSum > 0` mutated to `>= 0` (0/0 = NaN when every section is unavailable).
	it("reports a finite weighted_avg of 0 when every section is unavailable", () => {
		const r = reconcile({
			prediction: predOf(),
			oracle: oracleOf(),
			unavailable: new Set(ALL_KEYS),
		});
		expect(Number.isNaN(r.weighted_avg)).toBe(false);
		expect(r.weighted_avg).toBe(0);
	});
});

describe("reconcile — medium severity floor (MEDIUM_SEVERITY_AVG_FLOOR, graph-prediction-reconcile.ts:47,408)", () => {
	// Weights: risk 2 + direct 1 + imported_by 1.5 + imports 0.5 = 5; correct risk and
	// direct contribute 3, so the average is exactly 3/5 = 0.6 with no trigger fired.
	const atFloor = () =>
		reconcile({
			prediction: predOf({
				deps: { imports: [], imported_by: [] },
				impact: { risk: "medium", domains: [], direct: 5, transitive: 12, affects: [] },
			}),
			oracle: oracleOf({ deps: { imports: ["x.ts"], importedBy: ["y.ts"] } }),
			unavailable: allExcept("deps.imports", "deps.imported_by", "impact.risk", "impact.direct"),
		});

	// m21: `weightedAvg < FLOOR` mutated to `<=`.
	it("does not classify an average exactly at the floor as medium severity", () => {
		const r = atFloor();
		expect(r.weighted_avg).toBe(0.6);
		expect(r.triggers).toEqual([]);
		expect(r.severity).toBe("low");
	});

	// m22: floor raised from 0.6 to 0.7.
	it("keeps an average of 2/3 (above the floor) at low severity", () => {
		const r = reconcile({
			prediction: predOf({
				impact: { risk: "medium", domains: [], direct: 0, transitive: 12, affects: [] },
			}),
			oracle: oracleOf(),
			unavailable: allExcept("impact.risk", "impact.direct"),
		});
		expect(r.weighted_avg).toBeCloseTo(2 / 3, 10);
		expect(r.severity).toBe("low");
	});
});

describe("reconcile — recall predicates at their boundaries (header lines 13-16)", () => {
	// m23: imported_by floor raised 0.3 -> 0.4. Recall 7/20 = 0.35 is not below 0.3.
	it("does not flag imported_by when recall is 0.35 (above the 0.3 floor)", () => {
		const importers = names("imp", 20);
		const r = reconcile({
			prediction: predOf({ deps: { imports: [], imported_by: importers.slice(0, 7) } }),
			oracle: oracleOf({ deps: { imports: [], importedBy: importers } }),
		});
		expect(r.triggers).not.toContain("imported_by_recall_low");
	});

	// m25: `recall < floor` mutated to `<=`. Recall 3/10 = 0.3 is not below 0.3.
	it("does not flag imported_by when recall is exactly 0.3", () => {
		const importers = names("imp", 10);
		const r = reconcile({
			prediction: predOf({ deps: { imports: [], imported_by: importers.slice(0, 3) } }),
			oracle: oracleOf({ deps: { imports: [], importedBy: importers } }),
		});
		expect(r.triggers).not.toContain("imported_by_recall_low");
	});

	// m26: `oracleCount >= min` mutated to `>`. Header: "oracle has >= 5 importers".
	it("flags imported_by when the oracle has exactly 5 importers and recall is 0", () => {
		const r = reconcile({
			prediction: predOf({ deps: { imports: [], imported_by: [] } }),
			oracle: oracleOf({ deps: { imports: [], importedBy: names("imp", 5) } }),
		});
		expect(r.triggers).toContain("imported_by_recall_low");
	});

	// m28: CALLERS_ORACLE_MIN raised 5 -> 6. Header: "oracle has >= 5 callers".
	it("flags callers when the oracle has exactly 5 callers and recall is 0", () => {
		const callers = Array.from({ length: 5 }, (_, i) => ({
			fn: `f${i}`,
			caller: `c${i}`,
			file: "x.ts",
			line: 1,
		}));
		const r = reconcile({
			prediction: predOf({ calls: { callers: [], callees: [] } }),
			oracle: oracleOf({ calls: { callers, callees: [] } }),
		});
		expect(r.triggers).toContain("callers_recall_low");
	});

	// m24: DOMAINS_RECALL_FLOOR raised 0.5 -> 0.6. Recall 11/20 = 0.55 is not below 0.5.
	it("does not flag domains when recall is 0.55 (above the 0.5 floor)", () => {
		const domains = names("dom", 20);
		const r = reconcile({
			prediction: predOf({
				impact: {
					risk: "medium",
					domains: domains.slice(0, 11),
					direct: 5,
					transitive: 12,
					affects: [],
				},
			}),
			oracle: oracleOf({ impact: impactOf({ domains }) }),
		});
		expect(r.triggers).not.toContain("domains_recall_low");
	});

	// m27: DOMAINS_ORACLE_MIN raised 3 -> 4. Header: "oracle has >= 3 domains".
	it("flags domains when the oracle has exactly 3 domains and recall is 0", () => {
		const r = reconcile({
			prediction: predOf({
				impact: { risk: "medium", domains: [], direct: 5, transitive: 12, affects: [] },
			}),
			oracle: oracleOf({ impact: impactOf({ domains: ["A", "B", "C"] }) }),
		});
		expect(r.triggers).toContain("domains_recall_low");
	});
});

describe("reconcile — direct-count predicate at its boundaries (header line 12: predicted <= 3 AND oracle >= 10)", () => {
	// m30: `predictedDirect <= 3` mutated to `< 3`.
	it("flags direct_count_underestimated when predicted direct is exactly 3", () => {
		const r = reconcile({
			prediction: predOf({
				impact: { risk: "medium", domains: [], direct: 3, transitive: 12, affects: [] },
			}),
			oracle: oracleOf({ impact: impactOf({ direct: 12 }) }),
		});
		expect(r.triggers).toContain("direct_count_underestimated");
	});

	// m31: `oracleDirect >= 10` mutated to `> 10`.
	it("flags direct_count_underestimated when oracle direct is exactly 10", () => {
		const r = reconcile({
			prediction: predOf({
				impact: { risk: "medium", domains: [], direct: 1, transitive: 12, affects: [] },
			}),
			oracle: oracleOf({ impact: impactOf({ direct: 10 }) }),
		});
		expect(r.triggers).toContain("direct_count_underestimated");
	});
});

describe("reconcile — full abstention means EVERY section is unknown (header line 18; isFieldAbstained doc, lines 375-379)", () => {
	// m37: `.every(isFieldAbstained)` mutated to `.some`.
	it("does not classify a prediction as full_abstention when only one section is unknown", () => {
		const r = reconcile({
			prediction: predOf({ calls: { callers: "unknown", callees: [] } }),
			oracle: oracleOf(),
		});
		expect(r.severity).not.toBe("full_abstention");
	});

	// m38: an empty list counted as abstention. Doc: "An empty list [] is an explicit
	// assertion of absence - not abstention."
	it("does not treat explicit empty lists as abstention", () => {
		const r = reconcile({
			prediction: predOf({
				deps: { imports: [], imported_by: [] },
				calls: { callers: [], callees: [] },
				impact: {
					risk: "unknown",
					domains: [],
					direct: "unknown",
					transitive: "unknown",
					affects: [],
				},
			}),
			oracle: oracleOf(),
		});
		expect(r.severity).not.toBe("full_abstention");
	});

	// m39: a missing deps section treated as an asserted empty imports list. A null
	// section is an abstained list (graph-prediction-reconcile-scoring.ts isAbstainedList).
	it("treats a prediction with no deps, calls or impact section as full abstention", () => {
		const r = reconcile({
			prediction: predOf({ deps: null, calls: null, impact: null }),
			oracle: oracleOf(),
		});
		expect(r.severity).toBe("full_abstention");
	});
});
