import { describe, expect, it } from "vitest";
import { detectStaleHandleHandlers } from "./implicit-state-machine-stale.js";

const HEAD = `import type { ChildProcess } from "node:child_process";\n`;

/** A multi-generation owner: ensureSpawned stores a NEW child each time and shutdown clears it. */
function owner(handler: string, extra = ""): string {
	return `${HEAD}export class Owner {
	private child: ChildProcess | null = null;
	private dormant = false;
	private gen = 0;
	constructor(private readonly spawnFn: () => ChildProcess) {}
	shutdown(): void { this.child?.kill(); this.child = null; }
	private ensureSpawned(): void {
		const child = this.spawnFn();
		const gen = ++this.gen;
		this.child = child;
		this.dormant = false;
		${handler}
	}
	${extra}
}`;
}

describe("detectStaleHandleHandlers — positive (must fire)", () => {
	it("P1: an exit handler on the captured child clears the field with no identity guard", () => {
		const src = owner(`child.on("exit", () => { this.child = null; this.dormant = true; });`);
		const f = detectStaleHandleHandlers(src, "owner.ts");
		expect(f).toHaveLength(1);
		expect(f[0]).toMatchObject({ scope: "Owner", field: "child", handle: "child", event: "exit", line: 13, writes: ["child", "dormant"], reassignedAt: [11] });
	});
	it("P2: the handler writes the field through its direct callee", () => {
		const src = owner(`child.once("error", () => this.markGone());`, `private markGone(): void { this.child = null; }`);
		expect(detectStaleHandleHandlers(src, "owner.ts").map((x) => [x.event, x.writes])).toEqual([["error", ["child"]]]);
	});
	it("P3: a factory closure that re-spawns into a let binding has the same defect", () => {
		const src = `${HEAD}export function makeOwner(spawnFn: () => ChildProcess) {
	let child: ChildProcess | null = null;
	let ready = false;
	function start(): void {
		const c = spawnFn();
		child = c;
		c.on("exit", () => { child = null; ready = false; });
	}
	return { start, stop(): void { child?.kill(); child = null; } };
}`;
		expect(detectStaleHandleHandlers(src, "f.ts").map((x) => [x.scope, x.field, x.handle])).toEqual([["makeOwner", "child", "c"]]);
	});
});

describe("detectStaleHandleHandlers — negative (must not fire)", () => {
	it("N1: an identity guard in the handler (this.child !== child) protects the new generation", () => {
		const src = owner(`child.on("exit", () => { if (this.child !== child) return; this.child = null; });`);
		expect(detectStaleHandleHandlers(src, "owner.ts")).toEqual([]);
	});
	it("N2: the guard sits in the direct callee that receives the handle", () => {
		const src = owner(`child.on("exit", () => this.onExit(child));`, `private onExit(c: ChildProcess): void { if (this.child === c) this.child = null; }`);
		expect(detectStaleHandleHandlers(src, "owner.ts")).toEqual([]);
	});
	it("N3: a generation-token comparison is an identity guard", () => {
		const src = owner(`child.on("exit", () => { if (gen !== this.gen) return; this.child = null; });`);
		expect(detectStaleHandleHandlers(src, "owner.ts")).toEqual([]);
	});
	it("N4: a one-object-per-handle wrapper (handle set only in the constructor) is exempt", () => {
		const src = `${HEAD}export class Run {
	private child: ChildProcess | null;
	private settled = false;
	constructor(child: ChildProcess) { this.child = child; }
	start(): void {
		const c = this.child;
		c?.on("exit", () => { this.settled = true; this.child = null; });
		this.child?.on("close", () => { this.child = null; });
	}
}`;
		expect(detectStaleHandleHandlers(src, "run.ts")).toEqual([]);
	});
	it("N5: a handler that writes no lifecycle field is not stale", () => {
		const src = owner(`child.once("exit", () => { console.log("bye"); });`);
		expect(detectStaleHandleHandlers(src, "owner.ts")).toEqual([]);
	});
});
