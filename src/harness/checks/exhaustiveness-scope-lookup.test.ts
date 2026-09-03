import { describe, expect, it } from "vitest";
import ts from "typescript";
import { findDeclaredTypeForIdentifier } from "./exhaustiveness-scope-lookup.js";

function findIdentifier(sourceFile: import("typescript").SourceFile, text: string) {
	let found: import("typescript").Identifier | undefined;
	const visit = (node: import("typescript").Node): void => {
		if (found) return;
		if (ts.isIdentifier(node) && node.text === text) {
			found = node;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	if (!found) throw new Error(`identifier ${text} not found`);
	return found;
}

function parse(code: string) {
	return ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
}

describe("findDeclaredTypeForIdentifier", () => {
	it("finds a declared type on a function parameter", () => {
		const sf = parse(`
			function f(x: "a" | "b") {
				return x;
			}
		`);
		const ident = findIdentifier(sf, "x");
		const decl = findDeclaredTypeForIdentifier(ts, ident);
		expect(decl).not.toBeNull();
		expect(decl && ts.isUnionTypeNode(decl)).toBe(true);
	});

	it("finds a declared type on an arrow-function parameter", () => {
		const sf = parse(`
			const f = (y: "a" | "b") => y;
		`);
		const ident = findIdentifier(sf, "y");
		const decl = findDeclaredTypeForIdentifier(ts, ident);
		expect(decl).not.toBeNull();
	});

	it("finds a declared type on a local variable in a block", () => {
		const sf = parse(`
			function f() {
				const v: "a" | "b" = "a" as "a" | "b";
				return v;
			}
		`);
		const ident = findIdentifier(sf, "v");
		const decl = findDeclaredTypeForIdentifier(ts, ident);
		expect(decl).not.toBeNull();
	});

	it("finds a declared type on a module-level variable", () => {
		const sf = parse(`
			const top: "a" | "b" = "a" as "a" | "b";
			function f() {
				return top;
			}
		`);
		const ident = findIdentifier(sf, "top");
		const decl = findDeclaredTypeForIdentifier(ts, ident);
		expect(decl).not.toBeNull();
	});

	it("walks outward through nested scopes to find an outer declaration", () => {
		const sf = parse(`
			function outer(o: "a" | "b") {
				function inner() {
					return o;
				}
				return inner;
			}
		`);
		const ident = findIdentifier(sf, "o");
		const decl = findDeclaredTypeForIdentifier(ts, ident);
		expect(decl).not.toBeNull();
	});

	it("returns null when no declared type is found anywhere", () => {
		const sf = parse(`
			function f(z) {
				return z;
			}
		`);
		const ident = findIdentifier(sf, "z");
		const decl = findDeclaredTypeForIdentifier(ts, ident);
		expect(decl).toBeNull();
	});

	it("returns null for an identifier with no matching outer declaration (undeclared free var)", () => {
		const sf = parse(`
			function f() {
				return undeclaredVar;
			}
		`);
		const ident = findIdentifier(sf, "undeclaredVar");
		const decl = findDeclaredTypeForIdentifier(ts, ident);
		expect(decl).toBeNull();
	});
});
