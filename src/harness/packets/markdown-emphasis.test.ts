import { describe, expect, it } from "vitest";
import { droppableMarkers, emphasisPairs } from "./markdown-emphasis.js";

/** The characters a fold may drop, as a string of the dropped chars in order (easy to read in a failure). */
const dropped = (text: string) => {
	const mask = droppableMarkers(text);
	return [...text].filter((_, i) => mask[i] === 1).join("");
};

describe("emphasis markers that are presentation (droppable)", () => {
	it("P1: matched **bold**, __multi-word bold__, *em*, _multi-word em_ and ***both*** around words", () => {
		for (const text of ["**Prefer** it", "__Never push__ again.", "*always* do", "_rarely ever_ do", "***both*** here"]) expect(dropped(text).length).toBeGreaterThan(0);
		expect(dropped("**Prefer `rg`** over")).toBe("****");
	});
	it("P2: a closer may be followed by sentence punctuation, an opener preceded by an open bracket or quote", () => {
		expect(dropped("**Never push**.")).toBe("****");
		expect(dropped("(**always**)")).toBe("****");
		expect(dropped('"_quoted words_" here')).toBe("__");
	});
	it("P3: a pair may span a line break inside one paragraph", () => {
		expect(dropped("**Prefer `rg` over\n  `grep`** always")).toBe("****");
	});
});

describe("markers that are content (never dropped) — audit D, M1", () => {
	it.each([
		["identifier underscores", "Use snake_case names."],
		["dunder", "Never edit __init__.py files."],
		["leading underscore", "Do not call _private helpers."],
		["trailing underscore", "Name it value_ here."],
		["double inside a word", "a__b stays"],
		["glob", "Match *.ts files."],
		["recursive glob", "Read docs/**/*.md first."],
		["URL path", "Serve /_next/ assets."],
		["arithmetic", "It is 2 * 3 here."],
		["escaped", "Use \\*literal\\* stars."],
		["unpaired opener", "**Never alone"],
		["one-word underscore pair (a dunder before a space)", "Use __init__ here."],
		["one-word underscore pair (bold-looking)", "__Never__ push."],
	])("N: %s — %s", (_name, text) => {
		expect(dropped(text)).toBe("");
	});
	it("N: nothing inside a code span (any backtick run length) or a fenced block (``` / ```` / ~~~) is dropped", () => {
		expect(dropped("Use `**x**` here.")).toBe("");
		expect(dropped("Use ``a ` **b** `` here.")).toBe("");
		for (const fence of ["```", "````", "~~~"]) expect(dropped(`${fence}\n**x** _y_\n${fence}\nafter`)).toBe("");
	});
	it("N: emphasis never pairs across a paragraph break", () => {
		expect(dropped("**open here\n\nclose there** x")).toBe("");
	});
});

describe("emphasisPairs", () => {
	it("P4: reports the opener and closer offsets of each pair", () => {
		const text = "- **Prefer** and __Never ever__ x";
		expect(emphasisPairs(text)).toEqual([
			{ open: 2, close: 10, length: 2 },
			{ open: 17, close: 29, length: 2 },
		]);
	});
});

describe("code and block boundaries the first matcher missed (break R5)", () => {
	it("P (R5 #2): a code span that wraps a line is code — its `*` is never a droppable marker", () => {
		expect(emphasisPairs("Never run `rg -g *.ts\nsrc* bar` by hand when you work here.\n")).toEqual([]);
	});
	it("P (R5 #3): a fence inside a blockquote, or indented under a nested list item, is code", () => {
		expect(emphasisPairs("> ```\n> rm *a b* now\n> ```\n")).toEqual([]);
		expect(emphasisPairs("- item\n  - nested\n\n        ```\n        rm *a b* now\n        ```\n")).toEqual([]);
	});
	it("P (R5 #8): emphasis never pairs across two list items", () => {
		expect(emphasisPairs("- Never *force\n- push* to main\n")).toEqual([]);
		expect(emphasisPairs("1. Never *force\n2. push* to main\n")).toEqual([]);
	});
	it("N: emphasis inside one list item across a wrapped line still pairs", () => {
		expect(emphasisPairs("- Never **force\n  push** to main\n")).toEqual([{ open: 8, close: 22, length: 2 }]);
	});
});

describe("indented code blocks and unequal runs (R6 F1: P3 A4/A6)", () => {
	it("A4: an indented (4 spaces or a tab) code block after a blank line, a heading or at the start is code", () => {
		expect(emphasisPairs("Intro.\n\n    rm *a b* now\n")).toEqual([]);
		expect(emphasisPairs("Intro.\n\n\trm *a b* now\n")).toEqual([]);
		expect(emphasisPairs("    rm *a b* now\n")).toEqual([]);
		expect(emphasisPairs("# Title\n    rm *a b* now\n")).toEqual([]);
		expect(emphasisPairs("Intro.\n\n    one\n\n    rm *a b* now\n")).toEqual([]);
	});
	it("A4: an indented line that continues a paragraph is prose, and the block ends at a less-indented line", () => {
		expect(emphasisPairs("Never **force\n    push** to main\n")).toEqual([{ open: 6, close: 22, length: 2 }]);
		expect(emphasisPairs("    code\nnow *a b* x\n")).toEqual([{ open: 13, close: 17, length: 1 }]);
	});
	it("A4: in a list, a paragraph indented to the item's content is prose; 4 columns past it is code", () => {
		expect(emphasisPairs("- item\n\n  more *a b* x\n")).toEqual([{ open: 15, close: 19, length: 1 }]);
		expect(emphasisPairs("1.  item\n\n    more *a b* x\n")).toEqual([{ open: 19, close: 23, length: 1 }]);
		expect(emphasisPairs("- item\n\n      rm *a b* now\n")).toEqual([]);
		expect(emphasisPairs("- item\n\nTop.\n\n    rm *a b* now\n")).toEqual([]);
	});
	it("A6: unequal runs pair the exact-length run and leave the lone marker literal", () => {
		expect(dropped("**a *b**")).toBe("****");
		expect(emphasisPairs("**a *b**")).toEqual([{ open: 0, close: 6, length: 2 }]);
	});
	it("A6: without an exact-length opener, runs pair partially (inner characters first)", () => {
		expect(emphasisPairs("***a** b*")).toEqual([
			{ open: 0, close: 8, length: 1 },
			{ open: 1, close: 4, length: 2 },
		]);
		expect(emphasisPairs("**a* b")).toEqual([{ open: 1, close: 3, length: 1 }]);
		expect(emphasisPairs("*a **b***")).toEqual([
			{ open: 0, close: 8, length: 1 },
			{ open: 3, close: 6, length: 2 },
		]);
	});
	it("A6: the rule of 3 keeps a run that can both open and close from pairing with a run whose summed length is a multiple of 3", () => {
		expect(emphasisPairs("*a (**) b*")).toEqual([{ open: 0, close: 9, length: 1 }]);
	});
});
