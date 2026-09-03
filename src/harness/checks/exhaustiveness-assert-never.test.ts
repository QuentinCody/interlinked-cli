import { describe, expect, it } from "vitest";
import ts from "typescript";
import { defaultBranchAssertsNever } from "./exhaustiveness-assert-never.js";

function parseDefaultClause(body: string): import("typescript").DefaultClause {
	const code = `
		switch (x) {
			case "a":
				break;
			default:
				${body}
		}
	`;
	const sf = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
	let found: import("typescript").DefaultClause | undefined;
	const visit = (node: import("typescript").Node): void => {
		if (found) return;
		if (ts.isDefaultClause(node)) {
			found = node;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	if (!found) throw new Error("no default clause found");
	return found;
}

describe("defaultBranchAssertsNever — positive (must recognize)", () => {
	it("recognizes `const _: never = <expr>;`", () => {
		const clause = parseDefaultClause('const _x: never = x; break;');
		expect(defaultBranchAssertsNever(ts, clause, clause.getSourceFile())).toBe(true);
	});

	it("recognizes an assertNever(...) call", () => {
		const clause = parseDefaultClause("assertNever(x);");
		expect(defaultBranchAssertsNever(ts, clause, clause.getSourceFile())).toBe(true);
	});

	it("recognizes `throw new UnreachableError(...)`", () => {
		const clause = parseDefaultClause("throw new UnreachableError(x);");
		expect(defaultBranchAssertsNever(ts, clause, clause.getSourceFile())).toBe(true);
	});

	it("recognizes `return assertNever(...)`", () => {
		const clause = parseDefaultClause("return assertNever(x);");
		expect(defaultBranchAssertsNever(ts, clause, clause.getSourceFile())).toBe(true);
	});

	it("recognizes the idiom nested inside a bare block", () => {
		const clause = parseDefaultClause("{ const _x: never = x; throw new Error('unreachable'); }");
		expect(defaultBranchAssertsNever(ts, clause, clause.getSourceFile())).toBe(true);
	});

	it("recognizes `throw assertNever(...)`", () => {
		const clause = parseDefaultClause("throw assertNever(x);");
		expect(defaultBranchAssertsNever(ts, clause, clause.getSourceFile())).toBe(true);
	});
});

describe("defaultBranchAssertsNever — negative (must NOT recognize)", () => {
	it("does not recognize a plain break", () => {
		const clause = parseDefaultClause("break;");
		expect(defaultBranchAssertsNever(ts, clause, clause.getSourceFile())).toBe(false);
	});

	it("does not recognize an unrelated throw", () => {
		const clause = parseDefaultClause("throw new Error('oops');");
		expect(defaultBranchAssertsNever(ts, clause, clause.getSourceFile())).toBe(false);
	});

	it("does not recognize an assertion buried inside an if body", () => {
		const clause = parseDefaultClause("if (true) { assertNever(x); }");
		expect(defaultBranchAssertsNever(ts, clause, clause.getSourceFile())).toBe(false);
	});

	it("does not recognize an unrelated variable statement", () => {
		const clause = parseDefaultClause("const y = 1; break;");
		expect(defaultBranchAssertsNever(ts, clause, clause.getSourceFile())).toBe(false);
	});
});
