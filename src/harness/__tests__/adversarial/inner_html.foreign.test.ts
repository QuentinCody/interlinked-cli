// Cross-repo falsification of the `inner_html` pre_block check (2026-10-21,
// scratch/2026-10-21-cross-repo/falsify-result.json: 1 read, 1 confirmed
// false positive, 0 true positives). The negative is the REAL snippet at the
// cited location (date-fns pkgs/core/src/_lib/cdnPolyfill.js, trimmed); the
// positives pin the class, so the fix cannot be a blanket `template` exemption.
//
// Blind spot closed: `innerHTML` on a detached `<template>` element is the
// inert parse-HTML idiom. Template content is an inert DocumentFragment —
// nothing renders, no handler fires — so the write is not a render sink AS
// LONG AS no parsed node leaves the template. The exemption therefore holds
// only when every use of the template is the assignment or a
// `const node = template.content.querySelector(…)` binding, and every use of
// that node is a data read (`node.attributes`, `node.getAttribute(…)`).
// A detached `<div>` is NOT inert (its `<img onerror>` fires while detached).

import { describe, expect, it } from "vitest";
import { checkInnerHtmlUsage } from "../../checks/inner-html.js";

// date-fns pkgs/core/src/_lib/cdnPolyfill.js:25-37 (verbatim).
const DATE_FNS_CDN_POLYFILL = [
	"(function () {",
	"  function insertScriptFromHTML(html) {",
	'    const template = document.createElement("template");',
	"    template.innerHTML = html;",
	"",
	'    const script = template.content.querySelector("script");',
	'    const newScript = document.createElement("script");',
	"",
	"    for (const attr of script.attributes) {",
	"      newScript.setAttribute(attr.name, attr.value);",
	"    }",
	"",
	"    document.head.appendChild(newScript);",
	"  }",
	"})();",
].join("\n");

/** A file whose template is parsed and then used through `tail` lines. */
function templateWith(tail: string[], decl = 'const template = document.createElement("template");'): string {
	return ["export function parse(html: string) {", `\t${decl}`, "\ttemplate.innerHTML = html;", ...tail.map((l) => `\t${l}`), "}"].join(
		"\n",
	);
}

describe("inner_html foreign — negative (must not fire)", () => {
	it("N1: date-fns cdnPolyfill.js — a detached <template> used only as an HTML parser", () => {
		expect(checkInnerHtmlUsage(DATE_FNS_CDN_POLYFILL, "pkgs/core/src/_lib/cdnPolyfill.js")).toEqual([]);
	});

	it("N2: the same idiom in TypeScript with single quotes and getAttribute reads", () => {
		const code = templateWith([
			"const el = template.content.querySelector('meta');",
			"return el?.getAttribute('content') ?? null;",
		], "const template = document.createElement('template');");
		expect(checkInnerHtmlUsage(code, "src/head/parse-meta.ts")).toEqual([]);
	});
});

describe("inner_html foreign — positive (must fire)", () => {
	it("P1: the template's content is appended to the live document", () => {
		const code = templateWith(["document.body.appendChild(template.content);"]);
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toHaveLength(1);
	});

	it("P2: a clone of the content is inserted", () => {
		const code = templateWith(["document.body.append(template.content.cloneNode(true));"]);
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toHaveLength(1);
	});

	it("P3: a parsed node escapes into the document", () => {
		const code = templateWith(['const el = template.content.querySelector("div");', "document.body.append(el);"]);
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toHaveLength(1);
	});

	it("P4: the template's first element is returned to the caller", () => {
		const code = templateWith(["return template.content.firstElementChild;"]);
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toHaveLength(1);
	});

	it("P5: a detached <div> is not inert — its parsed handlers fire", () => {
		const code = templateWith(
			['const el = template.content.querySelector("img");', "return el.src;"],
			'const template = document.createElement("div");',
		);
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toHaveLength(1);
	});

	it("P7: an empty clear does not exempt a live write on the same line (both orders)", () => {
		expect(checkInnerHtmlUsage('a.innerHTML = ""; b.innerHTML = userInput;\n', "src/ui/p.js")).toHaveLength(1);
		expect(checkInnerHtmlUsage('b.innerHTML = userInput; a.innerHTML = "";\n', "src/ui/p.js")).toHaveLength(1);
	});

	it("P8: a sanitized write does not exempt a raw write on the same line", () => {
		expect(checkInnerHtmlUsage("a.innerHTML = DOMPurify.sanitize(x); b.innerHTML = y;\n", "src/ui/p.js")).toHaveLength(1);
	});

	it("N-P7: every write on the line benign stays silent (two clears; a clear plus a sanitized write)", () => {
		expect(checkInnerHtmlUsage('a.innerHTML = ""; b.innerHTML = "";\n', "src/ui/p.js")).toEqual([]);
		expect(checkInnerHtmlUsage('a.innerHTML = DOMPurify.sanitize(x); b.innerHTML = "";\n', "src/ui/p.js")).toEqual([]);
		expect(checkInnerHtmlUsage('el.innerHTML = DOMPurify.sanitize(x) ?? "";\n', "src/ui/p.js")).toEqual([]);
	});

	it("P6: a `let` template may be rebound to a live element", () => {
		const code = templateWith(
			["template = document.getElementById('app');", "template.innerHTML = html;"],
			'let template = document.createElement("template");',
		);
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toHaveLength(2);
	});

	it("P7: a second live write on the same line as the inert one still fires", () => {
		const code = [
			'const template = document.createElement("template");',
			"template.innerHTML = html; app.innerHTML = html;",
		].join("\n");
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toHaveLength(1);
	});

	it("P8: the template element itself is attached to the document", () => {
		const code = templateWith(["document.body.append(template);"]);
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toHaveLength(1);
	});

	it("P9: a template declared only in a comment does not exempt a live receiver", () => {
		const code = [
			'// const template = document.createElement("template");',
			"export function render(template: HTMLElement, html: string) {",
			"\ttemplate.innerHTML = html;",
			"}",
		].join("\n");
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toHaveLength(1);
	});
});
