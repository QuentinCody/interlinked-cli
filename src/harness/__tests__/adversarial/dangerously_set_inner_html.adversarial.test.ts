// Independent adversarial review of the dangerously_set_inner_html pre_block
// check (2026-10-21). Every negative here is idiomatic React/TSX a reasonable
// reviewer accepts and the detector refused before the refinement in
// checks/react.ts + checks/react-dsih-value.ts.
// Probe: scratch/2026-10-21-adversarial/dangerously_set_inner_html.probe.mts

import { describe, expect, it } from "vitest";
import { checkDangerouslySetInnerHTML } from "../../checks/react.js";

const TSX = "src/Comp.tsx";

describe("dangerously_set_inner_html — negative (must not fire)", () => {
	it("N1: DOMPurify.sanitize(...) as the whole value — the fix_instruction's own remedy", () => {
		const code = [
			"import DOMPurify from 'dompurify';",
			"export function Comment({ body }: { body: string }) {",
			"  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body) }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N2: prettier-wrapped attribute whose `__html:` sits on the next line and names a static const", () => {
		const code = [
			"const criticalCss = `body { margin: 0; }`;",
			"export default function Root() {",
			"  return (",
			"    <style",
			"      dangerouslySetInnerHTML={{",
			"        __html: criticalCss,",
			"      }}",
			"    />",
			"  );",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "app/+html.tsx")).toEqual([]);
	});

	it("N3: destructuring the prop OUT of props before spreading (defensive wrapper)", () => {
		const code = [
			"export function SafeDiv(props: React.HTMLAttributes<HTMLDivElement>) {",
			"  const { dangerouslySetInnerHTML: _omit, ...rest } = props;",
			"  return <div {...rest} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N4: a props interface member naming the prop (optional and required forms)", () => {
		const code = [
			"export interface RichTextProps {",
			"  dangerouslySetInnerHTML?: { __html: string };",
			"  raw: { dangerouslySetInnerHTML: { __html: string | TrustedHTML } };",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N5: the prop name as JSX text in a docs table", () => {
		const code = [
			"export function Row() {",
			"  return <tr><td><code>dangerouslySetInnerHTML</code></td><td>Raw HTML</td></tr>;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/docs/PropsTable.tsx")).toEqual([]);
	});

	it("N6: a static const with a type annotation (`const CSS: string = ...`)", () => {
		const code = [
			"const CSS: string = `.a { color: red; }`;",
			"export function Comp() {",
			"  return <style dangerouslySetInnerHTML={{ __html: CSS }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N7: a direct string literal value with no identifier", () => {
		const code = ["export function Nbsp() {", "  return <span dangerouslySetInnerHTML={{ __html: '&nbsp;' }} />;", "}"].join(
			"\n",
		);
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N8: sanitizeHtml(...) helper call as the whole value", () => {
		const code = [
			"import sanitizeHtml from 'sanitize-html';",
			"export function Comp({ raw }: { raw: string }) {",
			"  return <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(raw) }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N9: a useMemo-sanitized const used on a later line", () => {
		const code = [
			"export function Comp({ raw }: { raw: string }) {",
			"  const clean = useMemo(() => DOMPurify.sanitize(raw), [raw]);",
			"  return <div dangerouslySetInnerHTML={{ __html: clean }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	// ---- Round 2 (independent re-review) — refined in react-dsih-value.ts ----
	it("N10: a static object constant passed whole — dangerouslySetInnerHTML={MARKUP}", () => {
		const code = [
			"const MARKUP = { __html: '<svg viewBox=\"0 0 1 1\"><path d=\"M0 0h1v1H0z\"/></svg>' };",
			"export function Icon() {",
			"  return <span aria-hidden dangerouslySetInnerHTML={MARKUP} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N11: a direct static template literal longer than the attribute window (theme-flash script)", () => {
		const code = [
			"export default function Document() {",
			"  return (",
			"    <script",
			"      dangerouslySetInnerHTML={{",
			"        __html: `",
			"          (function () {",
			"            var theme = localStorage.getItem('theme');",
			"            if (theme) document.documentElement.classList.add(theme);",
			"          })();",
			"        `,",
			"      }}",
			"    />",
			"  );",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "pages/_document.tsx")).toEqual([]);
	});

	it("N12: an es6-string-html `/* html */` tag comment before the static template constant", () => {
		const code = [
			"const SVG = /* html */ `<svg viewBox=\"0 0 1 1\"></svg>`;",
			"export function Comp() {",
			"  return <span dangerouslySetInnerHTML={{ __html: SVG }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N13: an empty string literal value and an `as const` static template constant", () => {
		const code = [
			"const CSS = `.a { color: red; }` as const;",
			"export const Empty = () => <div dangerouslySetInnerHTML={{ __html: '' }} />;",
			"export function Comp() { return <style dangerouslySetInnerHTML={{ __html: CSS }} />; }",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N14: a sanitize-html call whose options object wraps past the attribute window", () => {
		const code = [
			"import sanitizeHtml from 'sanitize-html';",
			"export function Comment({ raw }: { raw: string }) {",
			"  return (",
			"    <div",
			"      dangerouslySetInnerHTML={{",
			"        __html: sanitizeHtml(raw, {",
			"          allowedTags: ['b', 'i', 'em', 'strong', 'a'],",
			"          allowedAttributes: { a: ['href'] },",
			"          allowedSchemes: ['https'],",
			"        }),",
			"      }}",
			"    />",
			"  );",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N15: a static identifier followed by a trailing line comment", () => {
		const code = [
			"const CSS = `.a { color: red; }`;",
			"export function Comp() {",
			"  return (",
			"    <style",
			"      dangerouslySetInnerHTML={{",
			"        __html: CSS, // inlined at build time",
			"      }}",
			"    />",
			"  );",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N16: a typed object constant whose member is a sanitizer call, passed whole", () => {
		const code = [
			"export function Comp({ raw }: { raw: string }) {",
			"  const markup: { __html: string } = { __html: DOMPurify.sanitize(raw) };",
			"  return <div dangerouslySetInnerHTML={markup} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N17: prettier puts the sanitizer call on the line after `__html:`", () => {
		const code = [
			"export function Comp({ body }: { body: string }) {",
			"  return (",
			"    <div",
			"      dangerouslySetInnerHTML={{",
			"        __html:",
			"          DOMPurify.sanitize(body),",
			"      }}",
			"    />",
			"  );",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	// ---- Round 3 (resumed review) ----
	it("N18: a memoized sanitized markup object — useMemo(() => ({ __html: DOMPurify.sanitize(raw) }), [raw])", () => {
		const code = [
			"export function Comp({ raw }: { raw: string }) {",
			"  const markup = useMemo(() => ({ __html: DOMPurify.sanitize(raw) }), [raw]);",
			"  return <div dangerouslySetInnerHTML={markup} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N19: a type-only `as string` cast after a static identifier", () => {
		const code = [
			"const CSS = `.a{}`;",
			"export const C = () => <style dangerouslySetInnerHTML={{ __html: CSS as string }} />;",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});

	it("N20: a quoted `\"__html\"` key with a literal value", () => {
		const code = 'export const C = () => <span dangerouslySetInnerHTML={{ "__html": "&copy; 2026" }} />;';
		expect(checkDangerouslySetInnerHTML(code, TSX)).toEqual([]);
	});
});

describe("dangerously_set_inner_html — positive (must fire)", () => {
	it("P1: JSON.stringify(...) into a JSON-LD script still fires (`</script>` is not escaped)", () => {
		const code = [
			"export default function Page({ jsonLd }: { jsonLd: object }) {",
			'  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />;',
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "app/page.tsx")).toHaveLength(1);
	});

	it("P2: a literal concatenated with a runtime value fires", () => {
		const code = "export const C = ({ u }) => <div dangerouslySetInnerHTML={{ __html: '<b>' + u }} />;";
		expect(checkDangerouslySetInnerHTML(code, TSX)).toHaveLength(1);
	});

	it("P3: a sanitizer call that is NOT the whole value fires", () => {
		const code = "export const C = ({ u }) => <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(u) + u }} />;";
		expect(checkDangerouslySetInnerHTML(code, TSX)).toHaveLength(1);
	});

	it("P4: a prettier-wrapped attribute whose identifier is a prop fires on the attribute line", () => {
		const code = [
			"export function Comp({ html }: { html: string }) {",
			"  return (",
			"    <div",
			"      dangerouslySetInnerHTML={{",
			"        __html: html,",
			"      }}",
			"    />",
			"  );",
			"}",
		].join("\n");
		const found = checkDangerouslySetInnerHTML(code, TSX);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
	});

	it("P5: a props-object member with a runtime value (createElement form) fires", () => {
		const code = "export const C = ({ u }) => React.createElement('div', { dangerouslySetInnerHTML: { __html: u } });";
		expect(checkDangerouslySetInnerHTML(code, TSX)).toHaveLength(1);
	});

	it("P6: forwarding the raw prop (`{props.dangerouslySetInnerHTML}`) fires", () => {
		const code = "export const C = (props) => <div dangerouslySetInnerHTML={props.dangerouslySetInnerHTML} />;";
		expect(checkDangerouslySetInnerHTML(code, TSX)).toHaveLength(1);
	});

	it("P7: a useMemo markup object WITHOUT a sanitizer fires", () => {
		const code = [
			"export function C({ raw }: { raw: string }) {",
			"  const markup = useMemo(() => ({ __html: raw }), [raw]);",
			"  return <div dangerouslySetInnerHTML={markup} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, TSX).map((m) => m.line)).toEqual([3]);
	});

	it("P8: an `as string` cast on a runtime prop fires", () => {
		const code = "export const C = ({ u }: { u: unknown }) => <div dangerouslySetInnerHTML={{ __html: u as string }} />;";
		expect(checkDangerouslySetInnerHTML(code, TSX)).toHaveLength(1);
	});

	it("P9: a quoted `\"__html\"` key with a runtime value fires", () => {
		const code = 'export const C = ({ u }) => <span dangerouslySetInnerHTML={{ "__html": u }} />;';
		expect(checkDangerouslySetInnerHTML(code, TSX)).toHaveLength(1);
	});

	it("P10: an env interpolation in a template value stays opaque and fires", () => {
		const code =
			"export const GA = () => <script dangerouslySetInnerHTML={{ __html: `gtag('config', '$" +
			"{process.env.NEXT_PUBLIC_GA_ID}');` }} />;";
		expect(checkDangerouslySetInnerHTML(code, "app/layout.tsx")).toHaveLength(1);
	});
});
