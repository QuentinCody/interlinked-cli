import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASELINE_FOLD_LOG_REL } from "../harness/baseline-autofold.js";
import {
	readActivityEvidence,
	readBaselineFoldEvidence,
	readFindingsEvidence,
	readManualDebtLifecycleEvidence,
} from "./impact-evidence-observed.js";
import { manualDebtMarkerSnapshotsPath } from "./manual-debt-marker-record.js";

let cwd: string;

function writeFold(lines: string[]): void {
	const path = join(cwd, BASELINE_FOLD_LOG_REL);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "impact-observed-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("readBaselineFoldEvidence", () => {
	it("reports not-recorded when the fold log is absent", () => {
		const evidence = readBaselineFoldEvidence(cwd);
		expect(evidence.availability).toBe("not-recorded");
		expect(evidence.events).toBe(0);
		expect(evidence.by_kind).toEqual({});
		expect(evidence.evidence_class).toBe("observed");
	});

	it("sums changed and refused counts per kind", () => {
		writeFold([
			JSON.stringify({ kind: "coverage", changed: 2, refused: 1 }),
			JSON.stringify({ kind: "coverage", changed: 3, refused: 0 }),
			JSON.stringify({ kind: "mutation", changed: 1, refused: 0 }),
		]);
		const evidence = readBaselineFoldEvidence(cwd);
		expect(evidence.availability).toBe("available");
		expect(evidence.events).toBe(3);
		expect(evidence.by_kind.coverage).toEqual({ events: 2, changed: 5, refused: 1 });
		expect(evidence.by_kind.mutation).toEqual({ events: 1, changed: 1, refused: 0 });
	});

	it("counts unparseable and kind-less rows as malformed", () => {
		writeFold(["{not json", JSON.stringify({ changed: 1 }), JSON.stringify({ kind: "coverage" })]);
		const evidence = readBaselineFoldEvidence(cwd);
		expect(evidence.malformed_rows).toBe(2);
		expect(evidence.events).toBe(1);
	});

	it("coerces negative and non-finite fold numbers to zero", () => {
		writeFold([
			JSON.stringify({ kind: "coverage", changed: -5, refused: "nope" }),
		]);
		const evidence = readBaselineFoldEvidence(cwd);
		expect(evidence.by_kind.coverage).toEqual({ events: 1, changed: 0, refused: 0 });
	});
});

describe("readActivityEvidence", () => {
	it("reports not-recorded with zero totals on an empty tree", () => {
		const evidence = readActivityEvidence(cwd);
		expect(evidence.availability).toBe("not-recorded");
		expect(evidence.sessions).toBe(0);
		expect(evidence.tokens).toEqual({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });
		expect(evidence.evidence_class).toBe("observed");
	});
});

describe("readFindingsEvidence", () => {
	it("reports not-recorded with zeroed counters on an empty tree", () => {
		const evidence = readFindingsEvidence(cwd);
		expect(evidence.availability).toBe("not-recorded");
		expect(evidence.review_findings).toBe(0);
		expect(evidence.lifecycle).toEqual({
			candidate: 0,
			approved: 0,
			distilled: 0,
			superseded: 0,
		});
		expect(evidence.simplification.findings).toBe(0);
	});
});

describe("readManualDebtLifecycleEvidence", () => {
	it("reports not-recorded with a null latest scope when no snapshot exists", () => {
		const evidence = readManualDebtLifecycleEvidence(cwd);
		expect(evidence.availability).toBe("not-recorded");
		expect(evidence.snapshot_count).toBe(0);
		expect(evidence.latest_scope).toBeNull();
		expect(evidence.transitions).toEqual({ opened: 0, changed: 0, closed: 0 });
		expect(evidence.reason).toBe("No manual debt marker snapshot is recorded.");
	});

	it("reports unavailable when the snapshot file holds no valid receipt", () => {
		const path = manualDebtMarkerSnapshotsPath(cwd);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{not json\n", "utf8");
		const evidence = readManualDebtLifecycleEvidence(cwd);
		expect(evidence.availability).toBe("unavailable");
		expect(evidence.reason).toBe("No valid manual debt marker snapshot is readable.");
	});
});
