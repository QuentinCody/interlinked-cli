import { describe, expect, it } from "vitest";
import {
	extractAnchorLinks,
	extractHeadings,
	extractSectionRefs,
} from "./extract-refs.js";

const noFences = new Set<number>();

describe("heading metadata needs a real separator", () => {
	// Basis: extract-refs.ts:56 "Leading section number in a heading" and
	// HeadingInfo.sectionNumber (types.ts:93) -- "7.3" in "### 7.3 Phantoms".
	it("does not read the digits of '3D printing' as a section number", () => {
		const [h] = extractHeadings(["## 3D printing"], noFences);
		expect(h?.text).toBe("3D printing");
		expect(h?.sectionNumber).toBeUndefined();
	});

	it("still reads a spaced section number", () => {
		const [h] = extractHeadings(["## 7.3 Phantoms"], noFences);
		expect(h?.sectionNumber).toBe("7.3");
	});

	// Basis: types.ts:95 "Appendix letter if the heading is 'Appendix X ...'".
	it("does not read 'Appendix Cats' as appendix C", () => {
		const [h] = extractHeadings(["## Appendix Cats"], noFences);
		expect(h?.appendixLetter).toBeUndefined();
	});

	// Basis: optional fields in HeadingInfo (types.ts:94,96); the extractor
	// omits them with a conditional spread (extract-refs.ts:264-265).
	it("omits the optional metadata keys when a heading has none", () => {
		const [h] = extractHeadings(["## Plain"], noFences);
		expect(h).toBeDefined();
		expect(Object.hasOwn(h ?? {}, "appendixLetter")).toBe(false);
		expect(Object.hasOwn(h ?? {}, "sectionNumber")).toBe(false);
	});
});

describe("setext run boundaries around fenced lines", () => {
	// Basis: extract-refs.ts:127-133 -- a heading starts at a paragraph run's
	// first line; a fenced predecessor is not part of the run.
	it("starts a setext heading right after a fenced line", () => {
		const hs = extractHeadings(["fenced text", "Title", "====="], new Set([1]));
		expect(hs.map((h) => [h.text, h.level, h.line])).toEqual([["Title", 1, 2]]);
	});

	// Basis: extract-refs.ts:215 -- an underline line inside a fence is not
	// an underline.
	it("emits no heading when the underline line itself is fenced", () => {
		expect(extractHeadings(["Title", "---"], new Set([2]))).toEqual([]);
	});
});

describe("setext text is not paragraph text when it opens another block", () => {
	// Basis: extract-refs.ts:164-171 -- "[foo]: /url\n---" emits no heading.
	it("treats a link reference definition before an underline as no heading", () => {
		expect(extractHeadings(["[foo]: /url", "---"], noFences)).toEqual([]);
	});

	// Basis: extract-refs.ts:181-183 -- a complete standalone tag line is a
	// type-7 HTML block, not setext text.
	it("treats a standalone inline-level tag line before an underline as no heading", () => {
		expect(extractHeadings(["<span>", "---"], noFences)).toEqual([]);
	});

	// Basis: extract-refs.ts:166, 173-175 -- a "<name" opener of a block tag is
	// an HTML block even when text follows the tag.
	it("treats a block tag with trailing text before an underline as no heading", () => {
		expect(extractHeadings(["<div>hello", "---"], noFences)).toEqual([]);
	});
});

describe("folded setext text is bounded", () => {
	// Basis: extract-refs.ts:143-148 -- the folded TEXT is bounded (a cap) so a
	// degenerate fold never hands slugging an unbounded string.
	it("does not keep a 10000-char setext line whole", () => {
		const [h] = extractHeadings(["a".repeat(10_000), "==="], noFences);
		expect(h?.level).toBe(1);
		expect(h?.text.length).toBeLessThan(10_000);
		expect(h?.text.length).toBeGreaterThan(0);
	});
});

describe("repeated heading slugs", () => {
	// Basis: extract-refs.ts:234-237 -- the per-base suffix RESUMES where it
	// last stopped, so N identical headings cost O(N), not O(N^2).
	it("dedups 30000 identical headings in linear time with distinct suffixes", () => {
		const start = Date.now();
		const hs = extractHeadings(Array(30_000).fill("## Setup"), noFences);
		const elapsed = Date.now() - start;
		expect(hs).toHaveLength(30_000);
		expect(hs[0]?.slug).toBe("setup");
		expect(hs[29_999]?.slug).toBe("setup-29999");
		// Generous ceiling: linear takes ~20ms, the quadratic restart ~23s.
		expect(elapsed).toBeLessThan(3000);
	}, 60_000);
});

describe("reference definitions in hidden lines", () => {
	// Basis: extract-refs.ts:229-232 -- a definition in a fenced/comment-hidden
	// line activates nothing, so "[t][ref]" stays literal.
	it("does not honor a link reference definition that sits in a fence", () => {
		const defined = extractHeadings(["# [t][ref]", "[ref]: /u"], noFences);
		const fenced = extractHeadings(
			["# [t][ref]", "```", "[ref]: /u", "```"],
			new Set([2, 3, 4]),
		);
		expect(defined[0]?.slug).toBe("t");
		expect(fenced[0]?.slug).not.toBe(defined[0]?.slug);
	});
});

describe("section refs: word form and link targets", () => {
	// Basis: extract-refs.ts:272 -- the word form is "Section 7.3".
	it("does not read 'Section7' (no separator) as a section reference", () => {
		expect(extractSectionRefs(["See Section7 now"], noFences)).toEqual([]);
		expect(
			extractSectionRefs(["See Section 7 now"], noFences).map((r) => r.ref),
		).toEqual(["7"]);
	});

	// Basis: extract-refs.ts:356-359 -- link targets are blanked
	// "(column-preserving)".
	it("keeps the column of a ref that follows an inline link", () => {
		const line = "[a](http://example.com/x) then §9";
		const [r] = extractSectionRefs([line], noFences);
		expect(r?.ref).toBe("9");
		expect(r?.col).toBe(line.indexOf("§9"));
	});
});

describe("anchor links: schemes and hidden lines", () => {
	// Basis: extract-refs.ts:384-386 -- targets with a scheme are external;
	// URI schemes are case-insensitive (SCHEME_RE carries the i flag).
	it("treats an upper-case scheme as external", () => {
		expect(extractAnchorLinks(["[x](HTTP://example.com/a)"], noFences)).toEqual([]);
		expect(extractAnchorLinks(["[x](MailTo:me@example.com)"], noFences)).toEqual([]);
	});

	// Basis: extract-refs.ts:450-453 -- links in the tail of a one-line HTML
	// comment block are literal text.
	it("ignores a link after a one-line comment block", () => {
		expect(extractAnchorLinks(["<!-- c --> [a](missing.md)"], noFences)).toEqual([]);
		expect(extractAnchorLinks(["[a](missing.md)"], noFences)).toHaveLength(1);
	});

	// Basis: extract-refs.ts:449 -- fenced lines are skipped like hidden blocks.
	it("ignores a link on a fenced line", () => {
		expect(extractAnchorLinks(["[a](missing.md)"], new Set([1]))).toEqual([]);
	});
});
