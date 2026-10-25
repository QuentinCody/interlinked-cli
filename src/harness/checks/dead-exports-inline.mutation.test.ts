import { describe, expect, it } from "vitest";
import { findDeadExports, findDeadTypeExports } from "./dead-exports-inline.js";

/**
 * Mutation-hardening tests for dead-exports-inline.ts. Each test pins a
 * behavior that the module header or a doc comment states and that the
 * existing test file left unpinned (survivors of single-change mutants).
 */
function repo(files: Record<string, string>) {
	return {
		listFiles: () => Object.keys(files),
		readFile: (p: string) => files[p] ?? null,
	};
}

/** An importer that proves the resolver works for src/lib.ts, so the
 *  evidence guard does not silence the result. */
const PROOF_IMPORTER = 'import { proof } from "./lib.js";\nconsole.log(proof);\n';

describe("dead-exports-inline mutation hardening", () => {
	it("a 'public API' marker on the opening line of a block comment suppresses the export (header: doc comment directly above)", () => {
		// Doc comment dead-exports-inline.ts:132-134: a comment in the contiguous
		// block above the export saying "public API" marks it deliberate. Here the
		// marker sits on the `/**` line itself, so the walk must treat `/**` as a comment.
		const lib = "export const proof = 1;\n/** public API\n * more text\n */\nexport const marked = 2;\n";
		const files = { "src/lib.ts": lib, "src/main.ts": PROOF_IMPORTER };
		const out = findDeadExports({ content: lib, filePath: "src/lib.ts", cwd: "/repo" }, repo(files));
		expect(out).toEqual([]);
	});

	it("a single-line '/* public API */' comment directly above the export suppresses it", () => {
		const lib = "export const proof = 1;\n/* public API */\nexport const marked = 2;\n";
		const files = { "src/lib.ts": lib, "src/main.ts": PROOF_IMPORTER };
		const out = findDeadExports({ content: lib, filePath: "src/lib.ts", cwd: "/repo" }, repo(files));
		expect(out).toEqual([]);
	});

	it("an exported-by-clause symbol with no other reference is reported as having no references (clause is not a use)", () => {
		// Comment dead-exports-inline.ts:158-159: a separate `export { name }`
		// clause adds an occurrence that is also not a real use.
		const lib = "export const proof = 1;\nconst only = 1;\nexport { only };\n";
		const files = { "src/lib.ts": lib, "src/main.ts": PROOF_IMPORTER };
		const out = findDeadExports({ content: lib, filePath: "src/lib.ts", cwd: "/repo" }, repo(files));
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("'only'");
		expect(out[0]?.text).toContain("no references anywhere");
	});

	it("an absolute filePath with no cwd resolves against the filesystem root, so the export is still analyzed", () => {
		// resolveAndScan (L198-199): a missing cwd falls back to "/" so an absolute
		// path becomes repo-relative instead of escaping the project root.
		const lib = "export const proof = 1;\nexport const dead = 2;\n";
		const files = { "src/lib.ts": lib, "src/main.ts": PROOF_IMPORTER };
		const out = findDeadExports({ content: lib, filePath: "/src/lib.ts" }, repo(files));
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'dead'")]);
	});

	it("an interface field line ending in ';' does not end the span before a later field's type reference", () => {
		// extractBracedOrStatement (L229-235): the reference can sit anywhere in an
		// interface body, so a ';' inside braces must not terminate the capture.
		const lib =
			"export interface Dead { a: 1 }\nexport interface Wrap {\n\ta: string;\n\td: Dead;\n}\n";
		const files = { "src/lib.ts": lib, "src/main.ts": PROOF_IMPORTER };
		const out = findDeadTypeExports(
			{ content: lib, filePath: "src/lib.ts", cwd: "/repo", only: new Set(["Dead"]) },
			repo(files),
		);
		expect(out).toEqual([]);
	});

	it("an inline object-type parameter does not cut the signature early (type inside it is public surface)", () => {
		// Doc comment L262-264 and L275-277: the first `{` at paren depth 0 opens
		// the body; an inline object-type param `(x: { a: T })` must not trigger a cutoff.
		const lib = "export interface Dead { a: 1 }\nexport function f(x: { a: Dead }): void {\n\treturn;\n}\n";
		const files = { "src/lib.ts": lib, "src/main.ts": PROOF_IMPORTER };
		const out = findDeadTypeExports(
			{ content: lib, filePath: "src/lib.ts", cwd: "/repo", only: new Set(["Dead"]) },
			repo(files),
		);
		expect(out).toEqual([]);
	});

	it("an unbalanced ')' in a literal does not stop the signature from ending at its ';' (body-only type use still fires)", () => {
		// Doc comment L277-279: a referenced type inside the BODY / later code is
		// excluded from the signature evidence. A stray ')' in a string must not
		// push paren depth negative and swallow the following lines.
		const lib =
			'export interface Dead { a: 1 }\nexport const marker = ")";\nfunction internal(x: Dead) {\n\treturn x;\n}\n';
		const files = { "src/lib.ts": lib, "src/main.ts": PROOF_IMPORTER };
		const out = findDeadTypeExports(
			{ content: lib, filePath: "src/lib.ts", cwd: "/repo", only: new Set(["Dead"]) },
			repo(files),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("still used inside this file");
	});

	it("a ';' inside parentheses (multi-line object-type param) does not end the signature before the type reference", () => {
		// L273-279: only a brace-less statement's terminating ';' ends the span;
		// a ';' separating members of an inline object-type param is inside parens.
		const lib =
			"export interface Dead { a: 1 }\nexport function f(opts: {\n\ta: string;\n\tb: Dead;\n}): void {\n\treturn;\n}\n";
		const files = { "src/lib.ts": lib, "src/main.ts": PROOF_IMPORTER };
		const out = findDeadTypeExports(
			{ content: lib, filePath: "src/lib.ts", cwd: "/repo", only: new Set(["Dead"]) },
			repo(files),
		);
		expect(out).toEqual([]);
	});

	it("an unterminated span stops at the safety-valve line cap: a reference one line past it is not evidence", () => {
		// L219-221 safety valve (SIGNATURE_SPAN_LINE_CAP = 200 lines, L221): the
		// span covers exactly the first 200 lines from its start, so a reference
		// on the 201st line is outside it.
		const filler = Array.from({ length: 199 }, () => '\t| "x"').join("\n");
		const lib = `export interface Dead { a: 1 }\nexport type Alias =\n${filler}\n\t| Dead\n`;
		const files = { "src/lib.ts": lib, "src/main.ts": PROOF_IMPORTER };
		const out = findDeadTypeExports(
			{ content: lib, filePath: "src/lib.ts", cwd: "/repo", only: new Set(["Dead"]) },
			repo(files),
		);
		expect(out.map((m) => m.text)).toEqual([expect.stringContaining("'Dead'")]);
	});
});
