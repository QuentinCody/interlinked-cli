import { describe, expect, it } from "vitest";
import { checkHtmlDuplicateId } from "./html-duplicate-id.js";

// Census fault: `depth = Math.max(0, depth - 1)` → `depth = depth - 1` survived
// the companion test (docs/reviews/kill-proof-census-harness.md).
describe("checkHtmlDuplicateId — stray closing template", () => {
	// test-contract: bug — an unmatched </template> must not silence the detector for the rest of the body
	it("still reports a duplicate id after a stray </template>", () => {
		const html = '<body>\n</template>\n<div id="x"></div>\n<p id="x"></p>\n</body>';
		expect(checkHtmlDuplicateId(html, "index.html")).toEqual([
			{ line: 4, text: 'Duplicate HTML id "x"; first used on line 3.' },
		]);
	});

	// test-contract: invariant — after a stray close, a real template still hides only its own contents
	it("excludes a later real template's contents but keeps the body after it", () => {
		const html = '<body></template><template><i id="a"></i></template><b id="a"></b><u id="a"></u></body>';
		expect(checkHtmlDuplicateId(html, "page.htm")).toHaveLength(1);
	});
});
