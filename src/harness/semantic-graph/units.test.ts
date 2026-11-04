import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOC_SECTION_TEXT_CAP, extractRepoUnits, extractUnits, unitId } from "./units.js";

const CODE = [
	"/** Adds two numbers.",
	" *  Pure. */",
	"export function add(a: number, b: number): number {",
	"\treturn a + b;",
	"}",
	"",
	"// Subtracts one.",
	"// Also pure.",
	"const sub = (a: number): number => a - 1;",
	"",
	"/** Orphaned: a blank line separates it from the function. */",
	"",
	"function gap(): number { return 2; }",
	"",
	"class K {",
	"\tm(): number { return 1; }",
	"}",
	"",
	"[1].map((x) => x + 1);",
].join("\n");

const TEST_CODE = [
	'import { describe, expect, it } from "vitest";',
	'describe("add", () => {',
	'\tit("adds two numbers", () => {',
	"\t\texpect(add(1, 2)).toBe(3);",
	"\t});",
	'\ttest.skip("is skipped", () => {',
	"\t\texpect(1).toBe(1);",
	"\t});",
	"});",
	"function helper(): number { return 1; }",
].join("\n");

const DOC = [
	"# Title",
	"intro line",
	"## First",
	"first body",
	"### Nested",
	"nested body",
	"```md",
	"# not a heading",
	"```",
	"## Second",
	"second body",
].join("\n");

describe("extractUnits — positive (extracts each unit kind)", () => {
	it("P1: functions with text, line span, id and hash; anonymous callbacks skipped", () => {
		const units = extractUnits("src/x.ts", CODE).filter((u) => u.kind === "function");
		expect(units.map((u) => u.name)).toEqual(["add", "sub", "gap", "K.m"]);
		const add = units[0]!;
		expect(add).toMatchObject({ id: "src/x.ts#function:add@3", line: 3, endLine: 5, file: "src/x.ts" });
		expect(add.text).toBe("export function add(a: number, b: number): number {\n\treturn a + b;\n}");
		expect(add.hash).toBe(createHash("sha256").update(add.text).digest("hex"));
	});

	it("P2: a /** */ block and a contiguous // block directly above a function are doc comments", () => {
		const docs = extractUnits("src/x.ts", CODE).filter((u) => u.kind === "doc_comment");
		expect(docs.map((u) => [u.name, u.line, u.endLine])).toEqual([["add", 1, 2], ["sub", 7, 8]]);
		expect(docs[0]?.text).toBe("/** Adds two numbers.\n *  Pure. */");
		expect(docs[1]?.text).toBe("// Subtracts one.\n// Also pure.");
		expect(docs[0]?.id).toBe("src/x.ts#doc_comment:add@1");
	});

	it("P3: it()/test() blocks become test units with the block's full span", () => {
		const tests = extractUnits("src/x.test.ts", TEST_CODE).filter((u) => u.kind === "test");
		expect(tests.map((u) => [u.name, u.line, u.endLine])).toEqual([["adds two numbers", 3, 5], ["is skipped", 6, 8]]);
		expect(tests[0]?.text).toContain("expect(add(1, 2)).toBe(3);");
		expect(tests[0]?.id).toBe("src/x.test.ts#test:adds two numbers@3");
		expect(extractUnits("src/x.test.ts", TEST_CODE).some((u) => u.kind === "function" && u.name === "helper")).toBe(true);
	});

	it("P4: markdown headings become doc sections that end at the next heading of equal or higher level", () => {
		const sections = extractUnits("docs/a.md", DOC);
		expect(sections.every((u) => u.kind === "doc_section")).toBe(true);
		expect(sections.map((u) => [u.name, u.line, u.endLine])).toEqual([
			["Title", 1, 11],
			["First", 3, 9],
			["Nested", 5, 9],
			["Second", 10, 11],
		]);
		expect(sections[1]?.text).toBe("## First\nfirst body\n### Nested\nnested body\n```md\n# not a heading\n```");
	});

	it("P5: an absolute file path is made repo-relative when cwd is given", () => {
		const units = extractUnits("/repo/src/y.ts", "export function f(): number { return 1; }", "/repo");
		expect(units[0]?.file).toBe("src/y.ts");
		expect(unitId("src/y.ts", "function", "f", 1)).toBe("src/y.ts#function:f@1");
	});
});

describe("extractUnits — negative (does not invent units)", () => {
	it("N1: a comment separated by a blank line is not a doc comment", () => {
		const docs = extractUnits("src/x.ts", CODE).filter((u) => u.kind === "doc_comment");
		expect(docs.some((u) => u.name === "gap")).toBe(false);
	});

	it("N2: an unsupported language yields no units", () => {
		expect(extractUnits("src/x.go", "func main() {}")).toEqual([]);
	});

	it("N3: a test file with no it()/test() yields no test units", () => {
		expect(extractUnits("src/z.test.ts", "export const n = 1;").filter((u) => u.kind === "test")).toEqual([]);
	});

	it("N4: doc section text is capped and the cap is stated", () => {
		const long = `# Big\n${"x".repeat(DOC_SECTION_TEXT_CAP + 50)}`;
		const [section] = extractUnits("README.md", long);
		expect(section?.text.length).toBe(DOC_SECTION_TEXT_CAP);
	});
});

describe("extractRepoUnits", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "sg-units-"));
		mkdirSync(join(cwd, "src", "__tests__"), { recursive: true });
		mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
		mkdirSync(join(cwd, "scratch"), { recursive: true });
		writeFileSync(join(cwd, "src", "b.ts"), "/** doc */\nexport function b(): number { return 1; }\n");
		writeFileSync(join(cwd, "src", "a.ts"), "export function a(): number { return 1; }\n");
		writeFileSync(join(cwd, "src", "__tests__", "a.test.ts"), 'it("a works", () => { expect(1).toBe(1); });\n');
		writeFileSync(join(cwd, "README.md"), "# Readme\nbody\n");
		writeFileSync(join(cwd, "node_modules", "dep", "x.md"), "# Dep\n");
		writeFileSync(join(cwd, "scratch", "note.md"), "# Scratch\n");
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("P6: walks code and docs, includes tests, skips vendored dirs, sorts by file then line", () => {
		const units = extractRepoUnits(cwd);
		expect(units.map((u) => u.id)).toEqual([
			"README.md#doc_section:Readme@1",
			"src/__tests__/a.test.ts#test:a works@1",
			"src/a.ts#function:a@1",
			"src/b.ts#doc_comment:b@1",
			"src/b.ts#function:b@2",
		]);
	});

	it("N5: docs can be excluded", () => {
		const units = extractRepoUnits(cwd, { includeDocs: false });
		expect(units.some((u) => u.kind === "doc_section")).toBe(false);
		expect(units.length).toBe(4);
	});

	it("N6: scope globs bound code and markdown alike; the seed scope drops research/ and .claude/ markdown", () => {
		mkdirSync(join(cwd, "research"), { recursive: true });
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		writeFileSync(join(cwd, "research", "r.md"), "# Research\n");
		writeFileSync(join(cwd, ".claude", "c.md"), "# Claude\n");
		expect(extractRepoUnits(cwd).map((u) => u.file)).not.toContain("research/r.md");
		expect(extractRepoUnits(cwd).map((u) => u.file)).not.toContain(".claude/c.md");
		const narrowed = extractRepoUnits(cwd, { include: ["src/**"], exclude: ["src/b.ts"] });
		expect(narrowed.map((u) => u.id)).toEqual(["src/__tests__/a.test.ts#test:a works@1", "src/a.ts#function:a@1"]);
		const widened = extractRepoUnits(cwd, { include: ["research/**"], exclude: [] });
		expect(widened.map((u) => u.id)).toEqual(["research/r.md#doc_section:Research@1"]);
	});
});
