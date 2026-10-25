// Independent adversarial pass over `inner_html` (pre_block), 2026-10-21.
// Probe: scratch/2026-10-21-adversarial/inner_html.probe.mts.
//
// Before this pass `/\.innerHTML\s*=/` matched a COMPARISON (`=== ""`), a
// constant clear (`= ""`), and the detector's own fix instruction (`=
// DOMPurify.sanitize(html)`); `dangerouslySetInnerHTML` fired on a TYPE
// declaration, a destructuring pattern, and JSX prose. Every one of those
// BLOCKED a legitimate edit.

import { describe, expect, it } from "vitest";
import { checkInnerHtmlUsage } from "../../checks/inner-html.js";

describe("inner_html — negative (must not fire)", () => {
	it("N1: a strict-equality comparison `el.innerHTML === \"\"` is a read", () => {
		const code = 'export const isEmpty = (el: Element) => el.innerHTML === "";';
		expect(checkInnerHtmlUsage(code, "src/dom/empty.ts")).toEqual([]);
	});

	it("N2: a loose-equality comparison `el.innerHTML == expected`", () => {
		expect(checkInnerHtmlUsage("if (el.innerHTML == expected) return true;", "src/dom/diff.ts")).toEqual([]);
	});

	it("N3: clearing children with an empty string literal", () => {
		const code = 'export function clear(el: Element) { el.innerHTML = ""; }';
		expect(checkInnerHtmlUsage(code, "src/dom/clear.ts")).toEqual([]);
	});

	it("N4: the single-quoted clear idiom `el.innerHTML = '';` with a trailing comment", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = ''; // drop children", "src/render.ts")).toEqual([]);
	});

	it("N5: a sanitized value `DOMPurify.sanitize(html)` is the fix instruction itself", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = DOMPurify.sanitize(html);", "src/render.ts")).toEqual([]);
	});

	it("N6: a React `__html` whose value is one sanitizer call", () => {
		const code = "return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(md) }} />;";
		expect(checkInnerHtmlUsage(code, "src/Markdown.tsx")).toEqual([]);
	});

	it("N7: an escaped text assignment `escapeHtml(text)`", () => {
		expect(checkInnerHtmlUsage("node.innerHTML = escapeHtml(text);", "src/render.ts")).toEqual([]);
	});

	it("N8: a TS interface that DECLARES the React prop type", () => {
		const code = "export interface RawHtmlProps { dangerouslySetInnerHTML?: { __html: string }; }";
		expect(checkInnerHtmlUsage(code, "src/types/props.ts")).toEqual([]);
	});

	it("N9: a destructuring pattern that drops the prop in a forwarding wrapper", () => {
		const code = "const { dangerouslySetInnerHTML: _dropped, ...safe } = props;";
		expect(checkInnerHtmlUsage(code, "src/SafeDiv.tsx")).toEqual([]);
	});

	it("N10: JSX prose that quotes the idiom in a docs page", () => {
		const code = "<p>Never write el.innerHTML = userInput in a handler.</p>";
		expect(checkInnerHtmlUsage(code, "src/docs/XssPage.tsx")).toEqual([]);
	});

	// Round 2 (independent reviewer, same day): prettier-wrapped forms, Trusted
	// Types, framework sanitizers held on `this`, and the null-fallback idiom.
	// Probe: scratch/2026-10-21-adversarial/inner_html.round2.probe.mts.

	it("N11: a prettier-wrapped assignment — `=` at end of line, the sanitizer on the next", () => {
		const code = ["container.innerHTML =", "  DOMPurify.sanitize(renderMarkdown(source));"].join("\n");
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toEqual([]);
	});

	it("N12: a sanitizer call whose options object spans lines", () => {
		const code = ["el.innerHTML = DOMPurify.sanitize(html, {", '  ALLOWED_TAGS: ["b", "i"],', "});"].join("\n");
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toEqual([]);
	});

	it("N13: a multi-line React prop — `dangerouslySetInnerHTML={{` then a sanitized `__html:`", () => {
		const code = [
			"return (",
			"  <div",
			'    className="md"',
			"    dangerouslySetInnerHTML={{",
			"      __html: DOMPurify.sanitize(md),",
			"    }}",
			"  />",
			");",
		].join("\n");
		expect(checkInnerHtmlUsage(code, "src/Markdown.tsx")).toEqual([]);
	});

	it("N14: a Trusted Types policy value `htmlPolicy.createHTML(template)`", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = htmlPolicy.createHTML(template);", "src/render.ts")).toEqual([]);
	});

	it("N15: Angular's DomSanitizer on `this` with the `?? \"\"` null fallback", () => {
		const code = 'this.host.nativeElement.innerHTML = this.sanitizer.sanitize(SecurityContext.HTML, html) ?? "";';
		expect(checkInnerHtmlUsage(code, "src/app/preview.component.ts")).toEqual([]);
	});

	it("N16: an awaited sanitizer whose argument list wraps across lines", () => {
		const code = ["el.innerHTML = await sanitizeHtml(", "  await fetchFragment(id),", ");"].join("\n");
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toEqual([]);
	});

	it("N17: a single-line sanitizer followed by the `?? ''` fallback", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = DOMPurify.sanitize(html) ?? '';", "src/render.ts")).toEqual([]);
	});

	// Round 3 (independent reviewer, resume pass): TypeScript casts after the
	// sanitizer, other sanitizer libraries, optional receivers, and props typed
	// with a NAMED type. Probe: scratch/2026-10-21-adversarial/inner_html.round3.probe.mts.

	it("N18: a Trusted Types value cast for the TS DOM lib `as unknown as string`", () => {
		const code = "el.innerHTML = policy.createHTML(markup) as unknown as string;";
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toEqual([]);
	});

	it("N19: a sanitizer result cast `as string` after a multi-option call", () => {
		const code = "el.innerHTML = DOMPurify.sanitize(html, { RETURN_TRUSTED_TYPE: true }) as string;";
		expect(checkInnerHtmlUsage(code, "src/render.ts")).toEqual([]);
	});

	it("N20: a non-null assertion after Angular's `sanitize(…)!`", () => {
		const code = "el.innerHTML = this.sanitizer.sanitize(SecurityContext.HTML, html)!;";
		expect(checkInnerHtmlUsage(code, "src/app/preview.component.ts")).toEqual([]);
	});

	it("N21: a React `__html` sanitizer value with a cast", () => {
		const code = "return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(md) as string }} />;";
		expect(checkInnerHtmlUsage(code, "src/Markdown.tsx")).toEqual([]);
	});

	it("N22: js-xss `filterXSS(html)`", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = filterXSS(html);", "src/render.ts")).toEqual([]);
	});

	it("N23: lodash `_.escape(text)`", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = _.escape(text);", "src/render.ts")).toEqual([]);
	});

	it("N24: the `he` entity encoder `he.encode(text)`", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = he.encode(text);", "src/render.ts")).toEqual([]);
	});

	it("N25: an optional-chained sanitizer receiver `this.sanitizer?.sanitize(…) ?? \"\"`", () => {
		const code = 'this.el.nativeElement.innerHTML = this.sanitizer?.sanitize(SecurityContext.HTML, html) ?? "";';
		expect(checkInnerHtmlUsage(code, "src/app/preview.component.ts")).toEqual([]);
	});

	it("N26: an interface member typed with a NAMED type `dangerouslySetInnerHTML: DangerousHtml;`", () => {
		const code = ["export interface RawHtmlProps {", "  dangerouslySetInnerHTML: DangerousHtml;", "}"].join("\n");
		expect(checkInnerHtmlUsage(code, "src/types/props.ts")).toEqual([]);
	});

	it("N27: a member typed by an indexed-access type `React.DOMAttributes<T>[\"dangerouslySetInnerHTML\"]`", () => {
		const code =
			'type Props = { dangerouslySetInnerHTML: React.DOMAttributes<HTMLElement>["dangerouslySetInnerHTML"]; };';
		expect(checkInnerHtmlUsage(code, "src/types/props.ts")).toEqual([]);
	});
});

describe("inner_html — positive (must fire)", () => {
	it("P1: a direct assignment of a variable", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = userHtml;", "src/x.ts")).toEqual([
			{ line: 1, text: "el.innerHTML = userHtml;" },
		]);
	});

	it("P2: a literal concatenated with data", () => {
		expect(checkInnerHtmlUsage('el.innerHTML = "<b>" + name + "</b>";', "src/x.ts")).toHaveLength(1);
	});

	it("P3: a template literal with interpolation", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = `<b>${name}</b>`;", "src/x.ts")).toHaveLength(1);
	});

	it("P4: a raw React `__html` value", () => {
		expect(checkInnerHtmlUsage("<div dangerouslySetInnerHTML={{ __html: md }} />", "src/x.tsx")).toHaveLength(1);
	});

	it("P5: a sanitizer call that is only an ARGUMENT (`wrap(sanitize(a), raw)`) still fires", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = wrap(DOMPurify.sanitize(a), raw);", "src/x.ts")).toHaveLength(1);
	});

	it("P6: a sanitized value concatenated with raw data still fires", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = DOMPurify.sanitize(a) + raw;", "src/x.ts")).toHaveLength(1);
	});

	it("P7: an arrow body assignment `(el) => el.innerHTML = x` is not JSX prose", () => {
		expect(checkInnerHtmlUsage("const set = (el) => el.innerHTML = x;", "src/x.ts")).toHaveLength(1);
	});

	it("P9: a NON-empty string literal stays a finding (pinned by the verify and recurrence suites)", () => {
		expect(checkInnerHtmlUsage('el.innerHTML = "<b>hi</b>";', "src/x.ts")).toHaveLength(1);
	});

	it("P8: a createElement props object with a raw `__html` value still fires", () => {
		const code = 'createElement("div", { dangerouslySetInnerHTML: { __html: md } });';
		expect(checkInnerHtmlUsage(code, "src/x.ts")).toHaveLength(1);
	});

	it("P10: a wrapped assignment whose NEXT line is raw data fires on the sink line", () => {
		expect(checkInnerHtmlUsage(["el.innerHTML =", "  userHtml;"].join("\n"), "src/x.ts")).toEqual([
			{ line: 1, text: "el.innerHTML =" },
		]);
	});

	it("P11: a multi-line React prop whose `__html` is raw fires on the prop line", () => {
		const code = ["<div", "  dangerouslySetInnerHTML={{", "    __html: md,", "  }}", "/>"].join("\n");
		expect(checkInnerHtmlUsage(code, "src/x.tsx")).toEqual([{ line: 2, text: "dangerouslySetInnerHTML={{" }]);
	});

	it("P12: a multi-line sanitizer call concatenated with raw data after its close still fires", () => {
		const code = ["el.innerHTML = DOMPurify.sanitize(html, {", "  ALLOWED_TAGS: [],", "}) + raw;"].join("\n");
		expect(checkInnerHtmlUsage(code, "src/x.ts")).toHaveLength(1);
	});

	it("P13: a bare `createHTML(x)` with no receiver is a markup builder, not Trusted Types", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = createHTML(name);", "src/x.ts")).toHaveLength(1);
	});

	it("P14: a non-empty fallback after a sanitizer is not the empty-literal idiom and still fires", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = DOMPurify.sanitize(a) ?? raw;", "src/x.ts")).toHaveLength(1);
	});

	it("P15: a raw value with a cast `userHtml as string` still fires", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = userHtml as string;", "src/x.ts")).toHaveLength(1);
	});

	it("P16: a parenthesized sanitizer cast concatenated with raw data still fires", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = (DOMPurify.sanitize(a) as string) + raw;", "src/x.ts")).toHaveLength(1);
	});

	it("P17: an object-literal prop VALUE (no `;` terminator) is not a type annotation and still fires", () => {
		const code = 'createElement("div", { dangerouslySetInnerHTML: Markup });';
		expect(checkInnerHtmlUsage(code, "src/x.ts")).toHaveLength(1);
	});

	it("P18: a cast followed by concatenation `sanitize(a) as string + raw` still fires", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = DOMPurify.sanitize(a) as string + raw;", "src/x.ts")).toHaveLength(1);
	});

	it("P19: a bare `escape(text)` (the deprecated URL encoder) is not an HTML escaper and still fires", () => {
		expect(checkInnerHtmlUsage("el.innerHTML = escape(text);", "src/x.ts")).toHaveLength(1);
	});
});
