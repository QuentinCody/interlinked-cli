import { nonNull } from "../../lib/non-null.js";
// Tests for the evidence sweep.

import { describe, expect, it } from "vitest";
import type { CheckRegistration } from "../check-registry/types.js";
import { detectorHash } from "./adversarial.js";
import { evidenceFor, failingVerdicts, staleExemptions, sweepEvidence } from "./extract.js";
import type { DetectorIndex } from "./resolve.js";

function detectExample(): [] {
	return [];
}
function detectOrphan(): [] {
	return [];
}

function check(over: Partial<CheckRegistration> = {}): CheckRegistration {
	return {
		id: "example_check",
		name: "Example",
		description: "example",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		phase: "post",
		fix_instruction: "fix it",
		fn: detectExample,
		resultsPropName: "exampleCheck",
		...over,
	};
}

const WELL_TESTED = `
describe("detectExample — positive (must fire)", () => {
	it("a", () => {});
	it("b", () => {});
	it("c", () => {});
});
describe("detectExample — negative (must not fire)", () => {
	it("d", () => {});
	it("e", () => {});
	it("f", () => {});
});
`;

function index(over: Partial<DetectorIndex> = {}): DetectorIndex {
	return {
		sourceByFn: new Map([["detectExample", "src/harness/checks/example.ts"]]),
		testsByFn: new Map([["detectExample", ["src/harness/checks/example.test.ts"]]]),
		testSource: new Map([["src/harness/checks/example.test.ts", WELL_TESTED]]),
		...over,
	};
}

describe("evidenceFor", () => {
	it("counts labeled cases in both directions", () => {
		const ev = evidenceFor(index(), check());
		expect(ev.positive_count).toBe(3);
		expect(ev.negative_count).toBe(3);
		expect(ev.gaps).toEqual([]);
	});

	it("records the detector and test file paths", () => {
		const ev = evidenceFor(index(), check());
		expect(ev.detector_file).toBe("src/harness/checks/example.ts");
		expect(ev.test_file).toBe("src/harness/checks/example.test.ts");
	});

	it("reports test_file_missing when no test references the detector", () => {
		const ev = evidenceFor(index(), check({ fn: detectOrphan }));
		expect(ev.test_file).toBeNull();
		expect(ev.gaps).toContain("test_file_missing");
		expect(ev.gaps).toContain("detector_source_unresolved");
	});

	it("reports no_labeled_cases when a test exists but labels nothing", () => {
		const idx = index({
			testSource: new Map([
				["src/harness/checks/example.test.ts", 'describe("x", () => { it("y", () => {}); });'],
			]),
		});
		const ev = evidenceFor(idx, check());
		expect(ev.gaps).toEqual(["no_labeled_cases"]);
	});

	it("sums cases across every exercising test file", () => {
		const idx = index({
			testsByFn: new Map([["detectExample", ["a.test.ts", "b.test.ts"]]]),
			testSource: new Map([
				["a.test.ts", 'describe("positive (must fire)", () => { it("1", () => {}); });'],
				["b.test.ts", 'describe("negative (must not fire)", () => { it("2", () => {}); });'],
			]),
		});
		const ev = evidenceFor(idx, check());
		expect(ev.positive_count).toBe(1);
		expect(ev.negative_count).toBe(1);
	});
});

describe("sweepEvidence", () => {
	it("produces one evidence record and one verdict per check", () => {
		const sweep = sweepEvidence({
			registry: [check(), check({ id: "second" })],
			advisoryIds: new Set(),
			index: index(),
		});
		expect(sweep.evidence).toHaveLength(2);
		expect(sweep.verdicts).toHaveLength(2);
	});

	it("applies the advisory tier to advisory post checks", () => {
		const sweep = sweepEvidence({
			registry: [check({ id: "taste" })],
			advisoryIds: new Set(["taste"]),
			index: index(),
		});
		expect(sweep.verdicts[0]?.tier).toBe("post_advisory");
	});

	it("marks grandfathered checks without hiding their shortfalls", () => {
		const sweep = sweepEvidence(
			{ registry: [check({ fn: detectOrphan })], advisoryIds: new Set(), index: index() },
			new Set(["example_check"]),
		);
		const v = sweep.verdicts[0];
		expect(v?.grandfathered).toBe(true);
		expect(v?.satisfied).toBe(false);
		expect(v?.shortfalls.length).toBeGreaterThan(0);
	});

	it("holds a pre_block check to the strictest tier", () => {
		const sweep = sweepEvidence({
			registry: [check({ phase: "pre_block" })],
			advisoryIds: new Set(),
			index: index(),
		});
		expect(sweep.verdicts[0]?.tier).toBe("pre_block");
		expect(sweep.verdicts[0]?.satisfied).toBe(true);
	});
});

describe("corpus wiring", () => {
	it("P1: records a satisfied corpus run on the evidence", () => {
		const ev = evidenceFor(index(), check(), {
			corpus: { files_scanned: 10, hits: [], adjudications: {} },
		});
		expect(ev.corpus_satisfied).toBe(true);
		expect(ev.unadjudicated_hits).toBe(0);
	});

	it("P2: counts unadjudicated hits", () => {
		const ev = evidenceFor(index(), check(), {
			corpus: {
				files_scanned: 10,
				hits: ["a", "b"],
				adjudications: { a: { verdict: "true_positive" } },
			},
		});
		expect(ev.corpus_satisfied).toBe(false);
		expect(ev.unadjudicated_hits).toBe(1);
	});

	it("N1: absent corpus record reads as unsatisfied with no hits", () => {
		const ev = evidenceFor(index(), check());
		expect(ev.corpus_satisfied).toBe(false);
		expect(ev.unadjudicated_hits).toBe(0);
	});

	it("N2: an unenforced corpus dimension does not fail the sweep", () => {
		const sweep = sweepEvidence({ registry: [check()], advisoryIds: new Set(), index: index() });
		expect(sweep.verdicts[0]?.satisfied).toBe(true);
	});

	it("P3: an enforced corpus dimension fails a check with no run", () => {
		const sweep = sweepEvidence({
			registry: [check()],
			advisoryIds: new Set(),
			index: index(),
			enforced: ["cases", "corpus"],
		});
		expect(sweep.verdicts[0]?.satisfied).toBe(false);
		expect(sweep.verdicts[0]?.shortfalls[0]).toMatch(/corpus/);
	});

	it("P4: the sweep routes each check's own corpus record", () => {
		const sweep = sweepEvidence({
			registry: [check()],
			advisoryIds: new Set(),
			index: index(),
			enforced: ["cases", "corpus"],
			corpus: { example_check: { files_scanned: 3, hits: [], adjudications: {} } },
		});
		expect(sweep.verdicts[0]?.satisfied).toBe(true);
	});
});

describe("recall wiring", () => {
	const DETECTOR_SRC = `
export function detectExample(content: string, filePath: string): number[] {
	const out: number[] = [];
	if (!content) return out;
	if (filePath.endsWith(".d.ts")) return out;
	for (const line of content.split("\\n")) {
		if (line.includes("eval(")) out.push(1);
	}
	return out;
}
`;

	it("P1: measures the detector's branch complexity from its source", () => {
		const sweep = sweepEvidence({
			registry: [check()],
			advisoryIds: new Set(),
			index: index(),
			detectorSource: { "src/harness/checks/example.ts": DETECTOR_SRC },
		});
		expect(sweep.evidence[0]?.detector_cyclomatic).not.toBeNull();
		expect(nonNull(sweep.evidence[0]?.detector_cyclomatic)).toBeGreaterThan(1);
	});

	it("P2: derives a case floor at least as strict as the tier floor", () => {
		const sweep = sweepEvidence({
			registry: [check()],
			advisoryIds: new Set(),
			index: index(),
			detectorSource: { "src/harness/checks/example.ts": DETECTOR_SRC },
		});
		expect(sweep.evidence[0]?.derived_case_floor).toBeGreaterThanOrEqual(2);
	});

	it("P3: attaches the detector file's mutation score", () => {
		const sweep = sweepEvidence({
			registry: [check()],
			advisoryIds: new Set(),
			index: index(),
			mutationScores: { "src/harness/checks/example.ts": 0.42 },
		});
		expect(sweep.evidence[0]?.mutation_score).toBe(0.42);
	});

	it("N1: absent source leaves complexity UNKNOWN rather than zero", () => {
		const sweep = sweepEvidence({ registry: [check()], advisoryIds: new Set(), index: index() });
		expect(sweep.evidence[0]?.detector_cyclomatic).toBeNull();
	});

	it("N2: absent mutation data leaves the score null, not zero", () => {
		const sweep = sweepEvidence({ registry: [check()], advisoryIds: new Set(), index: index() });
		expect(sweep.evidence[0]?.mutation_score).toBeNull();
	});

	it("N3: a mutation map without this detector's file yields null", () => {
		const sweep = sweepEvidence({
			registry: [check()],
			advisoryIds: new Set(),
			index: index(),
			mutationScores: { "src/other.ts": 0.9 },
		});
		expect(sweep.evidence[0]?.mutation_score).toBeNull();
	});
});

describe("adversarial wiring", () => {
	const SRC = "export function detectExample() { return []; }";
	const HASH = detectorHash(SRC);

	it("P1: a fresh independent pass over the current source clears the gap", () => {
		const sweep = sweepEvidence({
			registry: [check()],
			advisoryIds: new Set(),
			index: index(),
			detectorSource: { "src/harness/checks/example.ts": SRC },
			adversarial: {
				example_check: { reviewer: "b", author: "a", detector_sha256: HASH, findings: [] },
			},
		});
		expect(sweep.evidence[0]?.adversarial_gap).toBeNull();
	});

	it("P2: a pass over older source reads as stale", () => {
		const sweep = sweepEvidence({
			registry: [check()],
			advisoryIds: new Set(),
			index: index(),
			detectorSource: { "src/harness/checks/example.ts": `${SRC}\n// changed` },
			adversarial: {
				example_check: { reviewer: "b", author: "a", detector_sha256: HASH, findings: [] },
			},
		});
		expect(sweep.evidence[0]?.adversarial_gap).toBe("stale_source");
	});

	it("N1: no record reads as missing, not as satisfied", () => {
		const sweep = sweepEvidence({ registry: [check()], advisoryIds: new Set(), index: index() });
		expect(sweep.evidence[0]?.adversarial_gap).toBe("missing");
	});

	it("N2: another check's record does not satisfy this one", () => {
		const sweep = sweepEvidence({
			registry: [check()],
			advisoryIds: new Set(),
			index: index(),
			detectorSource: { "src/harness/checks/example.ts": SRC },
			adversarial: { other_check: { reviewer: "b", detector_sha256: HASH, findings: [] } },
		});
		expect(sweep.evidence[0]?.adversarial_gap).toBe("missing");
	});
});

describe("failingVerdicts / staleExemptions", () => {
	it("counts only ungrandfathered failures as failing", () => {
		const sweep = sweepEvidence(
			{
				registry: [check({ id: "bad", fn: detectOrphan }), check({ id: "excused", fn: detectOrphan })],
				advisoryIds: new Set(),
				index: index(),
			},
			new Set(["excused"]),
		);
		expect(failingVerdicts(sweep.verdicts).map((v) => v.check_id)).toEqual(["bad"]);
	});

	it("flags grandfathered checks that now pass so the list can shrink", () => {
		const sweep = sweepEvidence(
			{ registry: [check()], advisoryIds: new Set(), index: index() },
			new Set(["example_check"]),
		);
		expect(staleExemptions(sweep.verdicts)).toEqual(["example_check"]);
	});

	it("returns empty lists when everything passes ungrandfathered", () => {
		const sweep = sweepEvidence({ registry: [check()], advisoryIds: new Set(), index: index() });
		expect(failingVerdicts(sweep.verdicts)).toEqual([]);
		expect(staleExemptions(sweep.verdicts)).toEqual([]);
	});
});
