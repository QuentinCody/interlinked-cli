import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../../harness/checks/api-surface.js";
import * as jsdoc from "../../harness/checks/jsdoc-param-drift.js";
import * as boundary from "../../harness/checks/unvalidated-input-boundary.js";
import * as numeric from "../../harness/checks/numeric-zero-default.js";
import { runApiBoundaryChecks } from "./file-checks-api-boundary.js";
import { runNumericZeroDefaultCheck } from "./file-checks-numeric-zero.js";
import { emptyResults } from "./tool-results-types.js";

afterEach(() => { vi.restoreAllMocks(); });
const cases = [
	{ bucket: "publicApiLeaksInternalType", check: "public_api_leaks_internal_type", mock: () => vi.spyOn(api, "checkPublicApiLeaksInternalType"), run: runApiBoundaryChecks },
	{ bucket: "jsdocParamDrift", check: "jsdoc_param_drift", mock: () => vi.spyOn(jsdoc, "detectJsdocParamDrift"), run: runApiBoundaryChecks },
	{ bucket: "unvalidatedInputBoundary", check: "unvalidated_input_boundary", mock: () => vi.spyOn(boundary, "detectUnvalidatedInputBoundary"), run: runApiBoundaryChecks },
	{ bucket: "numericZeroDefault", check: "numeric_zero_default", mock: () => vi.spyOn(numeric, "detectNumericZeroDefault"), run: runNumericZeroDefaultCheck },
] as const;
describe.each(cases)("complete $check collector", entry => {
	it("P1 safely appends a population beyond the JavaScript call-argument ceiling", () => {
		entry.mock().mockReturnValue(Array.from({ length: 150_001 }, (_, index) => ({ line: index + 1, text: "retained collection control" })));
		const results = emptyResults();
		entry.run({ content: "/**\n * @param previous old argument\n */\nexport function documented(current: string) { return current; }",
			file: join(process.cwd(), "scratch", "capacity-service.ts"), relPath: "capacity-service.ts", cwd: process.cwd(), r: results, piiOpts: {} });
		expect(results[entry.bucket]).toHaveLength(150_001);
		expect(results[entry.bucket].at(-1)).toMatchObject({ check: entry.check, line: 150_001 });
	});
});
