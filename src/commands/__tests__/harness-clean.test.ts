// ===========================================
// `interlinked harness clean` — stale state-file removal
// ===========================================
// Covers:
//   1. Refuses to clean when an active daemon is alive (directs user to
//      `harness stop`).
//   2. When the daemon is gone but stale `.sock` / `.pid` linger, both files
//      are unlinked.
//   3. When neither file exists, the command succeeds silently (idempotent).
//   4. JSON output shape.
//
// Uses real fs in a temp dir so we exercise the real existsSync/unlinkSync
// path — the mocking layer is only needed for `process.kill` (the liveness
// probe), which we stub to throw ESRCH for "not running".

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessCleanCommand } from "../harness-clean.js";

let workDir: string;
// SPY, not process.chdir(): chdir THROWS in a worker thread ("process.chdir()
// is not supported in workers"), and Stryker's vitest runner pins its own
// pool, so a real chdir here fails the mutation dry run for any file whose
// graph-selected test scope includes this one. harnessCleanCommand reads
// `process.cwd()` explicitly, so the spy exercises the same path.
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
const STALE_DAEMON_PID = 999_999;

beforeEach(() => {
	workDir = join(
		tmpdir(),
		`harness-clean-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(join(workDir, ".interlinked"), { recursive: true });
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workDir);
});

afterEach(() => {
	cwdSpy?.mockRestore();
	rmSync(workDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

interface CapturedStdio {
	stdout: string;
	stderr: string;
}

async function captureStdio(fn: () => Promise<void> | void): Promise<CapturedStdio> {
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const realStdoutWrite = process.stdout.write.bind(process.stdout);
	const realStderrWrite = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
		return true;
	}) as typeof process.stderr.write;
	const realConsoleLog = console.log;
	const realConsoleError = console.error;
	console.log = (...args: unknown[]): void => {
		stdoutChunks.push(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
	};
	console.error = (...args: unknown[]): void => {
		stderrChunks.push(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
	};
	try {
		await fn();
	} finally {
		process.stdout.write = realStdoutWrite;
		process.stderr.write = realStderrWrite;
		console.log = realConsoleLog;
		console.error = realConsoleError;
	}
	return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

function pidPath(): string {
	return join(workDir, ".interlinked", "harness.pid");
}

function sockPath(): string {
	return join(workDir, ".interlinked", "harness.sock");
}

function fileExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

describe("harnessCleanCommand — refuses when daemon is alive", () => {
	it("emits an error and leaves files in place when isHarnessRunning returns true", async () => {
		// Simulate "running" by writing pid file pointing at OUR own pid (alive),
		// so isHarnessRunning succeeds the process.kill(0) liveness check.
		writeFileSync(pidPath(), String(process.pid));
		writeFileSync(sockPath(), "");
		const previousExitCode = process.exitCode;

		const captured = await captureStdio(() => harnessCleanCommand({}));
		const exitCode = process.exitCode;
		process.exitCode = previousExitCode;

		expect(exitCode).toBe(1);
		expect(captured.stderr).toMatch(/active|running|harness stop/i);
		// State files MUST still be present — clean refused.
		expect(fileExists(pidPath())).toBe(true);
		expect(fileExists(sockPath())).toBe(true);
	});
});

describe("harnessCleanCommand — removes stale files when daemon is dead", () => {
	beforeEach(() => {
		// Stub process.kill so the liveness probe in isHarnessRunning thinks
		// STALE_DAEMON_PID is gone. process.kill(pid, 0) throws ESRCH when the
		// process doesn't exist.
		vi.spyOn(process, "kill").mockImplementation(((
			_pid: number,
			_sig?: string | number,
		): true => {
			const err = new Error("ESRCH") as Error & { code?: string };
			err.code = "ESRCH";
			throw err;
		}) as typeof process.kill);
	});

	it("unlinks stale .sock and .pid files", async () => {
		writeFileSync(pidPath(), String(STALE_DAEMON_PID));
		writeFileSync(sockPath(), "");
		await captureStdio(() => harnessCleanCommand({}));
		expect(fileExists(pidPath())).toBe(false);
		expect(fileExists(sockPath())).toBe(false);
	});

	it("succeeds even when only the socket file exists", async () => {
		writeFileSync(sockPath(), "");
		// no pid file
		await captureStdio(() => harnessCleanCommand({}));
		expect(fileExists(sockPath())).toBe(false);
	});

	it("succeeds (idempotent) when neither file exists", async () => {
		const previousExitCode = process.exitCode;
		await captureStdio(() => harnessCleanCommand({}));
		const exitCode = process.exitCode;
		process.exitCode = previousExitCode;
		// No exit code change for the no-op case.
		expect(exitCode).toBe(previousExitCode);
	});

	it("--json reports the action taken", async () => {
		writeFileSync(pidPath(), String(STALE_DAEMON_PID));
		writeFileSync(sockPath(), "");
		const captured = await captureStdio(() => harnessCleanCommand({ json: true }));
		const parsed = JSON.parse(captured.stdout) as {
			ok: boolean;
			removed: string[];
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.removed).toEqual(
			expect.arrayContaining([
				expect.stringContaining("harness.pid"),
				expect.stringContaining("harness.sock"),
			]),
		);
	});
});
