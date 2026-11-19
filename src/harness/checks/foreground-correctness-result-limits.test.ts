import { describe, expect, it } from "vitest";
import { checkNanComparison, checkUnsafeOptionalChaining } from "./agent-safety-js-correctness.js";
import { checkAsyncPromiseExecutor } from "./agent-safety-async.js";
import { checkTlsVerifyDisabled } from "./agent-safety-crypto.js";
import { scanBrokenOptionalGrouping } from "./optional-chain-boundaries.js";
import { scanLinesStripped } from "./shared-text-utils.js";
import { withForegroundCheckScan } from "./check-scan-policy.js";

const cases = [
	{ id: "nan_comparison", detector: checkNanComparison,
		source: (index: number) => `if (value${index} === NaN) recover();`,
		safe: "if (Number.isNaN(value)) recover();" },
	{ id: "async_promise_executor", detector: checkAsyncPromiseExecutor,
		source: (index: number) => `const promise${index} = new Promise(async (resolve) => { resolve(1); });`,
		safe: "const promise = new Promise((resolve) => { resolve(1); });" },
	{ id: "unsafe_optional_chaining", detector: checkUnsafeOptionalChaining,
		source: (index: number) => `const value${index} = (record?.field).name;`,
		safe: "const value = (record?.field ?? fallback).name;" },
	{ id: "ubs_tls_verify_disabled", detector: checkTlsVerifyDisabled,
		source: (index: number) => `const request${index} = { rejectUnauthorized: false };`,
		safe: "const server = { rejectUnauthorized: false, requestCert: true };" },
] as const;

describe.each(cases)("$id complete foreground result collection", entry => {
	it("P1 retains twenty observations and their exact tail while runtime remains bounded", () => {
		const content = Array.from({ length: 20 }, (_, index) => entry.source(index)).join("\n");
		const runtime = entry.detector(content, "src/selection.ts");
		expect(runtime).toHaveLength(10);
		const foreground = withForegroundCheckScan(() => entry.detector(content, "src/selection.ts"));
		expect(foreground.map(match => match.line)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
		expect(foreground.slice(0, 10)).toEqual(runtime);
		expect(entry.detector(content, "src/selection.ts")).toEqual(runtime);
	});

	it("N1 preserves the recognized legitimate exception in both contexts", () => {
		expect(entry.detector(entry.safe, "src/selection.ts")).toEqual([]);
		expect(withForegroundCheckScan(() => entry.detector(entry.safe, "src/selection.ts"))).toEqual([]);
	});

	it("N2 preserves non-code applicability in foreground scans", () => {
		expect(withForegroundCheckScan(() => entry.detector(entry.source(0), "docs/selection.md"))).toEqual([]);
	});
});

it("keeps unrelated stripped-line helper consumers at their explicit runtime limit", () => {
	const lines = Array.from({ length: 20 }, () => "recognized");
	expect(withForegroundCheckScan(() => scanLinesStripped(lines, lines, /recognized/, 4))).toHaveLength(4);
});

it("keeps optional-grouping helper defaults bounded and honors explicit caller limits", () => {
	const content = Array.from({ length: 20 }, (_, index) => `const value${index} = (record?.field).name;`).join("\n");
	expect(scanBrokenOptionalGrouping(content, "src/selection.ts")).toHaveLength(10);
	expect(withForegroundCheckScan(() => scanBrokenOptionalGrouping(content, "src/selection.ts"))).toHaveLength(10);
	expect(scanBrokenOptionalGrouping(content, "src/selection.ts", 3)).toHaveLength(3);
	expect(scanBrokenOptionalGrouping(content, "src/selection.ts", Number.POSITIVE_INFINITY)).toHaveLength(20);
});
