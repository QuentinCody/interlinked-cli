import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFileMutationLock } from "../lib/file-mutation-lock.js";
import {
	acquireCrossProcessCompilerLease,
	canonicalProjectRoot,
	LEASE_ANCESTORS_ENV,
	leaseAncestorsForChildren,
	linuxProcessIdentity,
	tryAcquireCrossProcessCompilerLease,
} from "./project-compiler-lock.js";

// Fake /proc content and a `ps` override, both routed through the real module
// for every other call, so the platform-specific identity branches run on any
// host without touching a real /proc or spawning a real `ps` for the pids
// under test.
const fakeProcFiles = vi.hoisted(() => new Map<string, string>());
const psOverride = vi.hoisted((): { impl: (() => string) | null } => ({ impl: null }));
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
			const [path] = args;
			if (typeof path === "string" && fakeProcFiles.has(path)) {
				const content = fakeProcFiles.get(path);
				if (content !== undefined) return content;
			}
			return actual.readFileSync(...args);
		},
	};
});
vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	return {
		...actual,
		execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
			if (args[0] === "/bin/ps" && psOverride.impl) return psOverride.impl();
			return actual.execFileSync(...args);
		},
	};
});

function compilerLockPath(projectRoot: string): string {
	const key = canonicalProjectRoot(projectRoot);
	const digest = createHash("sha256").update(key).digest("hex");
	return join(tmpdir(), "interlinked-project-compiler-leases-v1", `${digest}.lock`);
}

function plantOwner(projectRoot: string, owner: Record<string, unknown> | string): string {
	const path = compilerLockPath(projectRoot);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner));
	return path;
}

function backdate(path: string, ms = 6_000): void {
	const stale = new Date(Date.now() - ms);
	utimesSync(path, stale, stale);
}

function ownerOf(path: string): Record<string, unknown> {
	// SAFETY: the file under test is written by this module or by plantOwner as a JSON object.
	return JSON.parse(readFileSync(join(path, "owner.json"), "utf-8")) as Record<string, unknown>;
}

function holder(): ChildProcess {
	return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

function exited(child: ChildProcess): Promise<void> {
	return new Promise((resolveExit) => {
		if (child.exitCode !== null || child.signalCode !== null) resolveExit();
		else child.once("exit", () => resolveExit());
	});
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return run();
	} finally {
		if (original) Object.defineProperty(process, "platform", original);
	}
}

let root = "";
let project = "";
const children: ChildProcess[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-lock-backfill-"));
	project = canonicalProjectRoot(root);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	fakeProcFiles.clear();
	psOverride.impl = null;
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
		await exited(child);
	}
	rmSync(compilerLockPath(root), { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

function liveOwner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { pid: process.pid, token: "planted", project, createdAt: new Date().toISOString(), ...overrides };
}

describe("owner record validation — negative (must not fire)", () => {
	it("N1: a well-formed live owner past the initialization grace still blocks admission", () => {
		// test-contract: invariant — control for the malformed cases below: only a malformed record, never age alone, makes a live owner reclaimable
		backdate(plantOwner(root, liveOwner()));
		expect(tryAcquireCrossProcessCompilerLease(project)).toBeNull();
	});

	const malformed: Array<[string, () => Record<string, unknown> | string]> = [
		["N2: a JSON null record", () => "null"],
		["N3: a JSON string record", () => '"text"'],
		["N4: a JSON array record", () => "[]"],
		["N5: a record with an empty token", () => liveOwner({ token: "" })],
		["N6: a record with a non-string token", () => liveOwner({ token: 7 })],
		["N7: a record with an empty project", () => liveOwner({ project: "" })],
		["N8: a record with a non-string project", () => liveOwner({ project: 7 })],
	];
	for (const [title, record] of malformed) {
		it(title, () => {
			// test-contract: invariant — a malformed owner record is no owner: once the initialization grace expires the lock is reclaimed
			backdate(plantOwner(root, record()));
			const lease = tryAcquireCrossProcessCompilerLease(project);
			expect(lease).not.toBeNull();
			expect(ownerOf(compilerLockPath(root))).toMatchObject({ pid: process.pid, project });
			lease?.release();
		});
	}
});

describe("release ownership — negative (must not fire)", () => {
	it("N1: releasing twice never removes a successor's lock", () => {
		// test-contract: bug — a second release of a retired lease must not delete the lock a later owner took
		const first = tryAcquireCrossProcessCompilerLease(project);
		expect(first).not.toBeNull();
		first?.release();
		expect(existsSync(compilerLockPath(root))).toBe(false);
		const second = tryAcquireCrossProcessCompilerLease(project);
		expect(second).not.toBeNull();
		first?.release();
		expect(existsSync(compilerLockPath(root))).toBe(true);
		second?.release();
		expect(existsSync(compilerLockPath(root))).toBe(false);
	});

	it("N2: a lease whose owner record now names a different token leaves the lock alone", () => {
		// test-contract: invariant — the random token stops a stale releaser deleting a newer owner's lease
		const lease = tryAcquireCrossProcessCompilerLease(project);
		const path = compilerLockPath(root);
		writeFileSync(join(path, "owner.json"), JSON.stringify(liveOwner({ token: "someone-else" })));
		lease?.release();
		expect(ownerOf(path).token).toBe("someone-else");
	});

	it("N3: a lease whose owner record has the same token but another pid leaves the lock alone", () => {
		// test-contract: invariant — ownership is token AND pid; a record copied by another process is not ours to remove
		const lease = tryAcquireCrossProcessCompilerLease(project);
		const path = compilerLockPath(root);
		const record = ownerOf(path);
		writeFileSync(join(path, "owner.json"), JSON.stringify({ ...record, pid: process.pid + 1 }));
		lease?.release();
		expect(ownerOf(path).pid).toBe(process.pid + 1);
	});

	it("N4: an unparsable owner record is never treated as ours", () => {
		// test-contract: boundary — release removes a lock only after verifying the owner record
		const lease = tryAcquireCrossProcessCompilerLease(project);
		const path = compilerLockPath(root);
		writeFileSync(join(path, "owner.json"), "{");
		lease?.release();
		expect(existsSync(path)).toBe(true);
	});
});

describe("mutation fence contention — negative (must not fire)", () => {
	it("N1: admission reports busy instead of waiting or throwing when the fence is held", () => {
		// test-contract: public-api — the nonqueueing primitive returns null while another process holds the mutation fence
		const result = withFileMutationLock(compilerLockPath(root), () => tryAcquireCrossProcessCompilerLease(project), { waitMs: 0 });
		expect(result).toBeNull();
		expect(existsSync(compilerLockPath(root))).toBe(false);
	});
});

describe("lease ancestors — positive (must fire)", () => {
	it("P1: a live ancestor's lock is granted as a no-op lease that never touches the holder's lock", async () => {
		// test-contract: public-api — a process running under a holder's lease is not deadlocked by it, and releasing the grant leaves the holder's lock
		const ancestor = holder();
		children.push(ancestor);
		const path = plantOwner(root, liveOwner({ pid: ancestor.pid, token: "ancestor-token" }));
		vi.stubEnv(LEASE_ANCESTORS_ENV, `${ancestor.pid}`);
		const nested = tryAcquireCrossProcessCompilerLease(project);
		expect(nested).not.toBeNull();
		nested?.release();
		expect(ownerOf(path)).toMatchObject({ pid: ancestor.pid, token: "ancestor-token" });
		// Without the ancestor listing the holder's lock still blocks admission.
		vi.unstubAllEnvs();
		await expect(acquireCrossProcessCompilerLease(project, Date.now() + 100)).resolves.toBeNull();
	});

	it("P2: leaseAncestorsForChildren lists the inherited ancestors plus this process", () => {
		// test-contract: public-api — the value handed to children names every ancestor and the holder itself
		vi.stubEnv(LEASE_ANCESTORS_ENV, "123,not-a-pid,-4,0,45");
		expect(leaseAncestorsForChildren()).toBe(`123,45,${process.pid}`);
		vi.stubEnv(LEASE_ANCESTORS_ENV, "");
		expect(leaseAncestorsForChildren()).toBe(`${process.pid}`);
	});
});

describe("lease ancestors — negative (must not fire)", () => {
	it("N1: a live owner that is not a listed ancestor still blocks admission", () => {
		// test-contract: invariant — only a listed ancestor's lock is shared
		const stranger = holder();
		children.push(stranger);
		plantOwner(root, liveOwner({ pid: stranger.pid }));
		vi.stubEnv(LEASE_ANCESTORS_ENV, `${process.pid + 1}`);
		expect(tryAcquireCrossProcessCompilerLease(project)).toBeNull();
	});

	it("N2: an owner that is this process itself is not treated as an ancestor grant", () => {
		// test-contract: invariant — listing our own pid never lets us share our own lock
		plantOwner(root, liveOwner());
		vi.stubEnv(LEASE_ANCESTORS_ENV, `${process.pid}`);
		expect(tryAcquireCrossProcessCompilerLease(project)).toBeNull();
	});

	it("N3: a listed ancestor that has exited loses its lock to recovery", async () => {
		// test-contract: bug — a dead ancestor must not keep granting nested leases; its lock is reclaimed as stale
		const ancestor = holder();
		ancestor.kill("SIGKILL");
		await exited(ancestor);
		plantOwner(root, liveOwner({ pid: ancestor.pid, token: "dead-ancestor" }));
		vi.stubEnv(LEASE_ANCESTORS_ENV, `${ancestor.pid}`);
		const lease = tryAcquireCrossProcessCompilerLease(project);
		expect(lease).not.toBeNull();
		expect(ownerOf(compilerLockPath(root)).pid).toBe(process.pid);
		lease?.release();
	});

	it("N4: a lock directory with no owner file is not a nested grant", () => {
		// test-contract: boundary — an initializing lock (no owner file yet) is neither shared nor stolen inside the grace period
		mkdirSync(compilerLockPath(root), { recursive: true });
		vi.stubEnv(LEASE_ANCESTORS_ENV, `${process.pid + 1}`);
		expect(tryAcquireCrossProcessCompilerLease(project)).toBeNull();
	});

	it("N5: an unparsable owner file is not a nested grant", () => {
		// test-contract: boundary — malformed owner metadata inside the grace period is neither shared nor stolen
		plantOwner(root, "{");
		vi.stubEnv(LEASE_ANCESTORS_ENV, `${process.pid + 1}`);
		expect(tryAcquireCrossProcessCompilerLease(project)).toBeNull();
	});
});

describe("process identity — ps path", () => {
	it("N1: a live owner whose identity cannot be read keeps its lock (ps prints nothing)", () => {
		// test-contract: invariant — an uninspectable identity is no evidence of PID reuse, so the owner stays
		plantOwner(root, liveOwner({ processIdentity: "ps:Thu Jan  1 00:00:00 1970" }));
		psOverride.impl = () => "  \n";
		expect(withPlatform("darwin", () => tryAcquireCrossProcessCompilerLease(project))).toBeNull();
	});

	it("N2: a live owner whose identity lookup fails keeps its lock (ps errors)", () => {
		// test-contract: invariant — a failed ps call degrades to the hard max-age backstop, not to stealing the lock
		plantOwner(root, liveOwner({ processIdentity: "ps:Thu Jan  1 00:00:00 1970" }));
		psOverride.impl = () => { throw new Error("ps unavailable"); };
		expect(withPlatform("darwin", () => tryAcquireCrossProcessCompilerLease(project))).toBeNull();
	});

	it("P1: a live owner whose recorded identity differs from the current one is reclaimed (PID reuse)", () => {
		// test-contract: public-api — a recycled PID with another start time does not hold the lease
		plantOwner(root, liveOwner({ processIdentity: "ps:Thu Jan  1 00:00:00 1970" }));
		psOverride.impl = () => "Fri Jan  2 00:00:00 1970\n";
		const lease = withPlatform("darwin", () => tryAcquireCrossProcessCompilerLease(project));
		expect(lease).not.toBeNull();
		lease?.release();
	});
});

describe("process identity — linux /proc path", () => {
	const filler = Array.from({ length: 18 }, () => "0").join(" ");
	function fakeProc(startTicks: string, bootId = "boot-1\n"): void {
		fakeProcFiles.set(`/proc/${process.pid}/stat`, `42 (node) R ${filler} ${startTicks}`);
		fakeProcFiles.set("/proc/sys/kernel/random/boot_id", bootId);
	}

	it("N1: an empty boot id yields no identity", () => {
		// test-contract: boundary — an identity without a boot id could repeat across reboots, so it is withheld
		fakeProc("555", "\n");
		expect(linuxProcessIdentity(process.pid)).toBeNull();
	});

	it("N2: a live owner with a matching linux identity keeps its lock", () => {
		// test-contract: invariant — the same process start on the same boot is the same owner
		fakeProc("555");
		plantOwner(root, liveOwner({ processIdentity: "linux:boot-1:555" }));
		expect(withPlatform("linux", () => tryAcquireCrossProcessCompilerLease(project))).toBeNull();
	});

	it("P1: a live owner with a different linux start time is reclaimed", () => {
		// test-contract: public-api — a recycled PID on Linux is detected through /proc start ticks
		fakeProc("556");
		plantOwner(root, liveOwner({ processIdentity: "linux:boot-1:555" }));
		const lease = withPlatform("linux", () => tryAcquireCrossProcessCompilerLease(project));
		expect(lease).not.toBeNull();
		lease?.release();
	});
});

describe("abortable admission wait — positive (must fire)", () => {
	it("P1: an abort that lands between the loop check and the wait rejects the admission", async () => {
		// test-contract: boundary — a signal that flips to aborted just before the retry wait starts must reject, not sleep
		const held = tryAcquireCrossProcessCompilerLease(project);
		expect(held).not.toBeNull();
		const controller = new AbortController();
		let reads = 0;
		Object.defineProperty(controller.signal, "aborted", { get: () => ++reads > 1 });
		await expect(acquireCrossProcessCompilerLease(project, Date.now() + 1_000, controller.signal)).rejects.toThrow("compiler admission aborted");
		held?.release();
	});
});
