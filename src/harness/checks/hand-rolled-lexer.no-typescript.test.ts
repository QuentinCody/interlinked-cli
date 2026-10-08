import { describe, expect, it, vi } from "vitest";

// Without the optional `typescript` dependency the detector cannot find function boundaries, and a heuristic
// check never guesses: it reports nothing rather than a finding it could not locate.
vi.mock("./cyclomatic-ast.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./cyclomatic-ast.js")>()),
	parseTsSource: () => null,
}));

const { detectHandRolledLexer } = await import("./hand-rolled-lexer.js");

const LEXER = `export function scan(src: string): string {
	let inComment = false;
	for (let i = 0; i < src.length; i++) {
		if (src[i] === "/" && src[i + 1] === "*") inComment = true;
	}
	return inComment ? "" : src;
}
`;

describe("detectHandRolledLexer — negative (must not fire): typescript is not installed", () => {
	it("returns no findings for a lexer it would otherwise report", () => {
		expect(detectHandRolledLexer(LEXER, "src/harness/checks/scan.ts")).toEqual([]);
	});
});
