// ===========================================
// `interlinked harness reap` — the reaper may never kill a SERVING daemon
// ===========================================
// The command used to call `reapOrphanHarnesses` directly, so its victims came
// straight out of `ps`. A healthy daemon whose pid file had been cleaned was a
// candidate, and killing it opened the guard gap that made the next blocked
// caller run `harness start` — the 2026-08-15 restart storm. These cases pin
// the verified path: the socket is probed FIRST and answering pids are handed
// to the sweep as protected.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonControlDeps } from "./harness-daemon-control.js";
import { harnessReapCommand } from "./harness-reap.js";
import type { ReapOptions, ReapResult } from "./harness-process.js";

function daemon(pid: number | null, socket: string, alive = true) {
	return { session_id: socket, paths: { socket, pid: `${socket}.pid`, log: "log" }, pid, alive };
}

function emptyResult(opts: ReapOptions): ReapResult {
	return { candidates: [], killed: [], dryRun: opts.dryRun === true };
}

/** Capture the options the underlying `ps` sweep actually received. */
function recordingDeps(serving: number[], seen: ReapOptions[]): DaemonControlDeps {
	return {
		discover: () => serving.map((pid, i) => daemon(pid, `/s${i}.sock`)),
		probe: () => Promise.resolve(true),
		reap: (_cwd, opts) => {
			seen.push(opts);
			return emptyResult(opts);
		},
	};
}

/** The single sweep the command is expected to have run. */
function onlySweep(seen: ReapOptions[]): ReapOptions {
	expect(seen).toHaveLength(1);
	const first = seen[0];
	if (first === undefined) throw new Error("no sweep recorded");
	return first;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("harnessReapCommand — positive (must fire: protect what answers)", () => {
	it("P1: a daemon that answers its socket reaches the sweep as a protected pid", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const seen: ReapOptions[] = [];
		await harnessReapCommand({ json: true }, recordingDeps([4242], seen));
		expect([...(onlySweep(seen).protectPids ?? [])]).toEqual([4242]);
	});

	it("P2: --all still protects a serving daemon (reap cleans the dead, stop stops the live)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const seen: ReapOptions[] = [];
		await harnessReapCommand({ json: true, force: true, all: true }, recordingDeps([77], seen));
		expect(onlySweep(seen).killAll).toBe(true);
		expect(onlySweep(seen).protectPids?.has(77)).toBe(true);
	});

	it("P3: the default invocation is a dry run (no SIGTERM without --force)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const seen: ReapOptions[] = [];
		await harnessReapCommand({ json: true }, recordingDeps([], seen));
		expect(onlySweep(seen).dryRun).toBe(true);
	});

	it("P4: --force flips the sweep out of dry-run", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const seen: ReapOptions[] = [];
		await harnessReapCommand({ json: true, force: true }, recordingDeps([], seen));
		expect(onlySweep(seen).dryRun).toBe(false);
	});
});

describe("harnessReapCommand — negative (must not fire)", () => {
	it("N1: a daemon whose socket REFUSES is not protected — a corpse is still reapable", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const seen: ReapOptions[] = [];
		await harnessReapCommand(
			{ json: true },
			{
				discover: () => [daemon(9, "/dead.sock")],
				probe: () => Promise.resolve(false),
				reap: (_cwd, opts) => {
					seen.push(opts);
					return emptyResult(opts);
				},
			},
		);
		expect(onlySweep(seen).protectPids?.size).toBe(0);
	});

	it("N2: a sweep failure is reported, not thrown", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(
			harnessReapCommand(
				{},
				{
					discover: () => [],
					reap: () => {
						throw new Error("ps unavailable");
					},
				},
			),
		).resolves.toBeUndefined();
		expect(errSpy).toHaveBeenCalledWith("Error: ps unavailable");
	});
});
