import { describe, expect, it } from "vitest";
import { parseTsSource } from "../checks/cyclomatic-ast.js";
import { buildModelContext, type ScopeModel } from "./implicit-state-machine-model.js";
import { collectScopes } from "./implicit-state-machine-scopes.js";
import { collectWriterSites, type ScopeWrites, type WriterSite } from "./implicit-state-machine-writes.js";

function writes(src: string): { scope: ScopeModel; w: ScopeWrites } {
	const parsed = parseTsSource(src, "fixture.ts");
	if (!parsed) throw new Error("typescript is required for this suite");
	const ctx = buildModelContext(parsed.ts, parsed.sf, {});
	const scope = collectScopes(ctx)[0];
	if (!scope) throw new Error("no scope");
	return { scope, w: collectWriterSites(ctx, scope) };
}

function brief(sites: WriterSite[] | undefined): string[] {
	return (sites ?? []).map((s) => `${s.unit}=${s.value}${s.async ? `@${s.async}` : ""}${s.via ? `<${s.via}` : ""}`);
}

const OWNER = `
import type { ChildProcess } from "node:child_process";
type State = "idle" | "ready" | "dormant";
interface Status { state: State }
class Owner {
	private child: ChildProcess | null = null;
	private dormant = false;
	private status: Status = { state: "idle" };
	constructor() { this.dormant = false; }
	spawn(c: ChildProcess): void {
		this.child = c;
		this.dormant = false;
		c.on("exit", () => {
			this.child = null;
			this.setStatus({ state: "dormant" });
		});
	}
	async close(): Promise<void> {
		await Promise.resolve();
		this.child = null;
		try { this.dormant = true; } finally { this.markDormant(); }
	}
	private markDormant(): void { this.dormant = true; }
	private setStatus(patch: Partial<Status> & Pick<Status, "state">): void { this.status = { ...this.status, ...patch }; }
}`;

describe("collectWriterSites — positive (must fire)", () => {
	it("P1: labels writer units outermost-first and tags event, await and finally writers", () => {
		const { w } = writes(OWNER);
		expect(brief(w.sites.get("child"))).toEqual(["spawn=set", "spawn › on(exit)=null@event", "close=null@await"]);
		expect(brief(w.sites.get("dormant"))).toEqual([
			"spawn=false",
			"close=true@await",
			"markDormant=true",
			"close › finally=true@finally<markDormant",
		]);
	});
	it("P2: follows one level of this.method() and reads a state-like literal from the call's object argument", () => {
		const { w } = writes(OWNER);
		expect(brief(w.sites.get("status.state"))).toEqual(["spawn › on(exit)=\"dormant\"@event<setStatus"]);
	});
	it("P3: a method passed by reference to a timer runs as a timer writer", () => {
		const src = `class T {
	private on = false;
	private off = true;
	arm(): void { setTimeout(this.fire.bind(this), 10); }
	private fire(): void { this.on = true; this.off = false; }
}`;
		expect(brief(writes(src).w.sites.get("on"))).toEqual(["fire=true@timer"]);
	});
	it("P4: a factory closure attributes writes to its inner functions and promise continuations", () => {
		const src = `function make() {
	let running = false;
	let current: Promise<void> | null = null;
	function run(): void {
		running = true;
		current = work().then(() => { running = false; current = null; });
	}
	return { run };
}`;
		const { w } = writes(src);
		expect(brief(w.sites.get("running"))).toEqual(["run=true", "run › then(cb)=false@promise"]);
		expect(brief(w.sites.get("current"))).toEqual(["run=set", "run › then(cb)=null@promise"]);
		expect(w.units.get("run")).toEqual({ start: 4, end: 7 });
	});
	it("P5: a timer cleared and re-armed in the same writer is a debounce timer", () => {
		const src = `class D {
	private timer: ReturnType<typeof setTimeout> | null = null;
	poke(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => { this.timer = null; }, 5);
	}
}`;
		expect([...writes(src).w.debounce]).toEqual(["timer"]);
	});
});

describe("collectWriterSites — negative (must not fire)", () => {
	it("N1: constructor and factory-body writes are initialization, not writer sites", () => {
		const src = `function make() {
	let ready = false;
	ready = true;
	return { get ready() { return ready; } };
}`;
		expect(writes(src).w.sites.get("ready")).toBeUndefined();
		expect(writes(OWNER).w.sites.get("dormant")?.some((s) => s.unit === "constructor")).toBe(false);
	});
	it("N2: a timer that is armed with no clear or pending guard is not a debounce timer", () => {
		const src = `class D {
	private timer: ReturnType<typeof setTimeout> | null = null;
	start(): void { this.timer = setTimeout(() => this.stop(), 5); }
	stop(): void { this.timer = null; }
}`;
		expect([...writes(src).w.debounce]).toEqual([]);
	});
	it("N3: a write inside a synchronous finally block is not an async writer", () => {
		const src = `class S {
	private busy = false;
	run(): void { try { this.busy = true; } finally { this.busy = false; } }
}`;
		expect(brief(writes(src).w.sites.get("busy"))).toEqual(["run=true", "run › finally=false"]);
	});
});
