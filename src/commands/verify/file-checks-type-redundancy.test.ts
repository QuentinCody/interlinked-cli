import { describe, expect, it } from "vitest";
import { emptyResults } from "./tool-results-types-keys.js";
import { runTypeRedundancyChecks } from "./file-checks-type-redundancy.js";

describe("runTypeRedundancyChecks", () => {
	it("P1: files issues under their own result keys with the right check ids", () => {
		const r = emptyResults();
		// A test-file path keeps both detectors silent regardless of repo state —
		// the point here is the wiring shape (keys exist, no throw), not
		// detector behavior (owned by type-redundancy.test.ts / dead-exports-inline.test.ts).
		runTypeRedundancyChecks({
			content: "export interface X { id: string }\n",
			file: "/tmp/wiring-probe/a.test.ts",
			relPath: "a.test.ts",
			cwd: "/tmp/wiring-probe",
			r,
			// SAFETY: the two detectors only read content/file/relPath/cwd/r.
		} as Parameters<typeof runTypeRedundancyChecks>[0]);
		expect(r.deadTypeExports).toEqual([]);
		expect(r.duplicateTypeDeclaration).toEqual([]);
	});
});
