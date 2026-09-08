import { nonNull } from "../lib/non-null.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	applyObligationTxn,
	COVERAGE_DESCRIPTOR,
	DEFAULT_STALE_AFTER_EDITS,
	isStale,
	METRIC_DESCRIPTORS,
	MUTATION_DESCRIPTOR,
	type Obligation,
	type ObligationState,
	type ObligationTxn,
	obligationId,
	openObligations,
	parseObligationTxn,
	replayObligations,
} from "./obligations.js";

// ----- helpers -----------------------------------------------------------

/** A coverage open txn with overridable fields. */
function openCoverage(
	over: Partial<{ file: string; contentHash: string; atMs: number; editSeq: number; sessionId: string }> = {},
): ObligationTxn {
	return {
		op: "open",
		kind: "coverage",
		file: over.file ?? "src/foo.ts",
		contentHash: over.contentHash ?? "c1",
		sessionId: over.sessionId ?? "s1",
		atMs: over.atMs ?? 1000,
		editSeq: over.editSeq ?? 1,
	};
}

function only(state: ObligationState): Obligation {
	const open = [...state.values()];
	expect(open).toHaveLength(1);
	// SAFETY: toHaveLength(1) asserted above ⇒ index 0 is present.
	return nonNull(open[0]);
}

// ----- obligationId ------------------------------------------------------

describe("obligationId", () => {
	it("is file-level for coverage (no region)", () => {
		expect(obligationId("coverage", "src/foo.ts")).toBe("coverage:src/foo.ts");
	});

	it("is region-level for mutation", () => {
		expect(obligationId("mutation", "src/foo.ts", { start: 10, end: 20 })).toBe("mutation:src/foo.ts:10-20");
	});

	it("is deterministic", () => {
		expect(obligationId("coverage", "src/x.ts")).toBe(obligationId("coverage", "src/x.ts"));
	});
});

// ----- open --------------------------------------------------------------

describe("applyObligationTxn — open", () => {
	it("inserts an open obligation", () => {
		const state: ObligationState = new Map();
		applyObligationTxn(state, openCoverage());
		const ob = only(state);
		expect(ob.status).toBe("open");
		expect(ob.file).toBe("src/foo.ts");
		expect(ob.contentHash).toBe("c1");
		expect(ob.openedAtMs).toBe(1000);
		expect(ob.editSeq).toBe(1);
	});

	it("continuous re-open preserves the staleness anchor but advances content", () => {
		const state: ObligationState = new Map();
		applyObligationTxn(state, openCoverage({ atMs: 1000, editSeq: 1, contentHash: "c1" }));
		applyObligationTxn(state, openCoverage({ atMs: 5000, editSeq: 9, contentHash: "c2" }));
		const ob = only(state);
		expect(ob.openedAtMs).toBe(1000); // anchored to first touch — no clock reset on churn
		expect(ob.editSeq).toBe(1);
		expect(ob.contentHash).toBe("c2"); // but the described content advances
		expect(ob.status).toBe("open");
	});

	it("re-open AFTER a discharge starts a fresh anchor", () => {
		const state: ObligationState = new Map();
		applyObligationTxn(state, openCoverage({ atMs: 1000, editSeq: 1 }));
		applyObligationTxn(state, { op: "discharge", id: obligationId("coverage", "src/foo.ts"), source: "local", atMs: 2000 });
		applyObligationTxn(state, openCoverage({ atMs: 8000, editSeq: 12 }));
		const ob = only(state);
		expect(ob.status).toBe("open");
		expect(ob.openedAtMs).toBe(8000);
		expect(ob.editSeq).toBe(12);
	});
});

// ----- discharge ---------------------------------------------------------

describe("applyObligationTxn — discharge", () => {
	const id = obligationId("coverage", "src/foo.ts");

	it("marks the obligation discharged and clears it from the open set", () => {
		const state: ObligationState = new Map();
		applyObligationTxn(state, openCoverage());
		applyObligationTxn(state, { op: "discharge", id, source: "observed", atMs: 2000, witness: "sig" });
		const ob = only(state);
		expect(ob.status).toBe("discharged");
		expect(ob.dischargeSource).toBe("observed");
		expect(ob.dischargedAtMs).toBe(2000);
		expect(ob.witness).toBe("sig");
		expect(openObligations(state)).toHaveLength(0);
	});

	it("is a no-op for an unknown id (the stale-cloud reconcile floor)", () => {
		const state: ObligationState = new Map();
		applyObligationTxn(state, { op: "discharge", id, source: "cloud", atMs: 2000 });
		expect(state.size).toBe(0);
	});

	it("is unconditional when forContentHash is omitted", () => {
		const state: ObligationState = new Map();
		applyObligationTxn(state, openCoverage({ contentHash: "c1" }));
		applyObligationTxn(state, { op: "discharge", id, source: "local", atMs: 2000 });
		expect(only(state).status).toBe("discharged");
	});

	it("ignores a discharge measured against stale content, accepts the matching one", () => {
		const state: ObligationState = new Map();
		applyObligationTxn(state, openCoverage({ contentHash: "c1" }));
		// cloud job computed for c1, but the agent re-edited to c2 meanwhile:
		applyObligationTxn(state, openCoverage({ contentHash: "c2", atMs: 1500, editSeq: 2 }));
		applyObligationTxn(state, { op: "discharge", id, source: "cloud", atMs: 3000, forContentHash: "c1" });
		expect(only(state).status).toBe("open"); // stale discharge dropped
		applyObligationTxn(state, { op: "discharge", id, source: "cloud", atMs: 3100, forContentHash: "c2" });
		expect(only(state).status).toBe("discharged"); // matching discharge lands
	});
});

// ----- escalate ----------------------------------------------------------

describe("applyObligationTxn — escalate", () => {
	const id = obligationId("mutation", "src/foo.ts", { start: 5, end: 7 });

	function openMutation(contentHash = "m1"): ObligationTxn {
		return { op: "open", kind: "mutation", file: "src/foo.ts", region: { start: 5, end: 7 }, contentHash, sessionId: "s1", atMs: 1000 };
	}

	it("keeps the obligation open and attaches survivors", () => {
		const state: ObligationState = new Map();
		applyObligationTxn(state, openMutation());
		applyObligationTxn(state, { op: "escalate", id, survivors: [{ line: 6, description: "replaced `>` with `>=`", operator: "ConditionalBoundary" }], atMs: 4000 });
		const ob = only(state);
		expect(ob.status).toBe("open");
		expect(ob.survivors).toHaveLength(1);
		expect(ob.survivors?.[0]?.line).toBe(6);
	});

	it("is a no-op for an unknown id", () => {
		const state: ObligationState = new Map();
		applyObligationTxn(state, { op: "escalate", id, survivors: [{ line: 1, description: "x" }], atMs: 4000 });
		expect(state.size).toBe(0);
	});

	it("a later discharge clears survivors", () => {
		const state: ObligationState = new Map();
		applyObligationTxn(state, openMutation());
		applyObligationTxn(state, { op: "escalate", id, survivors: [{ line: 6, description: "x" }], atMs: 4000 });
		applyObligationTxn(state, { op: "discharge", id, source: "cloud", atMs: 5000 });
		expect(only(state).survivors).toBeUndefined();
	});

	it("a fresh open clears prior survivors", () => {
		const state: ObligationState = new Map();
		applyObligationTxn(state, openMutation("m1"));
		applyObligationTxn(state, { op: "escalate", id, survivors: [{ line: 6, description: "x" }], atMs: 4000 });
		applyObligationTxn(state, openMutation("m2"));
		expect(only(state).survivors).toBeUndefined();
	});
});

// ----- replay + openObligations -----------------------------------------

describe("replayObligations / openObligations", () => {
	it("folds a log into current state", () => {
		const txns: ObligationTxn[] = [
			openCoverage({ file: "src/a.ts" }),
			openCoverage({ file: "src/b.ts" }),
			{ op: "discharge", id: obligationId("coverage", "src/a.ts"), source: "local", atMs: 2000 },
		];
		const state = replayObligations(txns);
		expect(openObligations(state)).toHaveLength(1);
		expect(openObligations(state)[0]?.file).toBe("src/b.ts");
	});

	it("filters open obligations by kind", () => {
		const state = replayObligations([
			openCoverage({ file: "src/a.ts" }),
			{ op: "open", kind: "mutation", file: "src/a.ts", region: { start: 1, end: 2 }, contentHash: "m", sessionId: "s", atMs: 1 },
		]);
		expect(openObligations(state, "mutation")).toHaveLength(1);
		expect(openObligations(state, "coverage")).toHaveLength(1);
		expect(openObligations(state)).toHaveLength(2);
	});
});

// ----- isStale -----------------------------------------------------------

describe("isStale", () => {
	const ob = (editSeq?: number): Obligation => ({
		id: "x",
		kind: "coverage",
		file: "src/x.ts",
		contentHash: "c",
		status: "open",
		sessionId: "s",
		openedAtMs: 0,
		editSeq,
	});

	it("is false within the window", () => {
		expect(isStale(ob(1), 5, 10)).toBe(false);
	});

	it("is true beyond the window", () => {
		expect(isStale(ob(1), 12, 10)).toBe(true); // 12 - 1 = 11 > 10
	});

	it("is never stale for a null window (commit/push backstops)", () => {
		expect(isStale(ob(1), 9999, null)).toBe(false);
	});

	it("is never stale for a zero window (trajectory teeth disabled)", () => {
		expect(isStale(ob(1), 9999, 0)).toBe(false);
	});

	it("is never stale when the obligation has no editSeq", () => {
		expect(isStale(ob(undefined), 9999, 10)).toBe(false);
	});
});

// ----- descriptors -------------------------------------------------------

describe("metric descriptors", () => {
	it("coverage is trajectory-cadenced with a generous default window", () => {
		expect(COVERAGE_DESCRIPTOR.enforcementCadence).toBe("trajectory");
		expect(COVERAGE_DESCRIPTOR.staleAfterEdits).toBe(DEFAULT_STALE_AFTER_EDITS);
		expect(DEFAULT_STALE_AFTER_EDITS).toBeGreaterThanOrEqual(5);
		expect(COVERAGE_DESCRIPTOR.dischargeSources).toEqual(["local", "observed"]);
	});

	it("mutation is push-only, cloud-discharged, never edit-gated", () => {
		expect(MUTATION_DESCRIPTOR.enforcementCadence).toBe("push");
		expect(MUTATION_DESCRIPTOR.staleAfterEdits).toBeNull();
		expect(MUTATION_DESCRIPTOR.dischargeSources).toEqual(["cloud"]);
	});

	it("are indexed by kind", () => {
		expect(METRIC_DESCRIPTORS.coverage).toBe(COVERAGE_DESCRIPTOR);
		expect(METRIC_DESCRIPTORS.mutation).toBe(MUTATION_DESCRIPTOR);
	});
});

// ----- parseObligationTxn ------------------------------------------------

describe("parseObligationTxn — accepts", () => {
	it("round-trips a valid open row through replay", () => {
		const txn = parseObligationTxn({ op: "open", kind: "coverage", file: "src/a.ts", contentHash: "c", sessionId: "s", atMs: 1 });
		expect(txn).not.toBeNull();
		// SAFETY: asserted non-null on the line above.
		const state = replayObligations([nonNull(txn)]);
		expect(openObligations(state)).toHaveLength(1);
	});

	it("accepts a valid open row with a region", () => {
		expect(parseObligationTxn({ op: "open", kind: "mutation", file: "src/a.ts", region: { start: 1, end: 2 }, contentHash: "c", sessionId: "s", atMs: 1 })).not.toBeNull();
	});

	it("accepts a valid discharge row", () => {
		expect(parseObligationTxn({ op: "discharge", id: "coverage:src/a.ts", source: "cloud", atMs: 2 })).not.toBeNull();
	});

	it("accepts a valid escalate row", () => {
		expect(parseObligationTxn({ op: "escalate", id: "mutation:src/a.ts:1-2", survivors: [], atMs: 3 })).not.toBeNull();
	});

	it("accepts an escalate row with well-formed survivor entries, operator included", () => {
		const txn = parseObligationTxn({
			op: "escalate",
			id: "mutation:src/a.ts:1-2",
			survivors: [{ line: 6, description: "replaced `>` with `>=`", operator: "ConditionalBoundary" }],
			atMs: 3,
		});
		expect(txn).toEqual({
			op: "escalate",
			id: "mutation:src/a.ts:1-2",
			survivors: [{ line: 6, description: "replaced `>` with `>=`", operator: "ConditionalBoundary" }],
			atMs: 3,
		});
	});

	it("accepts an escalate row with a survivor entry omitting the optional operator", () => {
		const txn = parseObligationTxn({
			op: "escalate",
			id: "mutation:src/a.ts:1-2",
			survivors: [{ line: 6, description: "x" }],
			atMs: 3,
		});
		expect(txn).toEqual({ op: "escalate", id: "mutation:src/a.ts:1-2", survivors: [{ line: 6, description: "x" }], atMs: 3 });
	});
});

describe("parseObligationTxn — rejects", () => {
	it.each([
		{ label: "null", input: null },
		{ label: "a number", input: 42 },
		{ label: "an unknown op", input: { op: "nope" } },
		{ label: "a bad kind", input: { op: "open", kind: "weird", file: "a", contentHash: "c", sessionId: "s", atMs: 1 } },
		{ label: "open missing file", input: { op: "open", kind: "coverage", contentHash: "c", sessionId: "s", atMs: 1 } },
		{ label: "open with a non-object region", input: { op: "open", kind: "coverage", file: "a", region: 5, contentHash: "c", sessionId: "s", atMs: 1 } },
		{ label: "open with a null region", input: { op: "open", kind: "coverage", file: "a", region: null, contentHash: "c", sessionId: "s", atMs: 1 } },
		{ label: "open with a malformed region", input: { op: "open", kind: "coverage", file: "a", region: { start: "x" }, contentHash: "c", sessionId: "s", atMs: 1 } },
		{ label: "discharge with a bad source", input: { op: "discharge", id: "x", source: "telepathy", atMs: 2 } },
		{ label: "discharge missing id", input: { op: "discharge", source: "local", atMs: 2 } },
		{ label: "escalate without survivors", input: { op: "escalate", id: "x", atMs: 3 } },
		{ label: "escalate with a survivor missing a description", input: { op: "escalate", id: "x", survivors: [{ line: 1 }], atMs: 3 } },
		{ label: "escalate with a non-numeric survivor line", input: { op: "escalate", id: "x", survivors: [{ line: "1", description: "d" }], atMs: 3 } },
		{ label: "escalate with a non-string survivor operator", input: { op: "escalate", id: "x", survivors: [{ line: 1, description: "d", operator: 5 }], atMs: 3 } },
		{ label: "escalate with a non-array survivors field", input: { op: "escalate", id: "x", survivors: "nope", atMs: 3 } },
		{ label: "open with a non-numeric editSeq", input: { op: "open", kind: "coverage", file: "a", contentHash: "c", sessionId: "s", atMs: 1, editSeq: "x" } },
		{ label: "open with a non-numeric strikes", input: { op: "open", kind: "coverage", file: "a", contentHash: "c", sessionId: "s", atMs: 1, strikes: "x" } },
		{ label: "open with a non-string detector", input: { op: "open", kind: "coverage", file: "a", contentHash: "c", sessionId: "s", atMs: 1, detector: 5 } },
		{ label: "discharge with a non-string forContentHash", input: { op: "discharge", id: "x", source: "local", atMs: 2, forContentHash: 5 } },
		{ label: "discharge with a non-string witness", input: { op: "discharge", id: "x", source: "local", atMs: 2, witness: 5 } },
	])("rejects $label", ({ input }) => {
		expect(parseObligationTxn(input)).toBeNull();
	});
});

// ----- property tests (replay invariants, à la reservations) -------------

describe("replay invariants (fast-check)", () => {
	const fileArb = fc.constantFrom("src/a.ts", "src/b.ts");
	const openArb: fc.Arbitrary<ObligationTxn> = fc
		.record({ file: fileArb, contentHash: fc.constantFrom("c1", "c2"), atMs: fc.nat(), editSeq: fc.nat() })
		.map((r): ObligationTxn => ({ op: "open", kind: "coverage", file: r.file, contentHash: r.contentHash, sessionId: "s", atMs: r.atMs, editSeq: r.editSeq }));
	const dischargeArb: fc.Arbitrary<ObligationTxn> = fc
		.record({ file: fileArb, atMs: fc.nat() })
		.map((r): ObligationTxn => ({ op: "discharge", id: obligationId("coverage", r.file), source: "local", atMs: r.atMs }));
	const txnArb = fc.oneof(openArb, dischargeArb);

	const serialize = (s: ObligationState): string =>
		JSON.stringify([...s.entries()].sort((a, b) => a[0].localeCompare(b[0])));

	it("replay is deterministic (no hidden global state)", () => {
		fc.assert(
			fc.property(fc.array(txnArb), (txns) => {
				expect(serialize(replayObligations(txns))).toEqual(serialize(replayObligations(txns)));
			}),
		);
	});

	it("every obligation in the netted state was opened by some open txn", () => {
		fc.assert(
			fc.property(fc.array(txnArb), (txns) => {
				const opened = new Set(
					txns
						.filter((t): t is Extract<ObligationTxn, { op: "open" }> => t.op === "open")
						.map((t) => obligationId(t.kind, t.file, t.region)),
				);
				for (const id of replayObligations(txns).keys()) {
					if (!opened.has(id)) return false;
				}
				return true;
			}),
		);
	});

	it("discharge is idempotent (applying twice equals once)", () => {
		const id = obligationId("coverage", "src/a.ts");
		const base: ObligationTxn[] = [openCoverage({ file: "src/a.ts" })];
		const once = replayObligations([...base, { op: "discharge", id, source: "local", atMs: 1 }]);
		const twice = replayObligations([...base, { op: "discharge", id, source: "local", atMs: 1 }, { op: "discharge", id, source: "local", atMs: 1 }]);
		expect(serialize(once)).toEqual(serialize(twice));
	});
});

describe("red_suite failing-test evidence (open txn field)", () => {
	function openRed(failing?: string[]): ObligationTxn {
		return {
			op: "open",
			kind: "red_suite",
			file: "src/a.ts",
			contentHash: "",
			sessionId: "s1",
			atMs: 1,
			...(failing ? { failingTestFiles: failing } : {}),
		};
	}

	it("carries the evidence onto the netted obligation", () => {
		const state = replayObligations([openRed(["lib/counts.test.ts"])]);
		expect(openObligations(state)[0]?.failingTestFiles).toEqual(["lib/counts.test.ts"]);
	});

	it("a re-open REPLACES the evidence (latest red run is the truth) while keeping the openedAtMs anchor", () => {
		const later: ObligationTxn = { ...openRed(["lib/b.test.ts"]), atMs: 9 };
		const state = replayObligations([openRed(["lib/a.test.ts"]), later]);
		const ob = openObligations(state)[0];
		expect(ob?.failingTestFiles).toEqual(["lib/b.test.ts"]);
		expect(ob?.openedAtMs).toBe(1); // continuous-open staleness anchor preserved
	});

	it("a re-open WITHOUT evidence clears the stale list", () => {
		const state = replayObligations([openRed(["lib/a.test.ts"]), openRed()]);
		expect(openObligations(state)[0]?.failingTestFiles).toBeUndefined();
	});

	it("parseObligationTxn accepts a well-formed failingTestFiles row and rejects malformed ones", () => {
		const good = {
			op: "open",
			kind: "red_suite",
			file: "f.ts",
			contentHash: "",
			sessionId: "s",
			atMs: 1,
			failingTestFiles: ["t.test.ts"],
		};
		expect(parseObligationTxn(good)).toEqual(good);
		expect(parseObligationTxn({ ...good, failingTestFiles: [42] })).toBeNull();
		expect(parseObligationTxn({ ...good, failingTestFiles: "t.test.ts" })).toBeNull();
	});
});
