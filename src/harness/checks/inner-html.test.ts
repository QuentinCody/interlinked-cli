import { describe, expect, it } from "vitest";
import { checkInnerHtmlUsage } from "./inner-html.js";

// Companion for the extracted `inner_html` module. The full case set (the
// original positives/negatives) stays in agent-safety-js-correctness.test.ts,
// which imports through the re-export; the 2026-10-21 adversarial negatives
// live in __tests__/adversarial/inner_html.adversarial.test.ts.

describe("checkInnerHtmlUsage — positive (must fire)", () => {
	it("P1: fires on a direct assignment of a variable", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = userHtml;\n", "src/x.ts")).toEqual([
			{ line: 1, text: "el.innerHTML = userHtml;" },
		]);
	});

	it("P2: fires on a raw React __html value", () => {
		expect(checkInnerHtmlUsage("<div dangerouslySetInnerHTML={{ __html: md }} />\n", "src/x.tsx")).toHaveLength(1);
	});
});

describe("checkInnerHtmlUsage — negative (must not fire)", () => {
	it("N1: a strict-equality comparison reads the sink, never writes it", () => {
		expect(checkInnerHtmlUsage('if (el.innerHTML === "") return;\n', "src/x.ts")).toEqual([]);
	});

	it("N2: a sanitizer-wrapped value follows the fix instruction", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = DOMPurify.sanitize(html);\n", "src/x.ts")).toEqual([]);
	});
});
