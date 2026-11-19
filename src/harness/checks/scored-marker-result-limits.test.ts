import { describe, expect, it } from "vitest";
import { checkMatchLimit, withForegroundCheckScan } from "./check-scan-policy.js";
import { checkFocusedTests } from "./focused-tests.js";
import { checkDisabledTests } from "./js-ts-general.js";
import { countSkippedTests, findSkipMarkers } from "./test-skip-markers.js";

describe.each([
	{ name: "focused tests", detect: checkFocusedTests, source: (i: number) => `it.only("case ${i}", () => { expect(actual).toBe(expected); });`, safe: 'it("case", () => { expect(actual).toBe(expected); });' },
	{ name: "disabled tests", detect: checkDisabledTests, source: (i: number) => `it.skip("case ${i}", () => {});`, safe: 'test.skip(condition, "optional platform");' },
])("$name result policy", ({ detect, source, safe }) => {
	it("P1: retains twenty foreground markers and their final source line while runtime remains fifteen", () => {
		const content = Array.from({ length: 20 }, (_, index) => source(index)).join("\n");
		const runtime = detect(content, "/project/src/marker.test.ts");
		expect(runtime).toHaveLength(15);
		const foreground = withForegroundCheckScan(() => detect(content, "/project/src/marker.test.ts"));
		expect(foreground).toHaveLength(20);
		expect(foreground.slice(0, 15)).toEqual(runtime);
		expect(foreground.at(-1)?.line).toBe(20);
		expect(detect(content, "/project/src/marker.test.ts")).toEqual(runtime);
	});
	it("N1: preserves legitimate source and product-source applicability", () => {
		expect(withForegroundCheckScan(() => detect(safe, "/project/src/marker.test.ts"))).toEqual([]);
		expect(withForegroundCheckScan(() => detect(Array.from({ length: 20 }, (_, index) => source(index)).join("\n"), "/project/src/marker.ts"))).toEqual([]);
	});
});

it.each([
	{ file: "marker.test.ts", source: (i: number) => `it.skip("case ${i}", () => {});` },
	{ file: "test_marker.py", source: (i: number) => `@pytest.mark.skip\ndef test_case_${i}():\n    pass` },
	{ file: "marker_test.go", source: (i: number) => `func TestCase${i}(t *testing.T) {\n t.Skip("later")\n}` },
	{ file: "lib.rs", source: (i: number) => `#[test]\n#[ignore]\nfn case_${i}() {}` },
])("retains the shared marker/count contract for $file with no leaked foreground context", ({ file, source }) => {
	const content = Array.from({ length: 20 }, (_, index) => source(index)).join("\n");
	expect(findSkipMarkers(content, file)).toHaveLength(15);
	expect(countSkippedTests(content, file)).toBe(15);
	withForegroundCheckScan(() => {
		// Adopt and water-line counters retain their default contract even when
		// their caller has entered a detector foreground context.
		expect(findSkipMarkers(content, file)).toHaveLength(15);
		expect(countSkippedTests(content, file)).toBe(15);
		expect(findSkipMarkers(content, file, checkMatchLimit(15))).toHaveLength(20);
	});
	expect(findSkipMarkers(content, file)).toHaveLength(15);
	expect(countSkippedTests(content, file)).toBe(15);
});
