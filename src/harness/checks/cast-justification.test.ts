import { describe, expect, it, vi } from "vitest";
import * as syntaxParser from "./cyclomatic-ast.js";
import { countUnjustifiedCasts, findUnjustifiedCasts } from "./cast-justification.js";

const n = (s: string) => findUnjustifiedCasts(s, "src/foo.ts").length;

describe("findUnjustifiedCasts", () => {
	it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])("aligns comments and diagnostics across separator %j", (separator) => {
		const content = ["const heading = 1;", "// SAFETY: the first shape was validated", "const a = input as User;", "const b = input as Admin;"].join(separator);
		expect(findUnjustifiedCasts(content, "source.ts")).toEqual([{ line: 4, text: "const b = input as Admin;" }]);
	});
	it("retains lexical assertion detection if the syntax parser fails", () => {
		const parser = vi.spyOn(syntaxParser, "parseTsSource").mockImplementationOnce(() => { throw new Error("parser unavailable"); });
		try {
			const content = 'import { User as Alias } from "types";\nexport { User as PublicUser };\nconst value = input as User;';
			expect(findUnjustifiedCasts(content, "src/a.ts")).toEqual([{ line: 3, text: "const value = input as User;" }]);
		} finally {
			parser.mockRestore();
		}
	});

	// ── positives: real `as T` assertions with no justification ──────────────
	it("flags a plain `as T` cast with no justification", () => {
		expect(n("const x = foo as Bar;")).toBeGreaterThanOrEqual(1);
	});
	it("flags a double `as unknown as T` escape-hatch cast", () => {
		expect(n("const c = data as unknown as Config;")).toBeGreaterThanOrEqual(1);
	});
	it("flags a cast embedded in an expression", () => {
		expect(n("const total = (val as number) + 1;")).toBeGreaterThanOrEqual(1);
	});
	it.each([
		"const value = input as { id: string };",
		"const value = input as [string, number];",
		"const value = input as 'ready';",
		"const value = input as (A | B);",
		"const value = <User>input;",
		"const value = input as/* shape */User;",
	])("detects assertion syntax beyond named as targets: %s", (content) => {
		expect(n(content)).toBe(1);
	});
	it.each([
		"// SAFETY:",
		"/* SAFETY: */",
		"// SAFETY: ...",
		"// SAFETY is important",
	])("requires a nonempty explanation after the marker: %s", (comment) => {
		expect(n(`${comment}\nconst value = input as User;`)).toBe(1);
	});
	it("does not accept safety text inside a string or regex", () => {
		expect(n('const value = "SAFETY: trusted" as User;')).toBe(1);
		expect(n('const value = /SAFETY: trusted/ as User;')).toBe(1);
	});
	it("recognizes assertions in template substitutions, ignoring literal examples", () => {
		expect(n('const value = `input as User ${input as string}`;')).toBe(1);
		expect(n('const example = `input as User`;')).toBe(0);
	});
	it("does not propagate a trailing explanation to the next statement", () => {
		const content = "const a = input as User; // SAFETY: validated above\nconst b = input as Admin;";
		expect(findUnjustifiedCasts(content, "src/foo.ts")).toEqual([
			{ line: 2, text: "const b = input as Admin;" },
		]);
	});
	it("accepts a comment attached to the start of a multiline assertion statement", () => {
		const content = "// SAFETY: the callback returns the validated user\nconst user = select(\n    value,\n    key,\n) as User;";
		expect(n(content)).toBe(0);
	});
	it("accepts a validated object construction's statement-level explanation", () => {
		const content = "function parse(input: unknown) {\n// SAFETY: both fields were validated before constructing this result\nreturn {\n a: input as A,\n b: input as B,\n};\n}";
		expect(n(content)).toBe(0);
	});
	it("does not treat JSX elements or generic declarations as angle assertions", () => {
		expect(findUnjustifiedCasts('const el = <User name="A" />;', "src/App.tsx")).toEqual([]);
		expect(n("const identity = <T>(input: T): T => input;")).toBe(0);
	});

	// ── negatives: legitimate patterns that must NOT fire ────────────────────
	it("does not flag `as const`", () => {
		expect(n("const tuple = [1, 2] as const;")).toBe(0);
	});
	it("does not flag a cast carrying a // SAFETY: justification (same or prior line)", () => {
		expect(n("// SAFETY: parseFoo validated the shape above\nconst x = foo as Bar;")).toBe(0);
		expect(n("const x = foo as Bar; // SAFETY: branded by the parser")).toBe(0);
	});
	it("does not flag an import rename `as`", () => {
		expect(n('import { foo as bar } from "./x.js";')).toBe(0);
	});
	it("does not flag an export rename `as`", () => {
		expect(n('export { a as b } from "./y.js";')).toBe(0);
	});
	it("does not flag cast-like text inside a string literal", () => {
		expect(n('const label = "treat this as Foo, please";')).toBe(0);
	});

	// ── file-extension gate: `as`-casts are a TS construct ───────────────────
	it("does not fire on a markdown design doc discussing `as any`", () => {
		const doc = [
			"# Design memo",
			"Avoid `foo as any` — cast it as Config after validating.",
			"```ts",
			"const c = data as Config;",
			"```",
		].join("\n");
		expect(findUnjustifiedCasts(doc, "docs/design/per-edit-cloud-mutation-testing.md")).toEqual(
			[],
		);
	});
	it("does not fire on a .txt or .yaml file containing cast-shaped text", () => {
		expect(findUnjustifiedCasts("value as Foo", "notes.txt")).toEqual([]);
		expect(findUnjustifiedCasts("run: echo data as Config", ".github/workflows/ci.yaml")).toEqual(
			[],
		);
	});
	it("still fires on .tsx and .mts code files", () => {
		expect(findUnjustifiedCasts("const x = foo as Bar;", "src/App.tsx").length).toBe(1);
		expect(findUnjustifiedCasts("const x = foo as Bar;", "src/util.mts").length).toBe(1);
	});
});

describe("countUnjustifiedCasts", () => {
	it("matches the finder length and counts net occurrences across lines", () => {
		const src = ["const a = x as A;", "const b = y as B; // SAFETY: ok", "const c = z as C;"].join("\n");
		// lines 1 and 3 are unjustified; line 2 is justified.
		expect(countUnjustifiedCasts(src)).toBe(2);
	});
	it("keeps the line unit when nested or separate assertions share a line", () => {
		expect(countUnjustifiedCasts("const a = x as unknown as A; const b = y as B;")).toBe(1);
	});
	it("attributes multiline assertions to their assertion-token lines", () => {
		const content = "const a = (\n    value\n) as User;\nconst b = <User>value;";
		expect(findUnjustifiedCasts(content, "source.ts").map((match) => match.line)).toEqual([3, 4]);
	});
	it("uses the supplied TSX path for the ratchet", () => {
		const content = "const ui = <User>{input as string}</User>;";
		expect(countUnjustifiedCasts(content, "source.tsx")).toBe(1);
	});
	it("retains lexical measurement while an edit contains incomplete syntax", () => {
		expect(countUnjustifiedCasts("const a = x as User;\nfunction unfinished(")).toBe(1);
	});
	it("retains completed angle assertions while the parser recovers from another incomplete statement", () => {
		expect(countUnjustifiedCasts("const a = <User>x;\nfunction unfinished(")).toBe(1);
	});
});
