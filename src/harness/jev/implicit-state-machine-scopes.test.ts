import { describe, expect, it } from "vitest";
import { parseTsSource } from "../checks/cyclomatic-ast.js";
import { buildModelContext, type ModelContext, type ScopeModel } from "./implicit-state-machine-model.js";
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

describe("collectScopes — positive (must fire)", () => {
	it("P1: a class yields union (via alias), boolean, handle, inferred-literal and sub-field lifecycle fields", () => {
		const s = only(model(CLASS_SRC).scopes);
		expect(s).toMatchObject({ kind: "class", name: "Owner" });
		const kinds = Object.fromEntries([...s.fields.values()].map((f) => [f.name, f.kind]));
		expect(kinds).toEqual({
			child: "handle",
			timer: "handle",
			phase: "union",
			ready: "boolean",
			"status.state": "union",
			label: "union",
			retries: "boolean",
		});
		expect(s.fields.get("phase")?.domain).toEqual(['"idle"', '"running"', '"done"']);
		expect(s.fields.get("label")).toMatchObject({ inferred: true, domain: [], initial: '"a"' });
		expect(s.fields.get("status.state")?.initial).toBe('"idle"');
		expect([...s.containers]).toEqual(["status"]);
	});
	it("P2: a factory whose returned object has a method keeps its let bindings as fields", () => {
		const src = `export function make() {
	let running = false;
	let current: Promise<void> | null = null;
	const k = 1;
	function go(): void { running = true; }
	return { go, get busy() { return running; } };
}`;
		const s = only(model(src).scopes);
		expect(s).toMatchObject({ kind: "factory", name: "make" });
		expect([...s.fields.keys()]).toEqual(["running", "current"]);
	});
	it("P3: an interface written through a typed parameter is a record scope", () => {
		const src = `interface Gate { active: boolean; draining: boolean; readonly key: string }
function open(g: Gate): void { g.active = true; }`;
		const s = only(model(src).scopes);
		expect(s).toMatchObject({ kind: "record", name: "Gate" });
		expect([...s.fields.keys()]).toEqual(["active", "draining"]);
	});
	it("P4: the nullableSlots variant adds a nullable object reference as a slot", () => {
		const src = `class Q { private next: { file: string } | null = null; }`;
		expect(only(model(src, true).scopes).fields.get("next")?.kind).toBe("slot");
	});
	it("P5: a record field reference resolves only through a declaration typed with the record", () => {
		const src = `interface Gate { active: boolean }
function make(): Gate { return { active: false }; }
function a() { const g = make(); g.active = true; }
function b(other: { active: boolean }) { other.active = true; }`;
		const { ctx, scopes } = model(src);
		const s = only(scopes);
		const hits: number[] = [];
		const visit = (n: import("typescript").Node): void => {
			if (ctx.ts.isPropertyAccessExpression(n) && s.fieldOf(n) !== null) hits.push(ctx.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1);
			ctx.ts.forEachChild(n, visit);
		};
		visit(ctx.sf);
		expect(hits).toEqual([3]);
	});
});

describe("collectScopes — negative (must not fire)", () => {
	it("N1: a function that returns plain data (no function member) is not a factory scope", () => {
		expect(model(`function parse() { let i = 0; let open = false; return { i, open }; }`).scopes).toEqual([]);
	});
	it("N2: an interface no declaration in the file is typed with is not a record scope", () => {
		expect(model(`export interface Cfg { mode: "block" | "warn" | "off"; on: boolean }`).scopes).toEqual([]);
	});
	it("N3: without the variant a nullable object reference is not a lifecycle field", () => {
		expect(model(`class Q { private next: { file: string } | null = null; }`).scopes).toEqual([]);
	});
	it("N4: readonly, static, numeric and string-typed members are not lifecycle fields", () => {
		const src = `class C { readonly a = true; static b = false; private n = 0; private s: string | null = null; }`;
		expect(model(src).scopes).toEqual([]);
	});
});
