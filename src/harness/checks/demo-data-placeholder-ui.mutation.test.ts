// Mutation-driven hardening tests for demo-data-placeholder-ui.ts (Campaign A).
// Each test pins a behavior that a surviving mutant of the module changed.
import { describe, expect, it } from "vitest";
import { checkPlaceholderDataInUi, lineHasNearbyDemoDirective } from "./demo-data-placeholder-ui.js";

const UI = "src/components/Dashboard.tsx";

describe("lineHasNearbyDemoDirective — lookback window (demo-data.ts:12 documents ~10 lines above)", () => {
	it("a directive exactly 10 lines above the match still counts", () => {
		const lines = ["// @demo-data: seeded sample", ...Array<string>(9).fill("const x = 1;"), "<b>1</b>"];
		expect(lines).toHaveLength(11);
		expect(lineHasNearbyDemoDirective(lines, 10)).toBe(true);
	});
});

describe("checkPlaceholderDataInUi — directive suppression (module header lines 46-47)", () => {
	it("a // @demo-data: directive above a mock-named value suppresses the finding", () => {
		const bare = "<span>{mockRevenue}</span>";
		expect(checkPlaceholderDataInUi(bare, UI)).toHaveLength(1);
		const marked = `// @demo-data: marketing sample\n${bare}`;
		expect(checkPlaceholderDataInUi(marked, UI)).toEqual([]);
	});
});

describe("checkPlaceholderDataInUi — signal D, filler image host (module header line 39)", () => {
	it("flags an image whose src is a filler-image host, with no other signal on the line", () => {
		const out = checkPlaceholderDataInUi('<img src="https://placehold.co/600x400" />', UI);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(1);
		expect(out[0]?.text).toContain("placehold.co");
	});
});

describe("checkPlaceholderDataInUi — signal E thresholds (isPlaceholderDigits doc, lines 117-120)", () => {
	it("a 3-digit repeated number (111) is below the 4+ repeat threshold and is not flagged", () => {
		expect(checkPlaceholderDataInUi("<b>111</b>", UI)).toEqual([]);
	});

	it("a 4-digit consecutive run (1234) is below the length-5 run threshold and is not flagged", () => {
		expect(checkPlaceholderDataInUi("<b>1234</b>", UI)).toEqual([]);
	});

	it("a run that is not consecutive from its first step (13456) is not flagged", () => {
		expect(checkPlaceholderDataInUi("<b>13456</b>", UI)).toEqual([]);
	});
});

describe("checkPlaceholderDataInUi — line comments and URL schemes (stripUiComments doc, lines 142-146)", () => {
	it("a triple-slash file:/// URL scheme is not treated as a line comment, so later copy is still scanned", () => {
		const out = checkPlaceholderDataInUi('<a href="file:///a">lorem ipsum</a>', UI);
		expect(out).toHaveLength(1);
	});
});

describe("checkPlaceholderDataInUi — signal A number detection (digit-separator class, line 136)", () => {
	it("an underscore-separated number counts as a multi-digit number beside a placeholder comment", () => {
		const code = ["// placeholder", '<Stat value="1_5" />'].join("\n");
		expect(checkPlaceholderDataInUi(code, UI)).toHaveLength(1);
	});
});
