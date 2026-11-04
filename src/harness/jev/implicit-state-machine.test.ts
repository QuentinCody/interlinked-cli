import { describe, expect, it, vi } from "vitest";
import { JevClient } from "./client.js";
import {
	buildStateMachinePacket,
	describeCombination,
	detectStaleHandleHandlers,
	explainStateMachineScopes,
	formatStaleHandleFindings,
	formatStateMachineCandidates,
	formatStateMachineFindings,
	STATE_MACHINE_PACKET_MAX_BYTES,
	STATE_MACHINE_QUESTIONS,
	type StateMachineCandidate,
	scoreStateMachines,
	selectStateMachineCandidates,
	stateMachineQuestionsFor,
} from "./implicit-state-machine.js";

const scopes = (src: string, nullableSlots = false): string[] =>
	selectStateMachineCandidates(src, "fixture.ts", { nullableSlots }).map((c) => c.scope);
const reasonOf = (src: string, scope: string, nullableSlots = false): string | undefined =>
	explainStateMachineScopes(src, "fixture.ts", { nullableSlots })?.find((v) => v.candidate.scope === scope)?.reason;
const lineWith = (src: string, needle: string): number => src.split("\n").findIndex((l) => l.includes(needle)) + 1;

// ---- report P-case reductions (A-state-machines.md) -------------------------

/** P1 SidecarManager: status.state + booted/disposed/dormant + child; the exit handler has no identity guard. */
const SIDECAR = `import type { ChildProcess } from "node:child_process";
/** idle | spawning | ready | dormant | disabled — disabled is permanent. */
export type SidecarLifecycleState = "idle" | "spawning" | "ready" | "dormant" | "disabled";
interface SidecarStatus { state: SidecarLifecycleState; pid?: number }
export class SidecarManager {
	private child: ChildProcess | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private booted = false;
	/** Set by shutdown() only. Once true, this instance is permanently dead. */
	private disposed = false;
	/** Transient: set by idle-close or unexpected exit. */
	private dormant = false;
	private status: SidecarStatus = { state: "idle" };
	constructor(private readonly spawnFn: () => ChildProcess, private readonly idleMs: number) {}
	send(line: string): void {
		if (this.disposed) return;
		this.ensureSpawned();
		this.child?.stdin?.write(line);
		this.resetIdleTimer();
	}
	async shutdown(): Promise<void> {
		this.disposed = true;
		if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
		this.setStatus({ state: "disabled" });
		const child = this.child;
		if (!child) return;
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		this.child = null;
	}
	private ensureSpawned(): void {
		if (this.child && !this.child.killed) return;
		this.dormant = false;
		const child = this.spawnFn();
		this.child = child;
		this.booted = false;
		this.setStatus({ state: "spawning", pid: child.pid });
		child.stdout?.on("data", () => this.onFirstResponse());
		child.on("exit", () => {
			this.child = null;
			this.dormant = true;
			this.setStatus({ state: "dormant" });
		});
	}
	private onFirstResponse(): void {
		if (this.booted) return;
		this.booted = true;
		this.setStatus({ state: "ready" });
	}
	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => { void this.closeChildForIdle(); }, this.idleMs);
	}
	private async closeChildForIdle(): Promise<void> {
		if (!this.child || this.disposed) return;
		this.dormant = true;
		this.child.kill();
	}
	private setStatus(patch: Partial<SidecarStatus> & Pick<SidecarStatus, "state">): void {
		this.status = { ...this.status, ...patch };
	}
}`;

/** P2 createAsyncAnalysisManager: running + pendingRequest (nullable record) + currentPromise, coalesced in finally. */
const ASYNC_ANALYSIS = `export function createAsyncAnalysisManager() {
	let running = false;
	let pendingRequest: { file: string; fn: () => Promise<string[]> } | null = null;
	let currentPromise: Promise<void> | null = null;
	async function runAnalysis(file: string, fn: () => Promise<string[]>): Promise<void> {
		running = true;
		try { await fn(); } finally {
			running = false;
			if (pendingRequest) { const next = pendingRequest; pendingRequest = null; currentPromise = runAnalysis(next.file, next.fn); }
			else currentPromise = null;
		}
	}
	return {
		submit(file: string, fn: () => Promise<string[]>): void {
			if (running) pendingRequest = { file, fn };
			else currentPromise = runAnalysis(file, fn);
		},
		async drain(): Promise<void> { if (currentPromise) await currentPromise; },
	};
}`;

/** P3 createSocketLifecycle, reduced with a close-event writer: shuttingDown + closed + server + pid timer. */
const SOCKET_LIFECYCLE = `import type { Server } from "node:net";
export function createSocketLifecycle(listen: () => Server) {
	let server: Server | null = null;
	let shuttingDown = false;
	let closed = false;
	let pidHealTimer: ReturnType<typeof setInterval> | null = null;
	function start(): void {
		if (shuttingDown) return;
		server = listen();
		closed = false;
		pidHealTimer = setInterval(() => undefined, 60_000);
		server.on("close", () => { closed = true; server = null; });
	}
	async function shutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		if (pidHealTimer) { clearInterval(pidHealTimer); pidHealTimer = null; }
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = null;
		closed = true;
	}
	return { start, shutdown };
}`;

/** P4 WatchProcess: _state via named consts + child + stopPromise + passInProgress; handlers ARE identity-guarded. */
const WATCH_PROCESS = `import type { ChildProcess } from "node:child_process";
export type WatchProcessState = "not-started" | "running" | "idle-evicted" | "crashed";
export const WATCH_RUNNING: WatchProcessState = "running";
export const WATCH_CRASHED: WatchProcessState = "crashed";
export class WatchProcess {
	private child: ChildProcess | null = null;
	private _state: WatchProcessState = "not-started";
	private passInProgress = false;
	private stopPromise: Promise<void> | null = null;
	constructor(private readonly spawnFn: () => ChildProcess) {}
	start(): void {
		const child = this.spawnFn();
		this.child = child;
		this._state = WATCH_RUNNING;
		child.stdout?.on("data", (b: Buffer) => this.ingest(String(b)));
		child.on("exit", () => { if (this.child === child) this.markCrashed(); });
	}
	kill(): Promise<void> {
		const child = this.child;
		this.child = null;
		this._state = "idle-evicted";
		this.stopPromise = new Promise<void>((resolve) => { child?.once("exit", () => resolve()); }).finally(() => { this.stopPromise = null; });
		return this.stopPromise;
	}
	private markCrashed(): void { this.child = null; this.stopPromise = null; this._state = WATCH_CRASHED; }
	private ingest(line: string): void {
		if (line.includes("starting")) this.passInProgress = true;
		if (line.includes("finished")) this.passInProgress = false;
	}
}`;

/** P5 ReservationManager.releaseTimers: the machine is one Map entry per reservation. */
const RELEASE_TIMERS = `export class ReservationManager {
	private releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private shuttingDown = false;
	scheduleRelease(key: string): void {
		this.cancel(key);
		this.releaseTimers.set(key, setTimeout(() => { this.releaseTimers.delete(key); this.release(key); }, 1000));
	}
	cancel(key: string): void { const t = this.releaseTimers.get(key); if (t) clearTimeout(t); this.releaseTimers.delete(key); }
	shutdown(): void { this.shuttingDown = true; for (const t of this.releaseTimers.values()) clearTimeout(t); this.releaseTimers.clear(); }
	private release(key: string): void { void key; }
}`;

/** check-engine/spawn-async.ts shape: one wrapper object per child process. */
const ONE_OBJECT_PER_HANDLE = `import type { ChildProcess } from "node:child_process";
export class SpawnedProcessRun {
	private child: ChildProcess | null;
	private settled = false;
	private killed = false;
	private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	constructor(child: ChildProcess) { this.child = child; }
	start(): void {
		const child = this.child;
		this.timeoutTimer = setTimeout(() => { this.killed = true; child?.kill(); }, 1000);
		child?.on("exit", () => { this.settled = true; this.child = null; this.timeoutTimer = null; });
	}
}`;

describe("selectStateMachineCandidates — positive (must fire)", () => {
	it("P1: the SidecarManager reduction (status + booleans + child) fires with status.state as a union field", () => {
		const [c] = selectStateMachineCandidates(SIDECAR, "sidecar.ts");
		expect(c?.scope).toBe("SidecarManager");
		expect(c?.fields.map((f) => f.name)).toEqual(["child", "booted", "disposed", "dormant", "status.state"]);
		expect(c?.excludedFields).toEqual([{ name: "idleTimer", reason: "debounce" }]);
		expect(c?.doc).toContain("disabled is permanent");
	});
	it("P2: the async-analysis reduction fires under the nullableSlots variant (pendingRequest is a nullable record)", () => {
		expect(scopes(ASYNC_ANALYSIS, true)).toEqual(["createAsyncAnalysisManager"]);
	});
	it("P3: the socket-lifecycle reduction (shuttingDown / closed / server) fires", () => {
		expect(scopes(SOCKET_LIFECYCLE)).toEqual(["createSocketLifecycle"]);
	});
	it("P4: the WatchProcess reduction fires; its union values come from named consts", () => {
		const [c] = selectStateMachineCandidates(WATCH_PROCESS, "watch.ts");
		expect(c?.scope).toBe("WatchProcess");
		const state = c?.fields.find((f) => f.name === "_state");
		expect(new Set(state?.writerSites.map((s) => s.value))).toEqual(new Set(['"running"', '"idle-evicted"', '"crashed"']));
	});
});

describe("selectStateMachineCandidates — known gaps (pinned, not positives)", () => {
	it("G1: a Map of timers (ReservationManager.releaseTimers) is not seen; the report says the composite misses it", () => {
		expect(reasonOf(RELEASE_TIMERS, "ReservationManager")).toBe("too-few-fields");
	});
	it("G2: the strict design misses the async-analysis reduction (pendingRequest is not a handle)", () => {
		expect(reasonOf(ASYNC_ANALYSIS, "createAsyncAnalysisManager")).toBe("too-few-fields");
	});
});

// ---- report negatives (N1–N10 + FP sources) ---------------------------------

const NEGATIVES: Array<[string, string]> = [
	[
		"N1: a config mode enum read but never written",
		`export interface GuardConfig { mode: "block" | "warn" | "off"; enabled: boolean }
export function loadConfig(): GuardConfig { return { mode: "warn", enabled: true }; }
export function isBlocking(): boolean { const cfg = loadConfig(); return cfg.enabled && cfg.mode === "block"; }`,
	],
	[
		"N2: a phase classification tag set once at construction",
		`export interface Finding { phase: "pre" | "post"; check: string; blocking: boolean }
export function classify(check: string): Finding { const f: Finding = { phase: "pre", check, blocking: false }; return f; }
export function promote(f: Finding): Finding { return { ...f, phase: "post" }; }`,
	],
	[
		"N3: an immutable result status written in one function",
		`export interface CheckResult { status: "passed" | "failed" | "unavailable"; timedOut: boolean; cached: boolean }
export function finish(code: number | null): CheckResult {
	const result: CheckResult = { status: "passed", timedOut: false, cached: false };
	if (code === null) { result.status = "unavailable"; result.timedOut = true; }
	else if (code !== 0) result.status = "failed";
	setTimeout(() => { result.cached = true; }, 0);
	return result;
}`,
	],
	[
		"N4: a one-shot settled latch in a promise wrapper",
		`import type { Socket } from "node:net";
export function waitForReady(socket: Socket, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		const finish = (ok: boolean): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok && !timedOut); };
		const timer = setTimeout(() => { timedOut = true; finish(false); }, timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}`,
	],
	[
		"N5: a debounce timer beside a re-entrancy guard and a cancel flag",
		`export function createStripDebouncer(run: () => void, debounceMs: number) {
	let pendingTimer: ReturnType<typeof setTimeout> | null = null;
	let stripInFlight = false;
	let cancelled = false;
	const runStrip = (): void => {
		if (stripInFlight) return;
		stripInFlight = true;
		try { run(); } finally { stripInFlight = false; }
	};
	const trigger = (): void => {
		cancelled = false;
		if (pendingTimer !== null) clearTimeout(pendingTimer);
		pendingTimer = setTimeout(() => { pendingTimer = null; runStrip(); }, debounceMs);
	};
	const cancel = (): void => { cancelled = true; if (pendingTimer !== null) { clearTimeout(pendingTimer); pendingTimer = null; } };
	return { trigger, cancel, get cancelled() { return cancelled; } };
}`,
	],
	[
		"N6: a memoized lazy-import promise",
		`export function createDeps() {
	let modPromise: Promise<typeof import("node:fs")> | null = null;
	let loaded = false;
	let failed = false;
	function load(): Promise<typeof import("node:fs")> {
		modPromise ??= import("node:fs").then((m) => { loaded = true; return m; }).catch((e: unknown) => { modPromise = null; failed = true; throw e; });
		return modPromise;
	}
	return { load, get ready() { return loaded && !failed; } };
}`,
	],
	[
		"N7: a function-local socket in an RPC helper",
		`import { createConnection, type Socket } from "node:net";
export function callOverSocket(path: string, request: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let socket: Socket | null = null;
		let settled = false;
		let pending = "";
		const finish = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); socket?.destroy(); socket = null; fn(); };
		const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs);
		socket = createConnection(path, () => socket?.write(request));
		socket.on("data", (b: Buffer) => { pending += String(b); finish(() => resolve(pending)); });
		socket.on("error", (e: Error) => finish(() => reject(e)));
	});
}`,
	],
	[
		"N8: an orthogonal re-entrancy guard and stop latch",
		`export function startBackground(tickWork: () => Promise<void>, intervalMs: number) {
	let running = false;
	let stopped = false;
	const tick = async (): Promise<void> => {
		if (stopped || running) return;
		running = true;
		try { await tickWork(); } finally { running = false; }
	};
	const timer = setInterval(() => { void tick(); }, intervalMs);
	return { tick, stop: (): void => { if (stopped) return; stopped = true; clearInterval(timer); } };
}`,
	],
	[
		"N9: a central reducer without a union (one function writes every field)",
		`interface TddCycleState { phase: "red" | "green" | "refactor"; failing: boolean; armed: boolean; red_at?: string }
export function updateCycleFromTestRun(state: TddCycleState, passed: boolean, now: string): void {
	if (!passed) { state.phase = "red"; state.red_at = now; state.failing = true; state.armed = true; return; }
	state.failing = false;
	if (state.phase === "red") state.phase = "green";
	setTimeout(() => { state.armed = false; }, 10);
}
export function onRun(state: TddCycleState, passed: boolean): void { updateCycleFromTestRun(state, passed, new Date().toISOString()); }
export function onRefactor(state: TddCycleState): void { if (state.phase === "green") updateCycleFromTestRun(state, true, ""); }`,
	],
	[
		"N10: a versioned append-only record",
		`type EdgeState = "proposed" | "confirmed" | "rejected" | "stale";
interface EdgeRecord { id: string; state: EdgeState; version: number; confirmed: boolean }
const STATE_FOR_VERDICT: Record<string, EdgeState> = { yes: "confirmed", no: "rejected" };
export function confirm(prev: EdgeRecord, verdict: string): EdgeRecord {
	return { ...prev, state: STATE_FOR_VERDICT[verdict] ?? "stale", version: prev.version + 1, confirmed: verdict === "yes" };
}
export function latest(records: EdgeRecord[]): EdgeRecord | undefined { return records.reduce<EdgeRecord | undefined>((a, r) => (!a || r.version > a.version ? r : a), undefined); }`,
	],
	[
		"N11: a readiness status derived by a getter from a latch, a debounce timer and data",
		`export class HookFilesystemWatch {
	private stopped = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private lastReconciled: string | null = null;
	private unmeasured: string[] = [];
	schedule(): void {
		if (this.stopped || this.timer) return;
		this.timer = setTimeout(() => { this.timer = undefined; this.reconcile(); }, 50);
	}
	reconcile(): void { if (this.stopped) return; this.unmeasured = []; this.lastReconciled = new Date().toISOString(); }
	get readiness(): "ready" | "unmeasured" { return !this.stopped && this.lastReconciled && !this.unmeasured.length ? "ready" : "unmeasured"; }
	stop = (): void => { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; };
}`,
	],
];

describe("selectStateMachineCandidates — negative (must not fire)", () => {
	for (const [title, src] of NEGATIVES) {
		it(title, () => {
			expect(scopes(src)).toEqual([]);
			expect(scopes(src, true)).toEqual([]);
		});
	}
	it("N12: the debounce negative is rejected by the debounce exclusion itself, not by accident", () => {
		const src = NEGATIVES[4]?.[1] ?? "";
		const v = explainStateMachineScopes(src, "fixture.ts")?.[0];
		expect(v?.reason).toBe("too-few-fields");
		expect(v?.candidate.excludedFields).toEqual([{ name: "pendingTimer", reason: "debounce" }]);
	});
	it("N13: the central reducer is rejected as single-writer-function even though callers reach it", () => {
		expect(reasonOf(NEGATIVES[8]?.[1] ?? "", "TddCycleState")).toBe("single-writer-function");
	});
});

describe("detectStaleHandleHandlers — positive (must fire)", () => {
	it("P1: fires on the SidecarManager exit handler that clears child with no identity guard", () => {
		const f = detectStaleHandleHandlers(SIDECAR, "sidecar.ts");
		expect(f.map((x) => [x.line, x.event, x.field, x.writes])).toEqual([[lineWith(SIDECAR, 'child.on("exit"'), "exit", "child", ["child", "dormant", "status"]]]);
		expect(f[0]?.reassignedAt).toEqual([lineWith(SIDECAR, "this.child = child;")]);
	});
});

describe("detectStaleHandleHandlers — negative (must not fire)", () => {
	it("N1: the one-object-per-handle wrapper (spawn-async shape) is exempt", () => {
		expect(detectStaleHandleHandlers(ONE_OBJECT_PER_HANDLE, "spawn-async.ts")).toEqual([]);
	});
	it("N2: an identity guard (this.child === child) in the handler suppresses it", () => {
		expect(detectStaleHandleHandlers(WATCH_PROCESS, "watch.ts")).toEqual([]);
	});
});

// ---- packet, questions, scoring, formatting ---------------------------------

function sidecarCandidate(): StateMachineCandidate {
	const [c] = selectStateMachineCandidates(SIDECAR, "sidecar.ts");
	if (!c) throw new Error("fixture did not fire");
	return c;
}

describe("buildStateMachinePacket", () => {
	it("P1: carries the field table, combinations, doc and trimmed writer bodies within the byte budget", () => {
		const packet = buildStateMachinePacket(sidecarCandidate(), SIDECAR);
		const text = JSON.stringify(packet);
		expect(text.length).toBeLessThanOrEqual(STATE_MACHINE_PACKET_MAX_BYTES);
		expect(packet).toMatchObject({ scope: "SidecarManager", scope_kind: "class", file: "sidecar.ts" });
		expect(text).toContain("disabled is permanent");
		expect(String(packet.source)).toContain("private dormant = false;");
		expect(String(packet.source)).toContain("// ensureSpawned");
		expect(Array.isArray(packet.combinations) && packet.combinations.length).toBeGreaterThan(0);
	});
	it("P2: a large scope is cut to the budget instead of growing the packet", () => {
		const big = SIDECAR.replace("private setStatus", `${"\tprivate pad(): void { this.booted = !this.booted; }\n".repeat(1)}${"\t// filler line that makes the writer bodies long\n".repeat(400)}\tprivate setStatus`);
		const [c] = selectStateMachineCandidates(big, "big.ts");
		if (!c) throw new Error("big fixture did not fire");
		expect(JSON.stringify(buildStateMachinePacket({ ...c, doc: "d".repeat(5000) }, big)).length).toBeLessThanOrEqual(STATE_MACHINE_PACKET_MAX_BYTES);
	});
});

describe("stateMachineQuestionsFor", () => {
	it("P1: asks the binary one_lifecycle question and a choice over the enumerated combinations plus none", () => {
		const c = sidecarCandidate();
		const q = stateMachineQuestionsFor(c);
		expect(q.one_lifecycle).toEqual(STATE_MACHINE_QUESTIONS.one_lifecycle);
		const choice = q.impossible_combination;
		expect(choice?.type).toBe("choice");
		const ids = choice?.type === "choice" ? Object.keys(choice.criteria) : [];
		expect(ids).toEqual([...c.combinations.map((x) => x.id), "none"]);
		expect(choice?.type === "choice" ? choice.criteria.c1 : null).toBe(describeCombination(c.combinations[0] ?? { id: "", values: {}, assignedBy: [] }));
	});
});

function clientAnswering(noul: number, choice: string): JevClient {
	const fetchImpl = vi.fn(async () =>
		new Response(
			JSON.stringify({
				model: "jev-test",
				answers: {
					one_lifecycle: { type: "noul", noul },
					impossible_combination: { type: "choice", choice, probabilities: { [choice]: 0.7, none: 0.3 }, confidence: 0.4 },
				},
				usage: { input_tokens: 100, output_tokens: 1 },
			}),
			{ status: 200 },
		),
	);
	return new JevClient({ apiKey: "k", fetchImpl });
}

describe("scoreStateMachines", () => {
	it("P1: one call per candidate; returns the raw probabilities and the chosen combination text", async () => {
		const client = clientAnswering(0.83, "c2");
		const findings = await scoreStateMachines(client, "sidecar.ts", SIDECAR);
		expect(client.spend().calls).toBe(1);
		const c = sidecarCandidate();
		expect(findings).toEqual([
			{
				scope: "SidecarManager",
				scopeKind: "class",
				line: c.line,
				oneLifecycle: 0.83,
				impossible: { choice: "c2", combination: describeCombination(c.combinations[1] ?? { id: "", values: {}, assignedBy: [] }), probabilities: { c2: 0.7, none: 0.3 }, confidence: 0.4 },
			},
		]);
	});
	it("N1: a failing client yields no findings rather than throwing", async () => {
		const client = new JevClient({ apiKey: "k", fetchImpl: async () => new Response("nope", { status: 500 }) });
		expect(await scoreStateMachines(client, "sidecar.ts", SIDECAR)).toEqual([]);
	});
	it("N2: a file with no candidate makes no call", async () => {
		const client = clientAnswering(0.9, "none");
		expect(await scoreStateMachines(client, "n.ts", NEGATIVES[0]?.[1] ?? "")).toEqual([]);
		expect(client.spend().calls).toBe(0);
	});
});

describe("formatting", () => {
	it("P1: findings, candidates and stale handlers each format to one tagged line", () => {
		const c = sidecarCandidate();
		const [finding] = formatStateMachineFindings("sidecar.ts", [
			{ scope: "SidecarManager", scopeKind: "class", line: 5, oneLifecycle: 0.83, impossible: { choice: "none", combination: null, probabilities: {}, confidence: 0.5 } },
		]);
		expect(finding).toContain("[interlinked:jev-state-machine]");
		expect(finding).toContain("sidecar.ts:5");
		expect(finding).toContain("p=0.83");
		expect(finding).toContain("UNMEASURED");
		expect(formatStateMachineCandidates("sidecar.ts", [c])[0]).toContain("SidecarManager");
		const [stale] = formatStaleHandleFindings("sidecar.ts", detectStaleHandleHandlers(SIDECAR, "sidecar.ts"));
		expect(stale).toContain("[interlinked:stale-handle]");
		expect(stale).toContain("no identity guard");
	});
	it("N1: empty inputs format to no lines", () => {
		expect(formatStateMachineFindings("x.ts", [])).toEqual([]);
		expect(formatStateMachineCandidates("x.ts", [])).toEqual([]);
		expect(formatStaleHandleFindings("x.ts", [])).toEqual([]);
	});
});
