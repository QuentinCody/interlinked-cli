import { describe, expect, it } from "vitest";
import { parseTsSource } from "../checks/cyclomatic-ast.js";
import {
	buildModelContext,
	declaredNames,
	leadingDoc,
	literalOf,
	plainValue,
	refOf,
	type ModelContext,
	type ScopeModel,
	stateProps,
	unwrap,
} from "./implicit-state-machine-model.js";
import { collectScopes } from "./implicit-state-machine-scopes.js";

function model(src: string, nullableSlots = false): { ctx: ModelContext; scopes: ScopeModel[] } {
	const parsed = parseTsSource(src, "fixture.ts");
	if (!parsed) throw new Error("typescript is required for this suite");
	const ctx = buildModelContext(parsed.ts, parsed.sf, { nullableSlots });
	return { ctx, scopes: collectScopes(ctx) };
}

function only(scopes: ScopeModel[]): ScopeModel {
	expect(scopes).toHaveLength(1);
	const s = scopes[0];
	if (!s) throw new Error("no scope");
	return s;
}

const CLASS_SRC = `
import type { ChildProcess } from "node:child_process";
/** Phase doc. */
type Phase = "idle" | "running" | "done";
const RUNNING: Phase = "running";
interface Status { state: Phase; detail?: string }
/** Owns one child. */
export class Owner {
	private child: ChildProcess | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private phase: Phase = "idle";
	private ready = false;
	private status: Status = { state: "idle" };
	private readonly fixed = true;
	private label = "a";
	private count = 0;
	constructor(private retries: boolean) {}
	start(): void { this.phase = RUNNING; this.status = { ...this.status, state: "running" }; }
}
`;

describe("refOf / declaredNames", () => {
	it("P1: resolves this.f, this.container.state and ignores a this inside a nested function expression", () => {
		const { ctx, scopes } = model(CLASS_SRC);
		const s = only(scopes);
		const found: string[] = [];
		const visit = (n: import("typescript").Node): void => {
			const r = refOf(ctx, s, n);
			if (r !== null) found.push(r);
			ctx.ts.forEachChild(n, visit);
		};
		visit(s.node);
		expect(found).toContain("phase");
		expect(found).toContain("status");
	});
	it("N1: a factory binding shadowed by an inner parameter is not a field reference", () => {
		const src = `function make() {
	let running = false;
	function set(running: boolean) { running = true; }
	return { set };
}`;
		const { ctx, scopes } = model(src);
		const s = only(scopes);
		const fn = [...declaredNames(ctx, s.node).values()].find((d) => ctx.ts.isFunctionDeclaration(d));
		expect(fn && declaredNames(ctx, fn).has("running")).toBe(true);
		const writes: string[] = [];
		const visit = (n: import("typescript").Node): void => {
			if (ctx.ts.isBinaryExpression(n)) {
				const r = refOf(ctx, s, n.left);
				if (r !== null) writes.push(r);
			}
			ctx.ts.forEachChild(n, visit);
		};
		visit(s.node);
		expect(writes).toEqual([]);
	});
});

describe("value helpers", () => {
	it("P1: literalOf / plainValue / unwrap / stateProps normalize literals, consts, null and booleans", () => {
		const { ctx } = model(`const K = "k";\nconst a = (("x")) as string;\nconst o = { state: K, other: 1 };\nlet z = undefined; let t = true;`);
		const decls = ctx.sf.statements.flatMap((st) => (ctx.ts.isVariableStatement(st) ? [...st.declarationList.declarations] : []));
		const init = (i: number) => {
			const e = decls[i]?.initializer;
			if (!e) throw new Error("missing initializer");
			return e;
		};
		expect(literalOf(ctx, init(1))).toBe('"x"');
		expect(ctx.ts.isStringLiteral(unwrap(ctx.ts, init(1)))).toBe(true);
		expect(stateProps(ctx, init(2))).toEqual([["state", '"k"']]);
		expect(plainValue(ctx, init(3))).toBe("null");
		expect(plainValue(ctx, init(4))).toBe("true");
	});
	it("P2: leadingDoc returns the JSDoc above a class and above a variable-held factory", () => {
		const { ctx, scopes } = model(`${CLASS_SRC}\n/** Factory doc. */\nexport const mk = () => { let on = false; let off = true; return { f() { on = !off; } }; };`);
		const docs = scopes.map((s) => leadingDoc(ctx, s.node));
		expect(docs[0]).toContain("Owns one child");
		expect(docs[1]).toContain("Factory doc");
	});
	it("N1: leadingDoc returns null when only a line comment precedes the node", () => {
		const { ctx, scopes } = model(`// not a doc\nclass C { private on = false; }`);
		expect(leadingDoc(ctx, only(scopes).node)).toBeNull();
	});
});
