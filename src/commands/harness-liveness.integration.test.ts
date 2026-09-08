import { wireAbsentOptional, parseWire, wireBoolean, wireNumber, wireObject, wireOptional, wireString, wireUnknown } from "../lib/value-validation.js";
// Spawned-process regression pins for the liveness defects (external review
// 2026-08-26, both passes). Real child processes, real unix sockets, real
// timers — no mocks, no fake timers.
//
// Two distinct regressions are pinned:
//   1. FRAMED protocol: a framed-only daemon must be recognized by a real
//      `daemon.health` RPC (the frame envelope, not a raw StatusQuery).
//   2. The unref'd confirm timer: with a live pid and NO answering socket the
//      probe must actually WAIT the confirm delay and exit 0 — the old code
//      unref'd the awaited timer, so the process exited code 13 ("unsettled
//      top-level await") the moment the loop drained.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitFrames } from "../harness/daemon-protocol.js";
import { probeHarnessLive } from "./harness-liveness.js";
import { getFramedSocketPath } from "./harness-process.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Bounded work + explicit timeout per feedback_ci_macos_slow_test_timeout:
// one tsx child (~2s startup) per case, 60s ceiling.
const SPAWN_TIMEOUT_MS = 60_000;
const CONFIRM_DELAY_MS = 400;

/** A COMPLETE valid DaemonHealth body (review pass 15: `{status:"ok"}` was
 *  not a valid health object, so the old fixture proved envelope shape but
 *  not health validation). */
const VALID_HEALTH = {
	status: "ready",
	uptime_ms: 1,
	warm_caches: [],
	tsgo_status: "ready",
	rpc_inflight: 0,
	protocol_version: "1",
};

interface ChildRun {
	code: number | null;
	stdout: string;
	stderr: string;
	elapsedMs: number;
}

function runProbeInChild(cwd: string, confirmDelayMs: number): Promise<ChildRun> {
	const driver = join(cwd, "probe-driver.mts");
	const livenessModule = join(REPO_ROOT, "src", "commands", "harness-liveness.ts");
	writeFileSync(
		driver,
		[
			`import { probeHarnessLive } from ${JSON.stringify(livenessModule)};`,
			`const t0 = Date.now();`,
			`const ok = await probeHarnessLive(${JSON.stringify(cwd)}, true, ${confirmDelayMs});`,
			`const tDone = Date.now();`,
			`console.log(JSON.stringify({ ok, elapsedMs: tDone - t0 }));`,
			// drain_ms = how long AFTER the probe settled the event loop still had
			// owned work. This is the cancellation-sensitive number: an uncancelled
			// losing raw probe holds its socket + 1500ms timer, so drain_ms ~ 1500;
			// with cancellation it is near zero. Startup variance cancels out.
			`process.on("beforeExit", () => { console.error("drain_ms=" + (Date.now() - tDone)); });`,
		].join("\n"),
	);
	const started = Date.now();
	return new Promise((resolve) => {
		execFile(
			"npx",
			["tsx", driver],
			{ cwd: REPO_ROOT, timeout: SPAWN_TIMEOUT_MS },
			(err, stdout, stderr) => {
				const code = err && typeof (parseWire(err, wireObject({ "code": wireAbsentOptional(wireOptional(wireUnknown)) }), "test JSON value")).code === "number"
					? // SAFETY: execFile's error carries the child exit code as `code` when numeric
						((parseWire(err, wireObject({ "code": wireAbsentOptional(wireOptional(wireNumber)) }), "test JSON value")).code ?? null)
					: err
						? null
						: 0;
				resolve({
					code,
					stdout: String(stdout),
					stderr: String(stderr),
					elapsedMs: Date.now() - started,
				});
			},
		);
	});
}

describe("probeHarnessLive — spawned process against a REAL framed-protocol daemon", () => {
	let tmp: string;
	let server: Server;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "il-live-"));
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		const framedPath = getFramedSocketPath(tmp, undefined);
		mkdirSync(dirname(framedPath), { recursive: true });
		// A real framed RPC responder: parse the request FRAME, echo its id,
		// answer daemon.health. A raw StatusQuery (no id/method) gets nothing —
		// so this test fails if the probe ever regresses to raw-at-framed.
		server = createServer((sock) => {
			let pending = "";
			sock.on("data", (chunk) => {
				const split = splitFrames(chunk.toString(), pending);
				pending = split.remainder;
				for (const frame of split.frames) {
					const msg = parseWire(JSON.parse(frame), wireObject({ "id": wireAbsentOptional(wireOptional(wireString)), "method": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
					if (typeof msg.id === "string" && msg.method === "daemon.health") {
						sock.write(`${JSON.stringify({ id: msg.id, result: VALID_HEALTH })}\n`);
					}
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(framedPath, resolve));
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(tmp, { recursive: true, force: true });
	});

	it(
		"P1: exits 0 and reports listening when only a framed daemon answers daemon.health",
		async () => {
			const { code, stdout, stderr } = await runProbeInChild(tmp, CONFIRM_DELAY_MS);
			expect(stderr).not.toContain("unsettled top-level await");
			expect(code).toBe(0);
			expect(JSON.parse(stdout.trim())).toMatchObject({ ok: true });
		},
		SPAWN_TIMEOUT_MS,
	);
});

function framedResponder(): Server {
	return createServer((sock) => {
		let pending = "";
		sock.on("data", (chunk) => {
			const split = splitFrames(chunk.toString(), pending);
			pending = split.remainder;
			for (const frame of split.frames) {
				const msg = parseWire(JSON.parse(frame), wireObject({ "id": wireAbsentOptional(wireOptional(wireString)), "method": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
				if (typeof msg.id === "string" && msg.method === "daemon.health") {
					sock.write(`${JSON.stringify({ id: msg.id, result: VALID_HEALTH })}\n`);
				}
			}
		});
	});
}

describe("probeHarnessLive — NAMED session daemon binding during the confirm delay (review passes 15–16)", () => {
	// IN-PROCESS on purpose (pass 16: the spawned version hardcoded
	// processRunning:true, so the legacy-pid path could have carried it, and a
	// slow tsx startup could bind the socket before the FIRST probe). Here:
	// processRunning is EXPLICITLY false, the first probe runs before any
	// socket exists (bind is scheduled after it, in-process, no startup race),
	// so only the discoverDaemons().some(alive) branch can grant the confirm
	// delay. Removing that branch makes this test fail (verified empirically
	// this session by temporarily stubbing it to `|| false`).
	it(
		"P3: processRunning=false + live harness-alpha.pid + socket bound mid-delay ⇒ listening",
		async () => {
			const tmp = mkdtempSync(join(tmpdir(), "il-live-named-"));
			mkdirSync(join(tmp, ".interlinked"), { recursive: true });
			writeFileSync(join(tmp, ".interlinked", "harness-alpha.pid"), String(process.pid));
			const alphaSocket = getFramedSocketPath(tmp, "alpha");
			mkdirSync(dirname(alphaSocket), { recursive: true });
			const server = framedResponder();
			// First probe happens synchronously inside probeHarnessLive before any
			// timer fires; the bind lands 300ms into the 1200ms confirm delay.
			const bindTimer = setTimeout(() => server.listen(alphaSocket), 300);
			try {
				const ok = await probeHarnessLive(tmp, false, 1200);
				expect(ok).toBe(true);
			} finally {
				clearTimeout(bindTimer);
				await new Promise<void>((resolve) => server.close(() => resolve()));
				rmSync(tmp, { recursive: true, force: true });
			}
		},
		SPAWN_TIMEOUT_MS,
	);
});

describe("probeHarnessLive — silent raw socket must not stall a framed answer (review pass 15)", () => {
	it(
		"P4: total child time stays far under the raw timeout when framed health wins",
		async () => {
			const tmp = mkdtempSync(join(tmpdir(), "il-live-race-"));
			mkdirSync(join(tmp, ".interlinked"), { recursive: true });
			// Silent raw socket: accepts, never answers (would hold 1.5s alone).
			// Track accepted sockets — `server.close()` waits for them, and the
			// silent server's side can linger past the client's abort (the same
			// teardown hang the queryHarnessSocket N2 test caught).
			const accepted = new Set<import("node:net").Socket>();
			const rawSilent = createServer((sock) => {
				accepted.add(sock);
				sock.on("close", () => accepted.delete(sock));
			});
			await new Promise<void>((resolve) =>
				rawSilent.listen(join(tmp, ".interlinked", "harness.sock"), resolve),
			);
			const framedPath = getFramedSocketPath(tmp, undefined);
			const framed = framedResponder();
			await new Promise<void>((resolve) => framed.listen(framedPath, resolve));
			try {
				const { code, stdout, stderr } = await runProbeInChild(tmp, CONFIRM_DELAY_MS);
				expect(code).toBe(0);
				expect(JSON.parse(stdout.trim())).toMatchObject({ ok: true });
				// The cancellation-sensitive number is the child's own post-probe
				// DRAIN time (pass 16: the earlier <6s whole-process bound passed
				// with or without cancellation, so it killed nothing). Without
				// cancellation, the losing raw probe's socket + timer hold the loop
				// for its full 1500ms; with it, drain is near zero. Assert well
				// below the 1500ms raw timeout.
				const drain = Number(/drain_ms=(\d+)/.exec(stderr)?.[1]);
				expect(Number.isFinite(drain)).toBe(true);
				expect(drain).toBeLessThan(1000);
			} finally {
				for (const sock of accepted) sock.destroy();
				await new Promise<void>((resolve) => rawSilent.close(() => resolve()));
				await new Promise<void>((resolve) => framed.close(() => resolve()));
				rmSync(tmp, { recursive: true, force: true });
			}
		},
		SPAWN_TIMEOUT_MS,
	);
});

describe("probeHarnessLive — spawned process, live pid, NO socket (the unref regression)", () => {
	it(
		"P2: waits the real confirm delay and exits 0 with false — was exit 13 before the delay",
		async () => {
			const tmp = mkdtempSync(join(tmpdir(), "il-live-none-"));
			mkdirSync(join(tmp, ".interlinked"), { recursive: true });
			try {
				const { code, stdout, stderr } = await runProbeInChild(tmp, CONFIRM_DELAY_MS);
				expect(stderr).not.toContain("unsettled top-level await");
				expect(code).toBe(0);
				const parsed = parseWire(JSON.parse(stdout.trim()), wireObject({ "ok": wireBoolean, "elapsedMs": wireNumber }), "test JSON value");
				expect(parsed.ok).toBe(false);
				// The child itself measured the wait: reintroducing timer.unref()
				// exits before the delay elapses, so this bound kills that mutant.
				expect(parsed.elapsedMs).toBeGreaterThanOrEqual(CONFIRM_DELAY_MS - 5);
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		},
		SPAWN_TIMEOUT_MS,
	);
});
