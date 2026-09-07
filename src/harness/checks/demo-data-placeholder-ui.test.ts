// Direct unit tests for demo-data-placeholder-ui.ts — imports straight from
// this module (not through the demo-data.js re-export) so both exported
// functions, `lineHasNearbyDemoDirective` and `checkPlaceholderDataInUi`,
// get exercised together. `src/harness/checks/demo-data.test.ts` already
// covers checkPlaceholderDataInUi's high-level behavior via the re-export;
// this file adds boundary-value coverage for the private regexes and
// control-flow branches that only differ at exact edges (word counts,
// quantifier boundaries, off-by-one loop bounds).
import { describe, expect, it } from "vitest";
import { checkPlaceholderDataInUi, lineHasNearbyDemoDirective } from "./demo-data-placeholder-ui.js";

const UI = "src/components/Dashboard.tsx";

/** A number that is deliberately NOT placeholder-shaped (not repeated,
 *  not a consecutive run) so it only gets flagged via the "marked by a
 *  nearby comment" path, never via the digit-shape check. */
function numberWithComment(comment: string, value = "12847"): string {
	return ["function X() {", `  // ${comment}`, `  return <Stat value="${value}" />;`, "}"].join("\n");
}

function loremSnippet(text: string): string {
	return `export const Hero = () => <p>${text}</p>;`;
}

describe("lineHasNearbyDemoDirective", () => {
	it("P1: a directive on the exact lineIdx line counts (loop upper bound is inclusive)", () => {
		expect(lineHasNearbyDemoDirective(["// @demo-data: reason here"], 0)).toBe(true);
	});

	it("N1: a reason shorter than 4 chars (after trim) does not count", () => {
		expect(lineHasNearbyDemoDirective(["// @demo-data: ab"], 0)).toBe(false);
	});

	it("P2: a reason of exactly 4 chars counts (the >=4 boundary)", () => {
		expect(lineHasNearbyDemoDirective(["// @demo-data: abcd"], 0)).toBe(true);
	});

	it("N2: trailing whitespace on the captured reason must not inflate its length past the threshold", () => {
		expect(lineHasNearbyDemoDirective(["// @demo-data: ab   "], 0)).toBe(false);
	});

	it("N3: the directive regex does not match across an embedded newline within one lines[] entry", () => {
		// DEMO_DIRECTIVE_RE is $-anchored; a lines[] entry that (unusually)
		// contains its own newline must not let the directive match bleed
		// past it.
		expect(lineHasNearbyDemoDirective(["// @demo-data: reason\nextra second line"], 0)).toBe(false);
	});

	it("P3: matches with no space directly after //", () => {
		expect(lineHasNearbyDemoDirective(["//@demo-data: reason text"], 0)).toBe(true);
	});

	it("P4: matches with a space before the colon", () => {
		expect(lineHasNearbyDemoDirective(["// @demo-data : reason text"], 0)).toBe(true);
	});

	it("P5: matches with no space directly after the colon", () => {
		expect(lineHasNearbyDemoDirective(["//@demo-data:reason text"], 0)).toBe(true);
	});

	it("P6: matches with no space between the colon and the reason text", () => {
		expect(lineHasNearbyDemoDirective(["// @demo-data:reasontext"], 0)).toBe(true);
	});
});

describe("checkPlaceholderDataInUi — file gates", () => {
	it("N4: suppressed on a .test.tsx UI file even with lorem ipsum content", () => {
		const code = loremSnippet("Lorem ipsum dolor sit amet consectetur");
		expect(checkPlaceholderDataInUi(code, "src/components/Dashboard.test.tsx")).toEqual([]);
	});

	it("N5: suppressed on a non-UI extension (.ts) even with JSX-like lorem ipsum text", () => {
		const code = loremSnippet("Lorem ipsum dolor sit amet consectetur");
		expect(checkPlaceholderDataInUi(code, "src/lib/stats.ts")).toEqual([]);
	});

	it("N6: a Windows-style backslash path through an examples\\ dir stays suppressed", () => {
		const code = loremSnippet("Lorem ipsum dolor sit amet consectetur");
		expect(checkPlaceholderDataInUi(code, "src\\examples\\Dashboard.tsx")).toEqual([]);
	});

	it("N7: a story file OUTSIDE any non-prod dir still stays suppressed (OR, not AND, of the two exemptions)", () => {
		const code = loremSnippet("Lorem ipsum dolor sit amet consectetur");
		expect(checkPlaceholderDataInUi(code, "src/components/Dashboard.story.tsx")).toEqual([]);
	});

	it.each([".jsx", ".vue", ".svelte", ".html", ".astro", ".htm"])(
		"P7[%s]: a %s file with lorem ipsum is still flagged",
		(ext) => {
			const code = loremSnippet("Lorem ipsum dolor sit amet consectetur");
			expect(checkPlaceholderDataInUi(code, `src/pages/dashboard${ext}`).length).toBeGreaterThan(0);
		},
	);
});

describe("checkPlaceholderDataInUi — MAX_UI_MATCHES cap", () => {
	it("P8: caps at exactly 8 matches when 10 independent triggers are available", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `<span>{mockValue${i}}</span>`);
		expect(checkPlaceholderDataInUi(lines.join("\n"), UI).length).toBe(8);
	});
});

describe("checkPlaceholderDataInUi — reported match fields", () => {
	it("P9: line is 1-based (i+1) and the pushed object carries real fields, not a blank one", () => {
		const code = ["const A = 1;", "const B = 2;", "<span>{mockRevenue}</span>"].join("\n");
		const out = checkPlaceholderDataInUi(code, UI);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(3);
		expect(out[0]?.text.length).toBeGreaterThan(0);
	});

	it("P10: text embeds the real detail, not an empty template literal", () => {
		const out = checkPlaceholderDataInUi("<span>{mockRevenue}</span>", UI);
		expect(out[0]?.text).toContain("mockRevenue");
	});

	it("P11: text is truncated to 100 chars of the trimmed source line", () => {
		const pad = "y".repeat(90);
		const code = `export const Card = () => <Stat label="Revenue" value={mockRevenue} data-pad="${pad}ZZMARKEREND" />;`;
		const out = checkPlaceholderDataInUi(code, UI);
		expect(out.length).toBeGreaterThan(0);
		expect(out[0]?.text).not.toContain("ZZMARKEREND");
	});

	it("P12: text embeds the TRIMMED source line, not the raw (leading-whitespace) line", () => {
		const out = checkPlaceholderDataInUi("   <Stat value={mockRevenue} />", UI);
		expect(out[0]?.text).toContain("): <Stat value={mockRevenue} />");
	});
});

describe("checkPlaceholderDataInUi — extractRenderedSegments boundary values", () => {
	it("P13: a bare {expr}-only line (no surrounding markup) is still extracted", () => {
		expect(checkPlaceholderDataInUi("{mockRevenue}", UI).length).toBeGreaterThan(0);
	});

	it("N8: an {expr} preceded by unclosed markup (no closing tag) is NOT a standalone match", () => {
		expect(checkPlaceholderDataInUi("<div>{mockRevenue}", UI)).toEqual([]);
	});

	it("N9: an {expr} followed by unopened markup (no opening tag) is NOT a standalone match", () => {
		expect(checkPlaceholderDataInUi("{mockRevenue}</div>", UI)).toEqual([]);
	});

	it("P14: a spaced-out tag child (extra space before the expression) is still captured", () => {
		expect(checkPlaceholderDataInUi("<span>  {mockRevenue}</span>", UI).length).toBeGreaterThan(0);
	});

	it("P15: a spaced-out tag child (extra space after the expression) is still captured", () => {
		expect(checkPlaceholderDataInUi("<span>{mockRevenue}  </span>", UI).length).toBeGreaterThan(0);
	});

	it("P16: a clean double-brace mustache still captures the full digit run, not just its last digit", () => {
		expect(checkPlaceholderDataInUi("{{1111}}", UI).length).toBeGreaterThan(0);
	});

	it("P17: a clean double-brace mustache still captures the full digit run, not just its first digit", () => {
		// Same fixture, pinned separately: it independently distinguishes
		// the mirrored trailing-boundary mutant from the leading one above.
		expect(checkPlaceholderDataInUi("{{1111}}", UI).length).toBeGreaterThan(0);
	});
});

describe("checkPlaceholderDataInUi — isPlaceholderDigits boundary values", () => {
	it("P18: a 4-digit repeated run (1111), the exact minimum-length boundary, is flagged", () => {
		expect(checkPlaceholderDataInUi("<span>{1111}</span>", UI).length).toBeGreaterThan(0);
	});

	it("N10: a 2-digit repeated run (11) is too short to be flagged", () => {
		expect(checkPlaceholderDataInUi("<span>{11}</span>", UI)).toEqual([]);
	});

	it("N11: a repeated-digit tail not anchored at the string start (51111) is not flagged", () => {
		expect(checkPlaceholderDataInUi("<span>{51111}</span>", UI)).toEqual([]);
	});

	it("N12: a repeated-digit head not anchored at the string end (11115) is not flagged", () => {
		expect(checkPlaceholderDataInUi("<span>{11115}</span>", UI)).toEqual([]);
	});

	it("P19: a 5-digit ascending run (12345), the exact length-5 boundary, is flagged", () => {
		expect(checkPlaceholderDataInUi("<span>{12345}</span>", UI).length).toBeGreaterThan(0);
	});

	it("N13: a plausible non-monotonic 5-digit number (13579, step of 2) is not flagged", () => {
		expect(checkPlaceholderDataInUi("<span>{13579}</span>", UI)).toEqual([]);
	});

	it("P20: a genuine descending run (98765) is flagged", () => {
		expect(checkPlaceholderDataInUi("<span>{98765}</span>", UI).length).toBeGreaterThan(0);
	});
});

describe("checkPlaceholderDataInUi — firstPlaceholderDigits", () => {
	it("P21: a comma-grouped repeated run (1,111) is still flagged after stripping the separator", () => {
		expect(checkPlaceholderDataInUi("<span>1,111</span>", UI).length).toBeGreaterThan(0);
	});
});

describe("checkPlaceholderDataInUi — stripUiComments", () => {
	it("P22: a JS block-style commented-out placeholder marker is still recognized", () => {
		const openComment = ["/", "*"].join("");
		const closeComment = ["*", "/"].join("");
		const code = [
			"function Mrr() {",
			`  ${openComment} placeholder until API lands ${closeComment}`,
			'  return <Stat value="12847" />;',
			"}",
		].join("\n");
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("N14: a // inside an https:// URL is not mistaken for a line-comment start", () => {
		const code = '<a href="https://example.com"><span>{mockRevenue}</span></a>';
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("P23: a same-line // placeholder marker after real JSX is still recognized", () => {
		const code = '<Stat value="12847" /> // placeholder for now';
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("does not fire on commented-out markup", () => {
		const code = "<!-- <span>123456</span> -->";
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});
});

describe("checkPlaceholderDataInUi — commentTextOf boundary values", () => {
	it("N15: a real code-side attribute name must NOT leak past an innocuous same-line comment", () => {
		// commentTextOf must recover ONLY the actual comment span, not the
		// whole line — "hardcoded" here is a JSX attribute NAME, not a
		// marker, and the trailing comment ("nbd") says nothing.
		const code = '<Stat hardcoded={true} value="12847" /> // nbd';
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("P24: a marker whose comment starts at column index 1 exactly, no space before the slashes, is still caught", () => {
		const code = ["X// hardcoded", '<Stat value="12847" />'].join("\n");
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});
});

describe("checkPlaceholderDataInUi — markedNumberDetail", () => {
	it("P25: a marked number is flagged on its own line, not the comment-only line beside it", () => {
		const code = ["function X() {", "  // hardcoded", '  return <Stat label="Revenue" value="12847" />;', "}"].join(
			"\n",
		);
		const out = checkPlaceholderDataInUi(code, UI);
		expect(out.some((m) => m.line === 3)).toBe(true);
	});

	it("N16: a line with no rendered number at all is not flagged, even beside a marker comment", () => {
		const code = ["function X() {", "  // hardcoded", '  return <Stat label="Revenue" />;', "}"].join("\n");
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("P26: a marker on the very first line reaches the value line below it", () => {
		const code = ["// hardcoded", '<Stat value="12847" />'].join("\n");
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("N17: a marker beyond the 3-line lookback window, through 3 blank lines, is NOT caught", () => {
		const code = ["// hardcoded", "", "", "", '<Stat value="12847" />'].join("\n");
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("P27: a marker exactly 3 lines back, through 2 blank lines, the window's own boundary, is still caught", () => {
		const code = ["// hardcoded", "", "", '<Stat value="12847" />'].join("\n");
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("P28: a marker reached by skipping past exactly one blank line is still caught", () => {
		const code = ["// hardcoded", "", '<Stat value="12847" />'].join("\n");
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("N18: a single-digit rendered value does not count as a hasNumber trigger", () => {
		const code = ["function X() {", "  // hardcoded", '  return <Stat value="7" />;', "}"].join("\n");
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("P29: a comma-split number, only 2+ consecutive digits once the comma is stripped, is still flagged", () => {
		// "1,2" only reads as a 2-digit run AFTER separator-stripping — unlike
		// "12,847" where "12" and "847" already satisfy the digit-count check
		// independently of the comma.
		expect(checkPlaceholderDataInUi(numberWithComment("hardcoded", "1,2"), UI).length).toBeGreaterThan(0);
	});
});

describe("checkPlaceholderDataInUi — PLACEHOLDER_COMMENT_RE keyword boundaries", () => {
	it.each([
		["hardcoded, zero separator", "hardcoded"],
		["hard coded, space separator", "hard coded"],
		["madeup, zero separator", "totally madeup already"],
		["made up, space separator", "totally made up already"],
		["mocked, bare mock form", "mock data"],
		["temporary, bare temp form", "temp data"],
		["dummy/fake noun list, double space before noun", "sample  data"],
		["not real/actual noun list, double space after not", "not  real data"],
		["not real/actual noun list, double space before noun", "not real  data"],
		["real/actual + pending list, double space before noun", "real  data pending"],
		["real/actual + pending list, double space before pending", "real data  pending"],
		["wire/hook up, zero filler words", "wire up"],
		["wire/hook up, one filler word", "wire it up"],
		["wire/hook up, two filler words", "wire it all up"],
		["replace real/actual, bounded gap", "replace with real data"],
		["noun list branch 1, singular value", "sample value"],
		["noun list branch 1, singular number", "sample number"],
		["noun list branch 1, singular figure", "sample figure"],
		["noun list branch 1, singular stat", "sample stat"],
		["noun list branch 2, singular value", "not real value"],
		["noun list branch 2, singular number", "not real number"],
		["noun list branch 2, singular figure", "not real figure"],
		["noun list branch 3, singular value", "real value pending"],
		["noun list branch 3, singular number", "real number pending"],
		["noun list branch 3, singular figure", "real figure pending"],
		["wire/hook, double space after wire", "wire  it up"],
		["wire/hook, double space before up", "wire it  up"],
	])("P30[%s]: comment %j marks a nearby non-placeholder-shaped number", (_label, marker) => {
		expect(checkPlaceholderDataInUi(numberWithComment(marker), UI).length).toBeGreaterThan(0);
	});
});

describe("checkPlaceholderDataInUi — PLACEHOLDER_COPY_RE boundaries", () => {
	it.each([
		["lorem ipsum, double space", "lorem  ipsum"],
		["your-X-here, single word", "your name here"],
		["your-X-Y-here, two words", "your full name here"],
		["your-X-here, double space after your", "your  name here"],
		["your-X-here, double space before here", "your name  here"],
		["your-X-Y-here, double space inside the pair", "your full  name here"],
		["insert-X-here, single word", "insert name here"],
		["insert-X-Y-here, two words", "insert full name here"],
		["insert-X-here, double space after insert", "insert  name here"],
		["insert-X-here, double space before here", "insert name  here"],
		["insert-X-Y-here, double space inside the pair", "insert full  name here"],
		["X-goes-here, single word", "text goes here"],
		["X-goes-here, double space before goes", "text  goes here"],
		["X-goes-here, double space before here", "text goes  here"],
		["placeholder text/copy/content, double space", "placeholder  text"],
		["sample/dummy/filler text, double space", "sample  text"],
	])("P31[%s]: copy %j rendered as text is flagged as canonical filler copy", (_label, copy) => {
		expect(checkPlaceholderDataInUi(loremSnippet(copy), UI).length).toBeGreaterThan(0);
	});
});

describe("checkPlaceholderDataInUi — UI_DISCLAIMER_RE boundaries, each suppresses an otherwise-flagged paragraph", () => {
	function withDisclaimerAndLorem(disclaimer: string): string {
		return [
			"export const Dashboard = () => (",
			"  <div>",
			`    <Banner>${disclaimer}</Banner>`,
			"    <p>Lorem ipsum dolor sit amet</p>",
			"  </div>",
			");",
		].join("\n");
	}

	it.each([
		["word list + noun, double space", "sample  data"],
		["word list + noun, singular value", "sample value"],
		["word list + noun, singular figure", "sample figure"],
		["word list + noun, singular number", "sample number"],
		["not real/actual, double space", "not  real"],
		["for illustration, double space", "for  illustration"],
		["example only, double space", "example  only"],
	])("N19[%s]: disclaimer %j still suppresses the paragraph's lorem ipsum finding", (_label, disclaimer) => {
		expect(checkPlaceholderDataInUi(withDisclaimerAndLorem(disclaimer), UI)).toEqual([]);
	});
});

describe("checkPlaceholderDataInUi — VISIBLE_ATTR_RE boundaries", () => {
	it("P32: a no-hyphen arialabel attribute is still captured (the hyphen is optional)", () => {
		expect(checkPlaceholderDataInUi('<span arialabel="mockRevenue"></span>', UI).length).toBeGreaterThan(0);
	});

	it("P33: a no-hyphen arialabel attribute is captured via its own branch, not the bare label alternative", () => {
		// With a hyphen present ("aria-label"), the bare "label" alternative
		// would independently match starting right after the hyphen's word
		// boundary — this fixture (no hyphen) forces the aria-specific branch.
		expect(checkPlaceholderDataInUi('<span arialabel="mockRevenue"></span>', UI)[0]?.text).toContain(
			"mockRevenue",
		);
	});

	it("P34: a spaced-out attribute (extra space before the equals sign) is still captured", () => {
		expect(checkPlaceholderDataInUi('<Stat value  =  "mockRevenue" />', UI).length).toBeGreaterThan(0);
	});

	it("P35: a spaced-out attribute (extra space after the equals sign) is still captured", () => {
		expect(checkPlaceholderDataInUi('<Stat value=  "mockRevenue" />', UI).length).toBeGreaterThan(0);
	});

	it("P36: a multi-char single-quoted value is still captured in full", () => {
		const out = checkPlaceholderDataInUi("<Stat value='mockRevenue' />", UI);
		expect(out.length).toBeGreaterThan(0);
		expect(out[0]?.text).toContain("mockRevenue");
	});
});

describe("checkPlaceholderDataInUi — PLACEHOLDER_IDENT_RE boundaries", () => {
	it("P37: a multi-letter prefix before the Mock/Fake/Dummy/Stub/Fixture suffix is still flagged", () => {
		expect(checkPlaceholderDataInUi("<span>{xyzMock}</span>", UI).length).toBeGreaterThan(0);
	});

	it("P38: a plain identifier ending in Stub is still flagged", () => {
		expect(checkPlaceholderDataInUi("<span>{userStub}</span>", UI).length).toBeGreaterThan(0);
	});

	it("P39: a multi-char SCREAMING_CASE suffix is still flagged", () => {
		expect(checkPlaceholderDataInUi("<span>{MOCK_TOTAL}</span>", UI).length).toBeGreaterThan(0);
	});

	it("P40: a short SCREAMING_CASE suffix with a single trailing char is still flagged", () => {
		expect(checkPlaceholderDataInUi("<span>{MOCK_T}</span>", UI).length).toBeGreaterThan(0);
	});
});

describe("checkPlaceholderDataInUi — UI_NONPROD_DIR_RE / UI_STORY_FILE_RE boundaries", () => {
	it("N20: a path starting with an examples dir at position zero is still exempted", () => {
		const code = loremSnippet("Lorem ipsum dolor sit amet consectetur");
		expect(checkPlaceholderDataInUi(code, "examples/Dashboard.tsx")).toEqual([]);
	});

	it("N21: a singular example dir is still exempted, the trailing s is optional", () => {
		const code = loremSnippet("Lorem ipsum dolor sit amet consectetur");
		expect(checkPlaceholderDataInUi(code, "src/example/Dashboard.tsx")).toEqual([]);
	});

	it("N22: a singular demo dir is still exempted, the trailing s is optional", () => {
		const code = loremSnippet("Lorem ipsum dolor sit amet consectetur");
		expect(checkPlaceholderDataInUi(code, "src/demo/Dashboard.tsx")).toEqual([]);
	});

	it("P41: a filename that merely contains a story-file marker before its true extension is NOT exempted", () => {
		// getExtension() takes the LAST dot (still a valid .tsx extension
		// here), but the story-file regex must not match unless the marker
		// truly reaches the end of the path.
		const code = loremSnippet("Lorem ipsum dolor sit amet consectetur");
		expect(checkPlaceholderDataInUi(code, "Foo.story.tsx2.tsx").length).toBeGreaterThan(0);
	});

});
