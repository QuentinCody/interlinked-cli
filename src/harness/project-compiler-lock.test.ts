import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireCrossProcessCompilerLease,
	canonicalProjectRoot,
	linuxProcessIdentity,
	moveAsideStaleLock,
	PROJECT_LEASE_HARD_MAX_AGE_MS,
	tryAcquireCrossProcessCompilerLease,
} from "./project-compiler-lock.js";

// Fake /proc content for the linuxProcessIdentity tests below: readFileSync is
// routed through this map (falling back to the real implementation for every
// path not registered here) so the Linux-only proc-parsing branches can be
// exercised deterministically on any host OS, without touching any other
// caller's real filesystem reads in this file.
const fakeProcFiles = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
			if (typeof path === "string" && fakeProcFiles.has(path)) {
				const content = fakeProcFiles.get(path);
				if (content !== undefined) return content;
			}
			// SAFETY: `rest` is always the tail of the real readFileSync argument
			// list (an encoding string or options object), so this passthrough
			// call has the same argument shape actual.readFileSync accepts; the
			// cast only works around TS not narrowing a spread tail.
			// biome-ignore lint/suspicious/noExplicitAny: passthrough to the real signature
			return (actual.readFileSync as any)(path, ...rest);
		},
	};
});

const CHILD_PROGRAM = [
	'import { tryAcquireCrossProcessCompilerLease, canonicalProjectRoot } from "./src/harness/project-compiler-lock.ts";',
	"const root = process.argv[1];",
	"const lease = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));",
	'if (!lease) { process.stdout.write("busy\\n"); process.exit(0); }',
	'process.stdout.write("acquired\\n");',
	"setInterval(() => {}, 1000);",
].join("\n");

const RACING_CHILD_PROGRAM = [
	'import { existsSync } from "node:fs";',
	'import { tryAcquireCrossProcessCompilerLease, canonicalProjectRoot } from "./src/harness/project-compiler-lock.ts";',
	"const root = process.argv[1];",
	"const go = process.argv[2];",
	"const wait = new Int32Array(new SharedArrayBuffer(4));",
	'process.stdout.write("ready\\n");',
	"while (!existsSync(go)) Atomics.wait(wait, 0, 0, 1);",
	"const lease = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));",
	'process.stdout.write(lease ? "acquired\\n" : "busy\\n");',
	"if (lease) { Atomics.wait(wait, 0, 0, 1000); lease.release(); }",
].join("\n");

function spawnContender(root: string): ChildProcess {
	return spawn(process.execPath, ["--import", "tsx", "--eval", CHILD_PROGRAM, root], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
}

interface RacingContender {
	child: ChildProcess;
	ready: Promise<void>;
	result: Promise<string>;
}

function spawnRacingContender(root: string, goPath: string): RacingContender {
	const child = spawn(
		process.execPath,
		["--import", "tsx", "--eval", RACING_CHILD_PROGRAM, root, goPath],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
	);
	let pending = "";
	let resolveReady = (): void => undefined;
	let resolveResult = (_line: string): void => undefined;
	const ready = new Promise<void>((resolveReadyPromise) => {
		resolveReady = resolveReadyPromise;
	});
	const result = new Promise<string>((resolveResultPromise, rejectResult) => {
		resolveResult = resolveResultPromise;
		child.once("error", rejectResult);
		child.once("exit", (code) => {
			if (code !== 0) rejectResult(new Error(`racing contender exited ${String(code)}`));
		});
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		pending += chunk.toString("utf-8");
		for (;;) {
			const newline = pending.indexOf("\n");
			if (newline < 0) break;
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			if (line === "ready") resolveReady();
			else resolveResult(line);
		}
	});
	return { child, ready, result };
}

function compilerLockPath(projectRoot: string): string {
	const key = canonicalProjectRoot(projectRoot);
	const digest = createHash("sha256").update(key).digest("hex");
	return join(tmpdir(), "interlinked-project-compiler-leases-v1", `${digest}.lock`);
}

function writeSyntheticOwner(projectRoot: string, owner: Record<string, unknown>): void {
	const path = compilerLockPath(projectRoot);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "owner.json"), JSON.stringify(owner));
}

function firstOutputLine(child: ChildProcess): Promise<string> {
	return new Promise<string>((resolveLine, rejectLine) => {
		let pending = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			pending += chunk.toString("utf-8");
			const newline = pending.indexOf("\n");
			if (newline >= 0) resolveLine(pending.slice(0, newline));
		});
		child.once("error", rejectLine);
	});
}

function childExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise<void>((resolveExit) => {
		child.once("exit", () => resolveExit());
	});
}

describe("cross-process project compiler lease", () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-compiler-lock-"));
	});

	afterEach(() => {
		rmSync(compilerLockPath(root), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});

	it("canonicalization is idempotent", () => {
		fc.assert(
			fc.property(fc.string(), (path) => {
				expect(canonicalProjectRoot(canonicalProjectRoot(path))).toBe(canonicalProjectRoot(path));
			}),
		);
	});

	it("refuses a second process while this process owns the same project", async () => {
		const lease = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(lease).not.toBeNull();
		const child = spawnContender(root);
		await expect(firstOutputLine(child)).resolves.toBe("busy");
		await childExit(child);
		lease?.release();
	});

	it("maps a symlink alias to the same lock across processes", async () => {
		const alias = `${root}-alias`;
		symlinkSync(root, alias);
		const lease = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(lease).not.toBeNull();
		try {
			const child = spawnContender(alias);
			await expect(firstOutputLine(child)).resolves.toBe("busy");
			await childExit(child);
		} finally {
			lease?.release();
			rmSync(alias, { force: true });
		}
	});

	it("recovers a lock whose owner process was killed", async () => {
		const child = spawnContender(root);
		await expect(firstOutputLine(child)).resolves.toBe("acquired");
		child.kill("SIGKILL");
		await childExit(child);

		const recovered = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	it("admits exactly one real process when two contenders recover the same stale owner", async () => {
		const project = canonicalProjectRoot(root);
		writeSyntheticOwner(root, {
			pid: 2_147_480_000,
			token: "dead-owner-for-race",
			project,
			createdAt: new Date().toISOString(),
		});
		const goPath = join(root, "go");
		const first = spawnRacingContender(root, goPath);
		const second = spawnRacingContender(root, goPath);
		await Promise.all([first.ready, second.ready]);
		writeFileSync(goPath, "go", { flag: "wx" });
		const outcomes = await Promise.all([first.result, second.result]);
		expect(outcomes.filter((outcome) => outcome === "acquired")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome === "busy")).toHaveLength(1);
		await Promise.all([childExit(first.child), childExit(second.child)]);
	});

	it("does not retire a successor that replaces the owner after stale observation", () => {
		const project = canonicalProjectRoot(root);
		writeSyntheticOwner(root, {
			pid: 2_147_480_000,
			token: "observed-stale-owner",
			project,
			createdAt: new Date().toISOString(),
		});
		const path = compilerLockPath(root);
		const successorToken = "live-successor";
		const lease = tryAcquireCrossProcessCompilerLease(project, {
			beforeRetireObserved: () => {
				rmSync(path, { recursive: true, force: true });
				writeSyntheticOwner(root, {
					pid: process.pid,
					token: successorToken,
					project,
					createdAt: new Date().toISOString(),
				});
			},
		});
		expect(lease).toBeNull();
		expect(JSON.parse(readFileSync(join(path, "owner.json"), "utf-8"))).toMatchObject({
			token: successorToken,
			pid: process.pid,
		});
	});

	it("releases the mutation fence when stale-retirement inspection throws", () => {
		const project = canonicalProjectRoot(root);
		writeSyntheticOwner(root, {
			pid: 2_147_480_000,
			token: "stale-owner-before-throw",
			project,
			createdAt: new Date().toISOString(),
		});
		expect(() =>
			tryAcquireCrossProcessCompilerLease(project, {
				beforeRetireObserved: () => {
					throw new Error("injected stale inspection failure");
				},
			}),
		).toThrow("injected stale inspection failure");
		const recovered = tryAcquireCrossProcessCompilerLease(project);
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	it.runIf(process.platform === "darwin" || process.platform === "linux")(
		"persists a process-start identity and reclaims a live reused PID with a different identity",
		() => {
			const project = canonicalProjectRoot(root);
			writeSyntheticOwner(root, {
				pid: process.pid,
				token: "owner-from-an-exited-process",
				project,
				createdAt: new Date().toISOString(),
				processIdentity: "not-the-current-process-start",
			});

			const recovered = tryAcquireCrossProcessCompilerLease(project);
			expect(recovered).not.toBeNull();
			expect(readFileSync(join(compilerLockPath(root), "owner.json"), "utf-8")).toContain(
				'"processIdentity":',
			);
			recovered?.release();
		},
	);

	it("keeps a fresh legacy owner with a live PID for backward compatibility", () => {
		const project = canonicalProjectRoot(root);
		writeSyntheticOwner(root, {
			pid: process.pid,
			token: "legacy-live-owner",
			project,
			createdAt: new Date().toISOString(),
		});

		expect(tryAcquireCrossProcessCompilerLease(project)).toBeNull();
	});

	it("reclaims an over-age legacy owner even when its PID is live", () => {
		const project = canonicalProjectRoot(root);
		writeSyntheticOwner(root, {
			pid: process.pid,
			token: "legacy-reused-owner",
			project,
			createdAt: new Date(Date.now() - PROJECT_LEASE_HARD_MAX_AGE_MS - 1).toISOString(),
		});

		const recovered = tryAcquireCrossProcessCompilerLease(project);
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	it("does not reclaim fresh malformed owner metadata while another process initializes it", () => {
		const path = compilerLockPath(root);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "owner.json"), '{"pid":');

		expect(tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root))).toBeNull();
	});

	it("reclaims malformed owner metadata after the initialization grace expires", () => {
		const path = compilerLockPath(root);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "owner.json"), '{"pid":');
		const stale = new Date(Date.now() - 6_000);
		utimesSync(path, stale, stale);

		const recovered = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	it("treats a malformed process identity as malformed owner metadata", () => {
		const path = compilerLockPath(root);
		writeSyntheticOwner(root, {
			pid: process.pid,
			token: "invalid-identity-owner",
			project: canonicalProjectRoot(root),
			createdAt: new Date().toISOString(),
			processIdentity: 42,
		});
		const stale = new Date(Date.now() - 6_000);
		utimesSync(path, stale, stale);

		const recovered = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	it("allows different project roots concurrently", () => {
		const first = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		const secondRoot = mkdtempSync(join(tmpdir(), "interlinked-compiler-lock-other-"));
		const second = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(secondRoot));
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		first?.release();
		second?.release();
		rmSync(secondRoot, { recursive: true, force: true });
	});

	it("recovers a lock whose owner record has a non-positive pid", () => {
		// pid 0 (not -5): `process.kill(0, 0)` and `process.kill(-1, 0)` both
		// succeed (they target the caller's process group / every process the
		// caller can signal), so any pid <= 0 reads as "alive" once parsed —
		// only the `record.pid <= 0` guard in parseLockOwner stops that record
		// from being trusted as a live owner in the first place.
		const path = compilerLockPath(root);
		writeSyntheticOwner(root, {
			pid: 0,
			token: "invalid-pid-owner",
			project: canonicalProjectRoot(root),
			createdAt: new Date().toISOString(),
		});
		const stale = new Date(Date.now() - 6_000);
		utimesSync(path, stale, stale);

		const recovered = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(recovered).not.toBeNull();
		expect(JSON.parse(readFileSync(join(path, "owner.json"), "utf-8")).token).not.toBe(
			"invalid-pid-owner",
		);
		recovered?.release();
	});

	it("recovers a lock whose owner record has an unparsable createdAt", () => {
		const path = compilerLockPath(root);
		writeSyntheticOwner(root, {
			pid: process.pid,
			token: "invalid-createdat-owner",
			project: canonicalProjectRoot(root),
			createdAt: "not-a-real-timestamp",
		});
		const stale = new Date(Date.now() - 6_000);
		utimesSync(path, stale, stale);

		const recovered = tryAcquireCrossProcessCompilerLease(canonicalProjectRoot(root));
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	it("cannot move aside a stale-lock path that no longer exists", () => {
		expect(moveAsideStaleLock(join(root, "does-not-exist"))).toBe(false);
	});

	it("leaves the lock directory in place when release cannot verify the owner file", () => {
		const project = canonicalProjectRoot(root);
		const path = compilerLockPath(root);
		const lease = tryAcquireCrossProcessCompilerLease(project);
		expect(lease).not.toBeNull();
		rmSync(join(path, "owner.json"), { force: true });

		lease?.release();

		expect(existsSync(path)).toBe(true);
	});

	it("removes the just-created lock directory when a racing writer publishes the owner file first", () => {
		const project = canonicalProjectRoot(root);
		const path = compilerLockPath(root);

		const lease = tryAcquireCrossProcessCompilerLease(project, {
			beforeOwnerWrite: () => {
				mkdirSync(path, { recursive: true });
				writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: 1, token: "racer" }));
			},
		});

		expect(lease).toBeNull();
		expect(existsSync(path)).toBe(false);
	});

	it("returns null after two recovery attempts each find a fresh stale lock", () => {
		const project = canonicalProjectRoot(root);
		const deadOwner = (token: string): Record<string, unknown> => ({
			pid: 2_147_480_000,
			token,
			project,
			createdAt: new Date(Date.now() - PROJECT_LEASE_HARD_MAX_AGE_MS - 1).toISOString(),
		});
		writeSyntheticOwner(root, deadOwner("first-stale"));
		let afterReclaimCalls = 0;

		const lease = tryAcquireCrossProcessCompilerLease(project, {
			afterReclaim: () => {
				afterReclaimCalls += 1;
				writeSyntheticOwner(root, deadOwner(`stale-${afterReclaimCalls}`));
			},
		});

		expect(lease).toBeNull();
		expect(afterReclaimCalls).toBe(2);
	});

	it("returns null immediately when the wait signal is already aborted", async () => {
		const project = canonicalProjectRoot(root);
		const result = await acquireCrossProcessCompilerLease(project, Date.now() + 1_000, AbortSignal.abort());
		expect(result).toBeNull();
	});

	it("acquires the lease once a held lock clears while polling with no abort signal", async () => {
		const project = canonicalProjectRoot(root);
		const held = tryAcquireCrossProcessCompilerLease(project);
		expect(held).not.toBeNull();

		const pending = acquireCrossProcessCompilerLease(project, Date.now() + 500);
		setTimeout(() => held?.release(), 30);
		const acquired = await pending;

		expect(acquired).not.toBeNull();
		acquired?.release();
	});
});

describe("linuxProcessIdentity (Linux-only /proc parsing, exercised on any host via fake /proc content)", () => {
	// Every `/proc/...` path below is served entirely from `fakeProcFiles`
	// through the module-level `readFileSync` mock declared at the top of this
	// file — no real filesystem call under `/proc` is ever made (no mkdir, no
	// unmocked read), so this is safe on every host, Linux included.
	afterEach(() => {
		fakeProcFiles.clear();
	});

	it("returns null when the stat line has no closing paren around the command name", () => {
		const pid = 424_242;
		// The line must still have 20+ whitespace fields (a real digit run
		// landing on index 19) so the guard under test — `if (commandEnd < 0)
		// return null` — is what stops the parse, not the shorter fallback path
		// (`fields[19] === undefined`) a too-short fixture would fall through to
		// regardless of the guard.
		const filler = Array.from({ length: 18 }, () => "0").join(" ");
		fakeProcFiles.set(`/proc/${pid}/stat`, `42 no-closing-paren-here R ${filler} 987654`);
		fakeProcFiles.set("/proc/sys/kernel/random/boot_id", "abcd-boot-id\n");

		expect(linuxProcessIdentity(pid)).toBeNull();
	});

	it("returns null when the start-time field is not a run of digits", () => {
		const pid = 424_243;
		// index 0 after ")" is state ("R"); index 19 is start time (field 22 in
		// proc(5) terms, per the comment in linuxProcessIdentity) — 18 filler
		// fields land the bad value exactly on the field the function reads.
		const filler = Array.from({ length: 18 }, () => "0").join(" ");
		fakeProcFiles.set(`/proc/${pid}/stat`, `42 (node) R ${filler} not-a-number`);

		expect(linuxProcessIdentity(pid)).toBeNull();
	});

	it("builds a linux identity string from the stat start time and the boot id", () => {
		const pid = 424_244;
		const startTicks = "123456789";
		const filler = Array.from({ length: 18 }, () => "0").join(" ");
		fakeProcFiles.set(`/proc/${pid}/stat`, `42 (node) R ${filler} ${startTicks}`);
		fakeProcFiles.set("/proc/sys/kernel/random/boot_id", "abcd-boot-id\n");

		expect(linuxProcessIdentity(pid)).toBe(`linux:abcd-boot-id:${startTicks}`);
	});

	it("returns null when /proc has no entry for the pid", () => {
		expect(linuxProcessIdentity(999_999_999)).toBeNull();
	});
});
