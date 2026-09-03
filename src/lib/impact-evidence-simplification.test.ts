import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simplificationRunsPath } from "../harness/findings/simplification-record.js";
import {
	potentialEvidence,
	readSimplificationReceipts,
	sandboxValidatedEvidence,
} from "./impact-evidence-simplification.js";

let cwd: string;

function writeRuns(lines: string[]): void {
	const path = simplificationRunsPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "impact-simplification-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("readSimplificationReceipts", () => {
	it("reports not-recorded when the receipt stream is absent", () => {
		const parsed = readSimplificationReceipts(cwd);
		expect(parsed.evidence.availability).toBe("not-recorded");
		expect(parsed.evidence.path).toBe(simplificationRunsPath(cwd));
		expect(parsed.evidence.receipt_rows).toBe(0);
		expect(parsed.evidence.reason).toBe("No recorded simplification run receipt is available.");
		expect(parsed.receipts).toEqual([]);
		expect(parsed.latest).toEqual([]);
	});

	it("reports unavailable when every recorded row is malformed", () => {
		writeRuns(["{not json", JSON.stringify({ nope: true })]);
		const parsed = readSimplificationReceipts(cwd);
		expect(parsed.evidence.availability).toBe("unavailable");
		expect(parsed.evidence.receipt_rows).toBe(2);
		expect(parsed.evidence.valid_receipts).toBe(0);
		expect(parsed.evidence.malformed_receipts).toBe(2);
		expect(parsed.evidence.reason).toBe(
			"The simplification receipt stream contains no schema-valid, hash-bound run receipt.",
		);
	});

	it("ignores blank lines when counting receipt rows", () => {
		writeRuns(["", "   ", "{not json"]);
		const parsed = readSimplificationReceipts(cwd);
		expect(parsed.evidence.receipt_rows).toBe(1);
		expect(parsed.evidence.malformed_receipts).toBe(1);
	});
});

describe("potentialEvidence", () => {
	it("carries the receipt reason forward when nothing is recorded", () => {
		const parsed = readSimplificationReceipts(cwd);
		const potential = potentialEvidence(parsed);
		expect(potential.evidence_class).toBe("potential");
		expect(potential.available).toBe(false);
		expect(potential.availability).toBe("not-recorded");
		expect(potential.loc_delta).toBeNull();
		expect(potential.representative_findings).toBe(0);
		expect(potential.note).toBe("No recorded simplification run receipt is available.");
	});
});

describe("sandboxValidatedEvidence", () => {
	it("stays not-recorded with no eligible validated finding", () => {
		const parsed = readSimplificationReceipts(cwd);
		const sandbox = sandboxValidatedEvidence(parsed);
		expect(sandbox.evidence_class).toBe("sandbox-validated");
		expect(sandbox.available).toBe(false);
		expect(sandbox.availability).toBe("not-recorded");
		expect(sandbox.eligible_validated_findings).toBe(0);
		expect(sandbox.loc_delta).toBeNull();
		expect(sandbox.note).toBe(
			"No latest recorded finding has passed Sandbox validation with an exact validated delta.",
		);
	});

	it("reports unavailable when the receipt stream itself is unreadable", () => {
		writeRuns(["{not json"]);
		const sandbox = sandboxValidatedEvidence(readSimplificationReceipts(cwd));
		expect(sandbox.availability).toBe("unavailable");
		expect(sandbox.available).toBe(false);
	});
});
