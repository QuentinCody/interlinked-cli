import { describe, expect, it } from "vitest";
import { executesAtModuleLoad, findTopLevelSideEffects } from "./module-load-side-effects.js";
import { parseTsSource } from "./cyclomatic-ast.js";
import type * as TS from "typescript";

const n = (s: string, f = "src/commands/foo.ts") => findTopLevelSideEffects(s, f).length;

describe("findTopLevelSideEffects", () => {
	it("shares execution ancestry for an explicitly entered callback scope", () => {
		const parsed = parseTsSource("const callback = () => { fetch(url); const deferred = () => fetch(later); };", "scope.ts");
		if (!parsed) throw new Error("TypeScript fixture parser unavailable");
		const calls: TS.CallExpression[] = [], callbacks: TS.Node[] = [];
		const visit = (node: TS.Node): void => {
			if (parsed.ts.isCallExpression(node)) calls.push(node);
			if (parsed.ts.isArrowFunction(node)) callbacks.push(node);
			parsed.ts.forEachChild(node, visit);
		};
		visit(parsed.sf);
		const direct = calls[0], deferred = calls[1], scope = callbacks[0];
		if (!direct || !deferred || !scope) throw new Error("Execution fixture nodes unavailable");
		expect(executesAtModuleLoad(direct, parsed)).toBe(false);
		expect(executesAtModuleLoad(direct, parsed, scope)).toBe(true);
		expect(executesAtModuleLoad(deferred, parsed, scope)).toBe(false);
	});
	it("P1: follows an immediately invoked function through parentheses", () => {
		expect(n("const request = (() => fetch(url))();")).toBe(1);
		expect(n("  if (enabled) {\n    readFileSync(path);\n  }")).toBe(1);
	});
	it("P2: recognizes class static initialization but not instance initialization", () => {
		expect(n("class Service { static config = readFileSync(path); config = readFileSync(path); }")).toBe(1);
	});
	it("N2: interface methods and deferred callback bodies do not execute", () => {
		expect(n("export interface Worker { fetch(request: Request): Promise<Response>; }")).toBe(0);
		expect(n("const worker = { fetch() { return fetch(url); } };\nconst load = () => fetch(url);")).toBe(0);
	});
	// ── positives: I/O executed at module-load (top level) ───────────────────
	it("flags a top-level readFileSync", () => {
		expect(n('const data = readFileSync("./config.json", "utf8");')).toBeGreaterThanOrEqual(1);
	});
	it("flags a top-level server .listen()", () => {
		expect(n("appServer.listen(3000);")).toBeGreaterThanOrEqual(1);
	});
	it("flags a top-level await fetch", () => {
		expect(n('const res = await fetch("https://example.com/seed");')).toBeGreaterThanOrEqual(1);
	});

	// ── negatives: deferred / boundary / non-execution ───────────────────────
	it("does not flag the same call inside a function body", () => {
		expect(n("function load() {\n\treturn readFileSync(p);\n}")).toBe(0);
	});
	it("does not flag a function definition whose body calls I/O (deferred)", () => {
		expect(n("const load = () => readFileSync(p);")).toBe(0);
	});
	it("does not flag top-level I/O in an entrypoint module", () => {
		expect(n('const data = readFileSync("./c.json");', "src/index.ts")).toBe(0);
		expect(n("httpServer.listen(8080);", "src/harness/server.ts")).toBe(0);
	});
	it("does not flag I/O-call text inside a string literal", () => {
		expect(n('const note = "remember to call readFileSync at startup";')).toBe(0);
	});
	it("N1: does not flag top-level I/O in a hook-entry entrypoint module", () => {
		expect(n('const cfg = readFileSync("./c.json");', "src/hook-entry.ts")).toBe(0);
	});
});
