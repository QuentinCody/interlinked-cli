import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type IncumbentDeps, resolveIncumbent, settleIncumbentAtBind } from "./incumbent-check.js";
import type { AntiStompDeps } from "./anti-stomp.js";

interface Recorder {
	deps: IncumbentDeps;
	removed: string[];
	logs: string[];
}

function makeDeps(over: Partial<IncumbentDeps> & { present?: string[] }): Recorder {
	const removed: string[] = [];
	const logs: string[] = [];
	const present = new Set(over.present ?? []);
	const deps: IncumbentDeps = {
		fileExists: over.fileExists ?? ((p) => present.has(p)),
		probe: over.probe ?? (() => Promise.resolve("absent")),
		liveForeignPid: over.liveForeignPid ?? (() => null),
		removeFile:
			over.removeFile ??
			((p) => {
				removed.push(p);
				present.delete(p);
			}),
		log: over.log ?? ((m) => logs.push(m)),
	};
	return { deps, removed, logs };
}

const SOCK = "/repo/.interlinked/harness.sock";
const PID = "/repo/.interlinked/harness.pid";

describe("resolveIncumbent — positive (must fire: stale recovery)", () => {
	it("P1: unlinks a socket that refuses connections and reports stale", async () => {
		const r = makeDeps({ present: [SOCK, PID], probe: () => Promise.resolve("absent") });
		const verdict = await resolveIncumbent(SOCK, PID, r.deps);
		expect(verdict).toEqual({ kind: "stale", pid: null });
		expect(r.removed).toContain(SOCK);
	});

	it("P2: also removes the pid file when no live process owns it", async () => {
		const r = makeDeps({ present: [SOCK, PID] });
		await resolveIncumbent(SOCK, PID, r.deps);
		expect(r.removed).toContain(PID);
	});

	it("P3: names a LIVE owner for reaping without unlinking its live pathname first", async () => {
		const r = makeDeps({ present: [SOCK, PID], liveForeignPid: () => 4242 });
		const verdict = await resolveIncumbent(SOCK, PID, r.deps);
		expect(verdict).toEqual({ kind: "stale", pid: 4242 });
		expect(r.removed).toEqual([]);
	});

	it("P4: a live pid without a socket is a deaf incumbent requiring recovery", async () => {
		const r = makeDeps({ present: [PID], liveForeignPid: () => 7 });
		const verdict = await resolveIncumbent(SOCK, PID, r.deps);
		expect(verdict).toEqual({ kind: "stale", pid: 7 });
		expect(r.removed).toEqual([]);
	});
});

describe("resolveIncumbent — negative (must not fire: live incumbent protected)", () => {
	it("N1: a socket that ACCEPTS is left untouched and reported serving", async () => {
		const r = makeDeps({
			present: [SOCK, PID],
			probe: () => Promise.resolve("ready"),
			liveForeignPid: () => 99,
		});
		const verdict = await resolveIncumbent(SOCK, PID, r.deps);
		expect(verdict).toEqual({ kind: "serving", pid: 99 });
		expect(r.removed).toEqual([]);
	});

	it("N2: an incumbent that answers is protected even with NO pid file", async () => {
		const r = makeDeps({ present: [SOCK], probe: () => Promise.resolve("ready") });
		const verdict = await resolveIncumbent(SOCK, PID, r.deps);
		expect(verdict.kind).toBe("serving");
		expect(r.removed).toEqual([]);
	});

	it("N3: a throwing probe fails SAFE — defer, never unlink", async () => {
		const r = makeDeps({
			present: [SOCK],
			probe: () => {
				throw new Error("boom");
			},
		});
		const verdict = await resolveIncumbent(SOCK, PID, r.deps);
		expect(verdict.kind).toBe("occupied_unready");
		expect(r.removed).toEqual([]);
	});

	it("N4: an accepting but protocol-silent listener without a pid is never unlinked", async () => {
		const r = makeDeps({
			present: [SOCK],
			probe: () => Promise.resolve("occupied_unready"),
		});
		const verdict = await resolveIncumbent(SOCK, PID, r.deps);
		expect(verdict).toEqual({ kind: "occupied_unready", pid: null });
		expect(r.removed).toEqual([]);
	});

	it("N5: an ambiguous listener with a live pid is never reclassified as stale", async () => {
		const r = makeDeps({
			present: [SOCK, PID],
			probe: () => Promise.resolve("occupied_unready"),
			liveForeignPid: () => 99,
		});
		const verdict = await resolveIncumbent(SOCK, PID, r.deps);
		expect(verdict).toEqual({ kind: "occupied_unready", pid: 99 });
		expect(r.removed).toEqual([]);
	});

	it("N6: no socket and no live pid is a clear start, not a recovery", async () => {
		const r = makeDeps({ present: [] });
		const verdict = await resolveIncumbent(SOCK, PID, r.deps);
		expect(verdict).toEqual({ kind: "clear" });
		expect(r.removed).toEqual([]);
	});
});

const sockRoots: string[] = [];
const listeners: Server[] = [];
afterEach(async () => {
	for (const s of listeners.splice(0)) await new Promise((r) => s.close(r));
	for (const d of sockRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A real listener on a `harness.sock` pathname that answers the raw
 *  status protocol only from the SECOND readiness probe on — a daemon that
 *  was still warming when the first probe landed. Resolves once bound. */
async function warmingRawListener(): Promise<{
	dir: string;
	socketPath: string;
	probes: () => number;
}> {
	const dir = mkdtempSync(join(tmpdir(), "il-incumbent-"));
	sockRoots.push(dir);
	const socketPath = join(dir, "harness.sock");
	let probes = 0;
	const server = createServer((socket) => {
		socket.on("data", () => {
			probes += 1;
			if (probes === 1) socket.end();
			else socket.write('{"decision":"allow"}\n');
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	listeners.push(server);
	return { dir, socketPath, probes: () => probes };
}

describe("settleIncumbentAtBind — default socket probe (real listener)", () => {
	it("re-probes a listener that stayed silent on the first attempt and defers to it", async () => {
		const { dir, socketPath, probes } = await warmingRawListener();
		const spy = antiStompSpy();
		const verdict = await settleIncumbentAtBind({
			socketPath,
			pidPath: join(dir, "harness.pid"),
			cwd: "/repo",
			logAlways: () => {},
			antiStomp: spy.deps,
		});
		expect(verdict).toEqual({ kind: "serving", pid: null });
		expect(probes()).toBe(2);
		expect(spy.exits).toBe(1);
	});
});

function antiStompSpy(): { deps: AntiStompDeps; exits: number; recorded: number } {
	const state = { exits: 0, recorded: 0 };
	return {
		get exits() {
			return state.exits;
		},
		get recorded() {
			return state.recorded;
		},
		deps: {
			logAlways: () => {},
			recordExit: () => {
				state.recorded++;
			},
			exit: () => {
				state.exits++;
			},
		},
	};
}

describe("settleIncumbentAtBind — incumbent protection", () => {
	it("P1: a serving incumbent makes THIS process exit as already-running", async () => {
		const spy = antiStompSpy();
		const r = makeDeps({ present: [SOCK], probe: () => Promise.resolve("ready") });
		const verdict = await settleIncumbentAtBind({
			socketPath: SOCK,
			pidPath: PID,
			cwd: "/repo",
			logAlways: () => {},
			antiStomp: spy.deps,
			deps: r.deps,
		});
		expect(verdict.kind).toBe("serving");
		expect(spy.exits).toBe(1);
		expect(spy.recorded).toBe(1);
	});

	it("N1: a stale socket does NOT exit — it clears the corpse and binds", async () => {
		const spy = antiStompSpy();
		const r = makeDeps({ present: [SOCK, PID], probe: () => Promise.resolve("absent") });
		const verdict = await settleIncumbentAtBind({
			socketPath: SOCK,
			pidPath: PID,
			cwd: "/repo",
			logAlways: () => {},
			antiStomp: spy.deps,
			deps: r.deps,
		});
		expect(verdict.kind).toBe("stale");
		expect(spy.exits).toBe(0);
		expect(r.removed).toContain(SOCK);
	});

	it("N2: a clear path neither exits nor removes anything", async () => {
		const spy = antiStompSpy();
		const r = makeDeps({ present: [] });
		const verdict = await settleIncumbentAtBind({
			socketPath: SOCK,
			pidPath: PID,
			cwd: "/repo",
			logAlways: () => {},
			antiStomp: spy.deps,
			deps: r.deps,
		});
		expect(verdict.kind).toBe("clear");
		expect(spy.exits).toBe(0);
		expect(r.removed).toEqual([]);
	});

	it("N3: a protocol-silent listener with no verifiable pid aborts startup without unlinking", async () => {
		const r = makeDeps({ present: [SOCK], probe: () => Promise.resolve("occupied_unready") });
		await expect(
			settleIncumbentAtBind({
				socketPath: SOCK,
				pidPath: PID,
				cwd: "/repo",
				logAlways: () => {},
				deps: r.deps,
			}),
		).rejects.toThrow("did not prove the Interlinked protocol");
		expect(r.removed).toEqual([]);
	});

	it("P2: exact-process exit is confirmed before stale pid/socket metadata is removed", async () => {
		const r = makeDeps({ present: [SOCK, PID], liveForeignPid: () => 4242 });
		await settleIncumbentAtBind({
			socketPath: SOCK,
			pidPath: PID,
			cwd: "/repo",
			logAlways: () => {},
			deps: r.deps,
			reap: async () => "gone",
		});
		expect(r.removed).toEqual([SOCK, PID]);
	});

	it.each(["unverified", "replaced", "failed"] as const)(
		"N4: %s identity outcome aborts takeover and preserves incumbent metadata",
		async (outcome) => {
			const r = makeDeps({ present: [SOCK, PID], liveForeignPid: () => 4242 });
			await expect(
				settleIncumbentAtBind({
					socketPath: SOCK,
					pidPath: PID,
					cwd: "/repo",
					logAlways: () => {},
					deps: r.deps,
					reap: async () => outcome,
				}),
			).rejects.toThrow("verified identity");
			expect(r.removed).toEqual([]);
		},
	);
});
