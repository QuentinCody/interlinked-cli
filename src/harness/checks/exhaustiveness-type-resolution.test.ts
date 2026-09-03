import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
	indexTypeAliases,
	resolveExpressionType,
	typeNodeToDiscriminatedUnion,
	typeNodeToLiteralUnion,
	type ResolutionContext,
} from "./exhaustiveness-type-resolution.js";

function parse(code: string) {
	return ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
}

function findExpression(sf: import("typescript").SourceFile, text: string) {
	let found: import("typescript").Expression | undefined;
	const visit = (node: import("typescript").Node): void => {
		if (found) return;
		if (
			(ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
			node.getText(sf) === text
		) {
			found = node;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	if (!found) throw new Error(`expression ${text} not found`);
	return found;
}

function emptyCtx(): ResolutionContext {
	return { localUnions: new Map(), localDiscriminated: new Map() };
}

describe("typeNodeToLiteralUnion — positive", () => {
	it("reads a string-literal union", () => {
		const sf = parse(`type T = "a" | "b" | "c";`);
		const alias = sf.statements[0] as import("typescript").TypeAliasDeclaration;
		const result = typeNodeToLiteralUnion(ts, alias.type);
		expect(result?.members).toEqual(['"a"', '"b"', '"c"']);
	});

	it("dedupes and sorts members", () => {
		const sf = parse(`type T = "b" | "a" | "b";`);
		const alias = sf.statements[0] as import("typescript").TypeAliasDeclaration;
		const result = typeNodeToLiteralUnion(ts, alias.type);
		expect(result?.members).toEqual(['"a"', '"b"']);
	});
});

describe("typeNodeToLiteralUnion — negative", () => {
	it("returns null for a non-union type", () => {
		const sf = parse(`type T = string;`);
		const alias = sf.statements[0] as import("typescript").TypeAliasDeclaration;
		expect(typeNodeToLiteralUnion(ts, alias.type)).toBeNull();
	});

	it("returns null for a union with a boolean literal member", () => {
		const sf = parse(`type T = "a" | true;`);
		const alias = sf.statements[0] as import("typescript").TypeAliasDeclaration;
		expect(typeNodeToLiteralUnion(ts, alias.type)).toBeNull();
	});
});

describe("typeNodeToDiscriminatedUnion — positive", () => {
	it("reads a discriminated union keyed on `kind`", () => {
		const sf = parse(`type T = { kind: "a"; v: number } | { kind: "b"; v: string };`);
		const alias = sf.statements[0] as import("typescript").TypeAliasDeclaration;
		const result = typeNodeToDiscriminatedUnion(ts, alias.type);
		expect(result?.discriminant).toBe("kind");
		expect(result?.tags).toEqual(['"a"', '"b"']);
	});
});

describe("typeNodeToDiscriminatedUnion — negative", () => {
	it("returns null when members lack a shared literal discriminant", () => {
		const sf = parse(`type T = { a: number } | { b: string };`);
		const alias = sf.statements[0] as import("typescript").TypeAliasDeclaration;
		expect(typeNodeToDiscriminatedUnion(ts, alias.type)).toBeNull();
	});
});

describe("indexTypeAliases", () => {
	it("indexes every top-level convertible type alias by name", () => {
		const sf = parse(`
			type A = "a" | "b";
			type B = string;
			type C = "x" | "y";
		`);
		const idx = indexTypeAliases(ts, sf, typeNodeToLiteralUnion);
		expect(Array.from(idx.keys()).sort()).toEqual(["A", "C"]);
	});
});

describe("resolveExpressionType — positive (must resolve)", () => {
	it("resolves an `as` expression against an inline literal union", () => {
		const sf = parse(`const x = y as "a" | "b";`);
		const expr = findExpression(sf, "y") as unknown as import("typescript").Expression;
		const asExpr = expr.parent as import("typescript").AsExpression;
		const resolved = resolveExpressionType(ts, asExpr, emptyCtx());
		expect(resolved?.tags).toEqual(['"a"', '"b"']);
	});

	it("resolves a property access on a discriminated-union-typed identifier", () => {
		const sf = parse(`
			function f(v: { kind: "a" } | { kind: "b" }) {
				switch (v.kind) {}
			}
		`);
		const expr = findExpression(sf, "v.kind");
		const resolved = resolveExpressionType(ts, expr, emptyCtx());
		expect(resolved?.discriminant).toBe("kind");
		expect(resolved?.tags).toEqual(['"a"', '"b"']);
	});

	it("resolves an identifier through a local type-alias union", () => {
		const sf = parse(`
			type U = "a" | "b";
			function f(v: U) {
				return v;
			}
		`);
		const ctx: ResolutionContext = {
			localUnions: indexTypeAliases(ts, sf, typeNodeToLiteralUnion),
			localDiscriminated: indexTypeAliases(ts, sf, typeNodeToDiscriminatedUnion),
		};
		const expr = findExpression(sf, "v") as unknown as import("typescript").Expression;
		// The parameter identifier's own declared-type resolution requires it be
		// referenced from within the function body, not the declaration site.
		const bodyRef = (() => {
			let found: import("typescript").Identifier | undefined;
			const visit = (node: import("typescript").Node): void => {
				if (found) return;
				if (
					ts.isIdentifier(node) &&
					node.text === "v" &&
					ts.isReturnStatement(node.parent)
				) {
					found = node;
					return;
				}
				ts.forEachChild(node, visit);
			};
			visit(sf);
			return found;
		})();
		expect(bodyRef).toBeDefined();
		const resolved = bodyRef && resolveExpressionType(ts, bodyRef, ctx);
		expect(resolved?.tags).toEqual(['"a"', '"b"']);
		expect(expr).toBeDefined();
	});
});

describe("resolveExpressionType — negative (must not resolve)", () => {
	it("returns null for a bare identifier with no declared type", () => {
		const sf = parse(`
			function f(v) {
				return v;
			}
		`);
		let ident: import("typescript").Identifier | undefined;
		const visit = (node: import("typescript").Node): void => {
			if (ident) return;
			if (ts.isIdentifier(node) && node.text === "v" && ts.isReturnStatement(node.parent)) {
				ident = node;
				return;
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
		expect(ident && resolveExpressionType(ts, ident, emptyCtx())).toBeNull();
	});

	it("returns null for an arbitrary call expression", () => {
		const sf = parse(`f(x);`);
		const stmt = sf.statements[0] as import("typescript").ExpressionStatement;
		const call = stmt.expression as import("typescript").CallExpression;
		expect(resolveExpressionType(ts, call, emptyCtx())).toBeNull();
	});
});
