import { describe, expect, it } from "vitest";
import {
	explainStateMachineScopes,
	type ScopeVerdict,
	selectStateMachineCandidates,
	stateMachineSelectorAvailable,
} from "./implicit-state-machine-select.js";

function verdict(src: string, scope: string): ScopeVerdict {
	const v = (explainStateMachineScopes(src, "fixture.ts") ?? []).find((x) => x.candidate.scope === scope);
	if (!v) throw new Error(`no scope ${scope}`);
	return v;
}

const HELPER = `
import type { ChildProcess } from "node:child_process";
/** Lifecycle: idle, spawning, ready, dormant; disabled is permanent. */
type State = "idle" | "spawning" | "ready" | "dormant" | "disabled";
/** Runs one helper process. */
export class Helper {
	private child: ChildProcess | null = null;
	/** Set by shutdown() only. */
	private disposed = false;
	/** Set by idle close or unexpected exit. */
	private dormant = false;
	private state: State = "idle";
	constructor(private readonly spawnFn: () => ChildProcess) {}
	send(): void {
		if (this.disposed) return;
		if (!this.child) this.ensureSpawned();
	}
	shutdown(): void {
		this.disposed = true;
		this.state = "disabled";
		this.child?.kill();
		this.child = null;
	}
	private ensureSpawned(): void {
		const child = this.spawnFn();
		this.child = child;
		this.dormant = false;
		this.state = "spawning";
		child.on("exit", () => {
			this.child = null;
			this.dormant = true;
			this.state = "dormant";
		});
	}
	closeForIdle(): void {
		this.dormant = true;
		this.child?.kill();
	}
}`;

describe("explainStateMachineScopes — positive (must fire)", () => {
	it("P1: a multi-writer, async-written lifecycle class fires with its field table", () => {
		const v = verdict(HELPER, "Helper");
		expect(v.reason).toBe("fires");
		const table = v.candidate.fields.map((f) => [f.name, f.kind, f.writers, f.asyncWriter, f.latch]);
		expect(table).toEqual([
			["child", "handle", 4, true, false],
			["disposed", "boolean", 1, false, true],
			["dormant", "boolean", 4, true, false],
			["state", "union", 4, true, false],
		]);
		expect(v.candidate.doc).toContain("Runs one helper process");
		expect(v.candidate.doc).toContain("disabled is permanent");
		expect(v.candidate.units.map((u) => u.name)).toEqual(["shutdown", "ensureSpawned", "closeForIdle", "send"]);
	});
	it("P2: combinations put the union first, stay within 16, and record which writers assign them", () => {
		const c = verdict(HELPER, "Helper").candidate;
		expect(c.combinations).toHaveLength(10);
		expect(Object.keys(c.combinations[0]?.values ?? {})).toEqual(["state", "child"]);
		expect(c.omittedFromCombinations).toEqual(["dormant", "disposed"]);
		const live = c.combinations.find((x) => x.values.state === '"spawning"' && x.values.child === "set");
		expect(live?.assignedBy).toEqual(["ensureSpawned", "send"]);
		const impossible = c.combinations.find((x) => x.values.state === '"disabled"' && x.values.child === "set");
		expect(impossible?.assignedBy).toEqual([]);
	});
	it("P3: selectStateMachineCandidates returns only the firing scopes", () => {
		expect(selectStateMachineCandidates(HELPER, "fixture.ts").map((c) => c.scope)).toEqual(["Helper"]);
		expect(stateMachineSelectorAvailable()).toBe(true);
	});
});

describe("explainStateMachineScopes — negative (must not fire)", () => {
	it("N1: fewer than three lifecycle fields → too-few-fields", () => {
		const src = `class A { private on = false; private t: ReturnType<typeof setTimeout> | null = null;
	a(): void { this.on = true; this.t = setTimeout(() => { this.on = false; this.t = null; }, 1); }
	b(): void { this.on = false; this.t = null; } }`;
		expect(verdict(src, "A").reason).toBe("too-few-fields");
	});
	it("N2: every write inside one method (a reducer without a union) → single-writer-function", () => {
		const src = `class R { private a = false; private b = false; private c: "x" | "y" = "x";
	apply(ev: string): void { this.a = ev === "a"; this.b = true; setTimeout(() => { this.c = "y"; this.b = false; }, 1); this.c = "x"; } }`;
		expect(verdict(src, "R").reason).toBe("single-writer-function");
	});
	it("N3: a class that drives a discriminated-union reducer → explicit-txn", () => {
		const src = `type Txn = { kind: "start" } | { kind: "stop" };
interface Box { n: number }
function apply(box: Box, txn: Txn): void { switch (txn.kind) { case "start": box.n++; break; case "stop": box.n--; break; } }
export class Engine {
	private running = false; private stopped = false; private timer: ReturnType<typeof setTimeout> | null = null;
	private box: Box = { n: 0 };
	start(): void { apply(this.box, { kind: "start" }); this.running = true; this.timer = setTimeout(() => { this.running = false; this.timer = null; }, 5); }
	stop(): void { this.stopped = true; this.running = false; this.timer = null; }
}`;
		expect(verdict(src, "Engine").reason).toBe("explicit-txn");
	});
	it("N4: an exhaustive switch with a never check on a lifecycle union → exhaustive-switch", () => {
		const src = `type Phase = "idle" | "busy";
export class Engine {
	private running = false; private phase: Phase = "idle"; private timer: ReturnType<typeof setTimeout> | null = null;
	start(): void { this.phase = "busy"; this.running = true; this.timer = setTimeout(() => { this.running = false; this.timer = null; this.phase = "idle"; }, 5); }
	stop(): void { this.phase = "idle"; this.running = false; this.timer = null; }
	label(): string { switch (this.phase) { case "idle": return "i"; case "busy": return "b"; default: { const never: never = this.phase; return never; } } }
}`;
		expect(verdict(src, "Engine").reason).toBe("exhaustive-switch");
	});
	it("N5: one-shot latches do not count as multi-writer fields → few-multi-writer-fields", () => {
		const src = `class Run {
	private settled = false; private killed = false; private timer: ReturnType<typeof setTimeout> | null = null;
	start(): void { this.timer = setTimeout(() => { this.killed = true; this.settled = true; this.timer = null; }, 5); }
	kill(): void { this.killed = true; }
	finish(): void { this.settled = true; this.timer = null; }
}`;
		const v = verdict(src, "Run");
		expect(v.reason).toBe("few-multi-writer-fields");
		expect(v.candidate.fields.filter((f) => f.latch).map((f) => f.name)).toEqual(["settled", "killed"]);
	});
	it("N6: multi-writer fields with no async writer → no-async-writer", () => {
		const src = `class Sync { private a = false; private b = false; private c = false;
	x(): void { this.a = true; this.b = true; this.c = true; }
	y(): void { this.a = false; this.b = false; this.c = false; } }`;
		expect(verdict(src, "Sync").reason).toBe("no-async-writer");
	});
	it("N7: a debounce timer and a non-literal write to an inferred union leave the field table", () => {
		const src = `class W { private timer: ReturnType<typeof setTimeout> | null = null; private mode = "a"; private on = false;
	poke(next: string): void { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = null; this.on = true; }, 1); this.mode = next; }
	stop(): void { this.on = false; this.mode = "b"; } }`;
		const v = verdict(src, "W");
		expect(v.candidate.excludedFields).toEqual([
			{ name: "timer", reason: "debounce" },
			{ name: "mode", reason: "non-literal-write" },
		]);
		expect(v.reason).toBe("too-few-fields");
	});
});
