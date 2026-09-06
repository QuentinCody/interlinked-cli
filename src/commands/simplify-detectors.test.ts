// ===========================================
// Tests: simplify-detectors — local evidence adapters
// ===========================================
// collectDeadCodeEvidence and collectSingleInterfaceEvidence each delegate to
// a collaborator (scanDeadCode, categorizeDeadCode + buildDocsCorpus,
// runVerifyParityChecks) that spawns git and walks the whole repo when run
// for real. Every case here mocks those collaborator MODULES (never
// simplify-detectors.js itself) so a fixture can drive an exact
// DeadCodeReport / CategorizeReport / thrown-error shape — including a
// reported file that does not exist on disk, an adjudicated inert branch, and
// a collaborator failure — without depending on this repo's own current
// dead-code state.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CategorizeReport } from "./deadcode-categorize.js";
import type { DeadCodeReport } from "./deadcode.js";

vi.mock("./deadcode.js", () => ({
	scanDeadCode: vi.fn(),
}));
vi.mock("./deadcode-categorize.js", () => ({
	categorizeDeadCode: vi.fn(),
	buildDocsCorpus: vi.fn(),
}));
vi.mock("../harness/verify-parity.js", () => ({
	runVerifyParityChecks: vi.fn(),
}));

import { buildDocsCorpus, categorizeDeadCode } from "./deadcode-categorize.js";
import { scanDeadCode } from "./deadcode.js";
import { runVerifyParityChecks } from "../harness/verify-parity.js";
import { collectDeadCodeEvidence, collectSingleInterfaceEvidence } from "./simplify-detectors.js";

const mockScanDeadCode = vi.mocked(scanDeadCode);
const mockCategorizeDeadCode = vi.mocked(categorizeDeadCode);
const mockBuildDocsCorpus = vi.mocked(buildDocsCorpus);
const mockRunVerifyParityChecks = vi.mocked(runVerifyParityChecks);

const EMPTY_REPORT: DeadCodeReport = {
	unreachableFiles: [],
	deadImportBindings: [],
	deadExports: [],
	deadTypeExports: [],
	testOnlyImporterFiles: [],
	scannedFiles: 0,
	scannedPaths: [],
};

const EMPTY_CATEGORIES: CategorizeReport = { items: [], inertBranches: [] };

beforeEach(() => {
	vi.clearAllMocks();
	mockCategorizeDeadCode.mockReturnValue(EMPTY_CATEGORIES);
	mockBuildDocsCorpus.mockReturnValue({ mentions: () => false });
});

describe("collectDeadCodeEvidence", () => {
	it("reports a null line (not a thrown error) when the dead-import binding's file cannot be read from disk", () => {
		mockScanDeadCode.mockReturnValue({
			...EMPTY_REPORT,
			deadImportBindings: [{ file: "does-not-exist-on-disk-xyz.ts", binding: "unusedThing" }],
		});

		const result = collectDeadCodeEvidence(process.cwd());

		expect(result.drafts).toHaveLength(1);
		expect(result.drafts[0]?.startLine).toBeNull();
		expect(result.drafts[0]?.endLine).toBeNull();
		expect(result.drafts[0]?.summary).toBe(
			"Imported binding `unusedThing` is not referenced in this file.",
		);
		expect(result.drafts[0]?.source).toBe("deadcode.unused_import_binding");
	});

	it("turns a mutation-adjudicated inert branch into a delete-remedy candidate naming the record count", () => {
		mockScanDeadCode.mockReturnValue(EMPTY_REPORT);
		mockCategorizeDeadCode.mockReturnValue({
			items: [],
			inertBranches: [{ file: "src/example.ts", qualifiedName: "example.helper", records: 3 }],
		});

		const result = collectDeadCodeEvidence(process.cwd());

		expect(result.drafts).toHaveLength(1);
		expect(result.drafts[0]?.remedy).toBe("delete");
		expect(result.drafts[0]?.summary).toBe(
			"Mutation evidence was adjudicated as dead code in `example.helper`.",
		);
		expect(result.drafts[0]?.evidence[0]?.detail).toBe(
			"3 dead-code disposition record(s); no removal patch was validated by this run.",
		);
	});

	it("reports the source as unavailable with the thrown error's message when the scan itself fails", () => {
		mockScanDeadCode.mockImplementation(() => {
			throw new Error("boom-scan");
		});

		const result = collectDeadCodeEvidence(process.cwd());

		expect(result.drafts).toHaveLength(0);
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]?.source).toBe("deadcode.reachability-and-categorization");
		expect(result.sources[0]?.status).toBe("unavailable");
		expect(result.sources[0]?.notes).toEqual(["boom-scan"]);
	});
});

describe("collectSingleInterfaceEvidence", () => {
	it("reports the source as unavailable with the thrown error's message when the parity check fails", () => {
		mockRunVerifyParityChecks.mockImplementation(() => {
			throw new Error("boom-parity");
		});

		const result = collectSingleInterfaceEvidence(process.cwd(), ["a.ts"]);

		expect(result.drafts).toHaveLength(0);
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]?.source).toBe("verify.single_implementation_interface");
		expect(result.sources[0]?.status).toBe("unavailable");
		expect(result.sources[0]?.notes).toEqual(["boom-parity"]);
	});
});
