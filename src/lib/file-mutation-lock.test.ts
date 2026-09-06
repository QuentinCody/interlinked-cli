import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	rmdirSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: spies on statSync/unlinkSync/writeFileSync only (call-through to
// the real implementation by default) while every other fs export stays
// untouched. Plain `vi.spyOn(fs, ...)` throws "Module namespace is not
// configurable in ESM" for node:fs — this is the vitest-documented
// workaround (see src/lib/config.mutation-kill.test.ts for the prior art).
// Used only for the handful of races that have no real filesystem
// construction (a value read successfully then vanishing before the very
// next synchronous statement, with no test seam in between); every other
// case in this file drives genuine fs errors (EACCES via chmod, ENOENT via
// beforeRetireObserved) rather than mocking.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		rmdirSync: vi.fn(actual.rmdirSync),
		statSync: vi.fn(actual.statSync),
		unlinkSync: vi.fn(actual.unlinkSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

import {
	appendFileWithMutationLock,
	fileMutationLockPath,
	fileMutationLockOwnerPath,
	FileMutationLockTimeoutError,
	observeLock,
	withFileMutationLock,
} from "./file-mutation-lock.js";

describe("file mutation lock", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "file-mutation-lock-"));
		path = join(dir, "activity.jsonl");
		writeFileSync(path, "before\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function seedOwner(pid: number, token: string, acquiredAtMs: number): string {
		const lockPath = fileMutationLockPath(path);
		mkdirSync(lockPath);
		const ownerPath = fileMutationLockOwnerPath(path, token);
		writeFileSync(ownerPath, JSON.stringify({ pid, token, acquired_at_ms: acquiredAtMs }));
		return ownerPath;
	}

	const CURRENT_IDENTITY = {
		bootId: "test-boot-current",
		bootStartedAtMs: 10_000,
		processStartId: "test-process-current",
		processStartedAtMs: 20_000,
	};

	function seedIdentifiedOwner(owner: {
		pid: number;
		token: string;
		acquiredAtMs: number;
		bootId: string;
		processStartId: string;
	}): string {
		const ownerPath = seedOwner(owner.pid, owner.token, owner.acquiredAtMs);
		writeFileSync(
			ownerPath,
			JSON.stringify({
				pid: owner.pid,
				token: owner.token,
				acquired_at_ms: owner.acquiredAtMs,
				boot_id: owner.bootId,
				process_start_id: owner.processStartId,
			}),
		);
		return ownerPath;
	}

	it("rejects an owner file whose directory does not match the claimed path's own lock path", () => {
		// `observeLock(path, lockPath)` trusts its two arguments to be a matched
		// pair (every production caller derives both from the same `path` via
		// `fileMutationLockPath`). This directly exercises the defensive branch
		// that catches a mismatched pair: a validly-named, validly-parsed owner
		// entry sitting in a lock directory that does not belong to `path`.
		const otherPath = join(dir, "other.jsonl");
		const otherLockPath = fileMutationLockPath(otherPath);
		mkdirSync(otherLockPath);
		const token = "mismatched-owner";
		const ownerPath = fileMutationLockOwnerPath(otherPath, token);
		writeFileSync(
			ownerPath,
			JSON.stringify({ pid: process.pid, token, acquired_at_ms: 1 }),
		);

		const observation = observeLock(path, otherLockPath);

		expect(observation?.entries).toEqual([`owner-${token}.json`]);
		expect(observation?.owner).toBeNull();
		expect(observation?.ownerPath).toBeNull();
	});

	it("serializes an append and releases its PID/token owner record", () => {
		appendFileWithMutationLock(path, "after\n");
		expect(readFileSync(path, "utf8")).toBe("before\nafter\n");
		expect(existsSync(fileMutationLockPath(path))).toBe(false);
	});

	it("publishes boot and process-start identity with a live owner", () => {
		withFileMutationLock(path, () => {
			const lockPath = fileMutationLockPath(path);
			const entry = readdirSync(lockPath)[0];
			expect(entry).toBeDefined();
			const owner = JSON.parse(readFileSync(join(lockPath, entry ?? ""), "utf8"));
			expect(owner.boot_id).toMatch(/^(darwin|linux):/);
			expect(owner.process_start_id).toMatch(/^(darwin|linux):/);
		});
	});

	it("recovers a pre-reboot lock even when its PID now belongs to a live process", () => {
		seedIdentifiedOwner({
			pid: process.pid,
			token: "pre-reboot-owner",
			acquiredAtMs: 1,
			bootId: "test-boot-before-restart",
			processStartId: "test-process-before-restart",
		});
		appendFileWithMutationLock(path, "after-reboot\n", {
			waitMs: 50,
			identityProvider: () => CURRENT_IDENTITY,
		});
		expect(readFileSync(path, "utf8")).toBe("before\nafter-reboot\n");
	});

	it("recovers same-boot PID reuse from a changed process-start identity", () => {
		seedIdentifiedOwner({
			pid: process.pid,
			token: "reused-pid-owner",
			acquiredAtMs: 25_000,
			bootId: CURRENT_IDENTITY.bootId,
			processStartId: "test-process-before-reuse",
		});
		appendFileWithMutationLock(path, "after-reuse\n", {
			waitMs: 50,
			identityProvider: () => CURRENT_IDENTITY,
		});
		expect(readFileSync(path, "utf8")).toBe("before\nafter-reuse\n");
	});

	it("recovers PID reuse from a matching boot-only owner record", () => {
		const ownerPath = seedOwner(process.pid, "boot-only-owner", 10_000);
		writeFileSync(
			ownerPath,
			JSON.stringify({
				pid: process.pid,
				token: "boot-only-owner",
				acquired_at_ms: 10_000,
				boot_id: CURRENT_IDENTITY.bootId,
			}),
		);
		appendFileWithMutationLock(path, "boot-only-recovered\n", {
			waitMs: 50,
			identityProvider: () => ({
				...CURRENT_IDENTITY,
				bootStartedAtMs: 1,
				processStartedAtMs: 20_000,
			}),
		});
		expect(readFileSync(path, "utf8")).toBe("before\nboot-only-recovered\n");
	});

	it("recovers a start-only record whose boot-relative id was reused later", () => {
		const ownerPath = seedOwner(process.pid, "start-only-owner", 10_000);
		writeFileSync(
			ownerPath,
			JSON.stringify({
				pid: process.pid,
				token: "start-only-owner",
				acquired_at_ms: 10_000,
				process_start_id: CURRENT_IDENTITY.processStartId,
			}),
		);
		appendFileWithMutationLock(path, "start-only-recovered\n", {
			waitMs: 50,
			identityProvider: () => ({
				...CURRENT_IDENTITY,
				bootStartedAtMs: 20_000,
				processStartedAtMs: 20_000,
			}),
		});
		expect(readFileSync(path, "utf8")).toBe("before\nstart-only-recovered\n");
	});

	it("never reaps a genuinely live owner with matching identity", () => {
		seedIdentifiedOwner({
			pid: process.pid,
			token: "live-identified-owner",
			acquiredAtMs: 25_000,
			bootId: CURRENT_IDENTITY.bootId,
			processStartId: CURRENT_IDENTITY.processStartId,
		});
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				clock: () => 25_001,
				identityProvider: () => CURRENT_IDENTITY,
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("protects a live identity-bearing owner when the OS probe is unavailable", () => {
		seedIdentifiedOwner({
			pid: process.pid,
			token: "live-owner-probe-unavailable",
			acquiredAtMs: 25_000,
			bootId: CURRENT_IDENTITY.bootId,
			processStartId: CURRENT_IDENTITY.processStartId,
		});
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				clock: () => 25_001,
				identityProvider: () => {
					throw new Error("identity unavailable");
				},
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("recovers a pre-identity legacy record proven to predate this boot", () => {
		seedOwner(process.pid, "legacy-prior-boot", 1);
		appendFileWithMutationLock(path, "legacy-recovered\n", {
			waitMs: 50,
			identityProvider: () => CURRENT_IDENTITY,
		});
		expect(readFileSync(path, "utf8")).toBe("before\nlegacy-recovered\n");
	});

	it("recovers same-boot PID reuse for a pre-identity Linux-style record", () => {
		seedOwner(process.pid, "legacy-same-boot-reuse", 10_000);
		appendFileWithMutationLock(path, "legacy-same-boot-recovered\n", {
			waitMs: 50,
			identityProvider: () => ({
				...CURRENT_IDENTITY,
				bootStartedAtMs: 1,
				processStartedAtMs: 20_000,
			}),
		});
		expect(readFileSync(path, "utf8")).toBe("before\nlegacy-same-boot-recovered\n");
	});

	it("protects an ambiguous live legacy owner when identity is unavailable", () => {
		seedOwner(process.pid, "legacy-live-unknown", 25_000);
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				clock: () => 25_001,
				identityProvider: () => ({
					bootId: null,
					bootStartedAtMs: null,
					processStartId: null,
					processStartedAtMs: null,
				}),
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("never bypasses a held lock when append contention times out", () => {
		expect(() =>
			withFileMutationLock(path, () => {
				appendFileWithMutationLock(path, "lost\n", { waitMs: 0 });
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("recovers a lock whose recorded owner process is dead", () => {
		seedOwner(2_147_483_647, "dead-owner", 1);
		appendFileWithMutationLock(path, "recovered\n", { waitMs: 50 });
		expect(readFileSync(path, "utf8")).toBe("before\nrecovered\n");
	});

	it("recovers dead and stale legacy single-file locks during rolling upgrade", () => {
		const lockPath = fileMutationLockPath(path);
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 2_147_483_647, token: "legacy-dead", acquired_at_ms: 1 }),
		);
		appendFileWithMutationLock(path, "after-dead\n", { waitMs: 50 });

		writeFileSync(lockPath, "legacy-malformed");
		const old = new Date(1_000);
		utimesSync(lockPath, old, old);
		appendFileWithMutationLock(path, "after-stale\n", {
			waitMs: 50,
			staleMs: 10,
			clock: () => 20_000,
		});
		expect(readFileSync(path, "utf8")).toBe("before\nafter-dead\nafter-stale\n");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("recovers an old malformed lock but does not treat a fresh one as abandoned", () => {
		const lockPath = fileMutationLockPath(path);
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "not-an-owner"), "not-json");
		const old = new Date(1_000);
		utimesSync(lockPath, old, old);
		appendFileWithMutationLock(path, "recovered\n", {
			waitMs: 50,
			staleMs: 10,
			clock: () => 20_000,
		});
		expect(readFileSync(path, "utf8")).toContain("recovered");

		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "still-publishing"), "not-json");
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				staleMs: 60_000,
				clock: () => 20_001,
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).not.toContain("bypassed");
	});

	it("treats an invalid-token owner record as malformed and recovers it only when stale", () => {
		const lockPath = fileMutationLockPath(path);
		mkdirSync(lockPath);
		writeFileSync(
			join(lockPath, "owner-bad token.json"),
			JSON.stringify({ pid: process.pid, token: "bad token", acquired_at_ms: 1 }),
		);
		const old = new Date(1_000);
		utimesSync(lockPath, old, old);
		appendFileWithMutationLock(path, "invalid-token-recovered\n", {
			waitMs: 50,
			staleMs: 10,
			clock: () => 20_000,
		});
		expect(readFileSync(path, "utf8")).toContain("invalid-token-recovered");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("does not require the target to exist before the first append", () => {
		const freshDir = join(dir, "nested");
		mkdirSync(freshDir);
		const fresh = join(freshDir, "collection.jsonl");
		appendFileWithMutationLock(fresh, "first\n");
		expect(readFileSync(fresh, "utf8")).toBe("first\n");
	});

	it("serializes a real child-process writer instead of letting it append around contention", async () => {
		const lockPath = fileMutationLockPath(path);
		const ownerPath = seedOwner(process.pid, "parent-owner", Date.now());
		const moduleUrl = new URL("./file-mutation-lock.ts", import.meta.url).href;
		const source = [
			`import { appendFileWithMutationLock } from ${JSON.stringify(moduleUrl)};`,
			`process.stdout.write("ready\\n");`,
			`appendFileWithMutationLock(process.env.INTERLINKED_TEST_TARGET, "child\\n", { waitMs: 2000 });`,
		].join("\n");
		const child = spawn(process.execPath, ["--import", "tsx", "--eval", source], {
			env: { ...process.env, INTERLINKED_TEST_TARGET: path },
			stdio: ["ignore", "pipe", "pipe"],
		});
		await once(child.stdout, "data");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(readFileSync(path, "utf8")).toBe("before\n");
		rmSync(ownerPath);
		rmdirSync(lockPath);
		const [exitCode] = await once(child, "exit");
		expect(exitCode).toBe(0);
		expect(readFileSync(path, "utf8")).toBe("before\nchild\n");
	});

	it("a stale second recoverer cannot unlink the live successor acquired by the first", () => {
		const lockPath = fileMutationLockPath(path);
		const deadOwner = seedOwner(2_147_483_647, "dead-race-owner", 1);
		const successor = fileMutationLockOwnerPath(path, "successor-owner");

		expect(() =>
			appendFileWithMutationLock(path, "overlap\n", {
				waitMs: 0,
				beforeRetireObserved: () => {
					// Recoverer A retires the exact dead token and acquires its own
					// directory before recoverer B acts on its stale observation.
					rmSync(deadOwner);
					rmdirSync(lockPath);
					mkdirSync(lockPath);
					writeFileSync(
						successor,
						JSON.stringify({
							pid: process.pid,
							token: "successor-owner",
							acquired_at_ms: Date.now(),
						}),
					);
				},
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(successor, "utf8")).toContain("successor-owner");
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("treats an owner record with an invalid acquired-at timestamp as malformed and recovers it once stale", () => {
		const lockPath = fileMutationLockPath(path);
		const ownerPath = seedOwner(process.pid, "bad-timestamp-owner", 10_000);
		writeFileSync(
			ownerPath,
			JSON.stringify({
				pid: process.pid,
				token: "bad-timestamp-owner",
				acquired_at_ms: 0,
				boot_id: CURRENT_IDENTITY.bootId,
				process_start_id: CURRENT_IDENTITY.processStartId,
			}),
		);
		const old = new Date(1_000);
		utimesSync(lockPath, old, old);
		appendFileWithMutationLock(path, "invalid-timestamp-recovered\n", {
			waitMs: 50,
			staleMs: 10,
			clock: () => 20_000,
			identityProvider: () => CURRENT_IDENTITY,
		});
		expect(readFileSync(path, "utf8")).toBe("before\ninvalid-timestamp-recovered\n");
	});

	it("never recovers the same record once its timestamp is valid and its identity matches the live owner", () => {
		// Mirrors the case above with only acquired_at_ms changed (0 -> 1): if the
		// acquired_at_ms<=0 guard were removed, parseOwner would accept this record
		// and the matching boot/process identity would read it as a live, non-stale
		// owner, so recovery must be refused rather than falling through some other path.
		const ownerPath = seedOwner(process.pid, "bad-timestamp-owner", 10_000);
		writeFileSync(
			ownerPath,
			JSON.stringify({
				pid: process.pid,
				token: "bad-timestamp-owner",
				acquired_at_ms: 1,
				boot_id: CURRENT_IDENTITY.bootId,
				process_start_id: CURRENT_IDENTITY.processStartId,
			}),
		);
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				identityProvider: () => CURRENT_IDENTITY,
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("treats a lock directory it cannot list as malformed and recovers it once stale", () => {
		const lockPath = fileMutationLockPath(path);
		mkdirSync(lockPath);
		const old = new Date(1_000);
		utimesSync(lockPath, old, old);
		chmodSync(lockPath, 0o000);
		appendFileWithMutationLock(path, "unreadable-dir-recovered\n", {
			waitMs: 50,
			staleMs: 10,
			clock: () => 20_000,
		});
		expect(readFileSync(path, "utf8")).toBe("before\nunreadable-dir-recovered\n");
	});

	it("treats an unmeasurable lock age as fresh, refusing to recover it even when the directory is old", () => {
		const lockPath = fileMutationLockPath(path);
		mkdirSync(lockPath);
		const old = new Date(1_000);
		utimesSync(lockPath, old, old);
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("EIO: input/output error, stat"), { code: "EIO" });
		});
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				staleMs: 1,
				clock: () => 50_000,
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("stops recovery when a stale peer already removed the sole observed entry", () => {
		const lockPath = fileMutationLockPath(path);
		mkdirSync(lockPath);
		const junkPath = join(lockPath, "not-an-owner");
		writeFileSync(junkPath, "not-json");
		const old = new Date(1_000);
		utimesSync(lockPath, old, old);
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				staleMs: 10,
				clock: () => 20_000,
				beforeRetireObserved: () => {
					unlinkSync(junkPath);
				},
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
		expect(existsSync(lockPath)).toBe(true);
	});

	it("stops recovery when a stale peer removes a later observed entry mid-cleanup", () => {
		const lockPath = fileMutationLockPath(path);
		mkdirSync(lockPath);
		const first = join(lockPath, "junk-a");
		const second = join(lockPath, "junk-b");
		writeFileSync(first, "not-json");
		writeFileSync(second, "not-json");
		const old = new Date(1_000);
		utimesSync(lockPath, old, old);
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				staleMs: 10,
				clock: () => 20_000,
				beforeRetireObserved: () => {
					unlinkSync(second);
				},
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
		expect(existsSync(first)).toBe(false);
		expect(existsSync(second)).toBe(false);
		expect(existsSync(lockPath)).toBe(true);
	});

	it("stops recovery when a new entry appears in the lock directory during cleanup", () => {
		const lockPath = fileMutationLockPath(path);
		const ownerPath = seedOwner(2_147_483_647, "late-arrival-owner", 1);
		let ticks = 0;
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 0,
				clock: () => {
					ticks++;
					return 20_000;
				},
				identityProvider: () => CURRENT_IDENTITY,
				beforeRetireObserved: () => {
					writeFileSync(join(lockPath, "late-arrival.json"), "{}");
				},
			}),
		).toThrow(FileMutationLockTimeoutError);
		expect(readFileSync(path, "utf8")).toBe("before\n");
		expect(existsSync(ownerPath)).toBe(false);
		expect(existsSync(join(lockPath, "late-arrival.json"))).toBe(true);
		expect(existsSync(lockPath)).toBe(true);
		// 1 startedAt + 1 recovery-attempt "now" + 1 final waitMs check. If the
		// ENOTEMPTY rmdir failure were misread as success, recovery would loop
		// back for a second doomed attempt against the still-there late arrival
		// (mkdirSync EEXIST, then a fresh observation) before finally timing
		// out — 4 clock() calls instead of 3.
		expect(ticks).toBe(3);
	});

	it("continues recovery when the lock directory vanishes out from under an in-progress rmdir", () => {
		// removeEmptyLockDirectory's ENOENT branch (a peer already removed the
		// directory between our unlink and our own rmdir) has no synchronous fs
		// seam to race for real, so the one rmdirSync call is stubbed to actually
		// delete the directory itself and then report ENOENT — reproducing exactly
		// what a real concurrent removal would leave behind: the directory gone,
		// and this call throwing "no such directory".
		//
		// The final "recovered" content alone does NOT discriminate this branch:
		// since the directory is genuinely gone either way, a wrongly-false
		// removeEmptyLockDirectory just costs one extra sleep()+retry before the
		// next mkdirSync succeeds against the same vanished directory — same end
		// state. Counting clock() calls does discriminate: correctly reading
		// ENOENT as "already gone" lets the loop `continue` immediately (no waitMs
		// check that iteration); misreading it falls through to that check first.
		const lockPath = fileMutationLockPath(path);
		seedOwner(2_147_483_647, "vanishing-dir-owner", 1);
		vi.mocked(rmdirSync).mockImplementationOnce(() => {
			rmSync(lockPath, { recursive: true, force: true });
			throw Object.assign(new Error("ENOENT: no such file or directory, rmdir 'lock'"), {
				code: "ENOENT",
			});
		});
		let ticks = 0;
		appendFileWithMutationLock(path, "recovered-after-vanished-dir\n", {
			waitMs: 50,
			clock: () => {
				ticks++;
				return 20_000;
			},
			identityProvider: () => CURRENT_IDENTITY,
		});
		expect(readFileSync(path, "utf8")).toBe("before\nrecovered-after-vanished-dir\n");
		expect(existsSync(lockPath)).toBe(false);
		// 1 startedAt + 1 recovery-attempt "now". Misreading ENOENT as failure
		// would add a 3rd call (the waitMs check) before falling through to sleep
		// and only then retrying into the same successful mkdirSync.
		expect(ticks).toBe(2);
	});

	it("sleeps between contended retries instead of spinning through them all at once", () => {
		seedIdentifiedOwner({
			pid: process.pid,
			token: "live-owner-retry-sleep",
			acquiredAtMs: 25_000,
			bootId: CURRENT_IDENTITY.bootId,
			processStartId: CURRENT_IDENTITY.processStartId,
		});
		let identityCalls = 0;
		expect(() =>
			appendFileWithMutationLock(path, "bypassed\n", {
				waitMs: 25,
				retryMs: 5,
				identityProvider: () => {
					identityCalls++;
					return CURRENT_IDENTITY;
				},
			}),
		).toThrow(FileMutationLockTimeoutError);
		// The live owner's identity is re-checked once per retry attempt (plus one
		// up front for this process's own identity), so a real ~5ms sleep between
		// attempts bounds this to a handful of calls over the 25ms budget. A
		// removed or no-op sleep() turns the wait into a hot spin loop that would
		// call the identity provider many thousands of times in the same window —
		// a wall-clock-only assertion here cannot tell the two apart, since
		// Date.now() advances at the same real rate whether or not the loop sleeps.
		expect(identityCalls).toBeGreaterThan(1);
		expect(identityCalls).toBeLessThan(50);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("treats a release-time lock file already removed as a clean release, not an error", () => {
		vi.mocked(unlinkSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("ENOENT: no such file or directory, unlink 'owner'"), {
				code: "ENOENT",
			});
		});
		const result = withFileMutationLock(path, () => {
			appendFileSync(path, "released-cleanly\n");
			return "action-result";
		});
		expect(result).toBe("action-result");
		expect(readFileSync(path, "utf8")).toBe("before\nreleased-cleanly\n");
	});

	it("propagates a non-ENOENT release failure instead of masking it as a clean release", () => {
		const lockPath = fileMutationLockPath(path);
		expect(() =>
			withFileMutationLock(path, () => {
				appendFileSync(path, "before-release-failure\n");
				chmodSync(lockPath, 0o500);
			}),
		).toThrow(/EACCES|EPERM/);
		chmodSync(lockPath, 0o755);
		expect(readFileSync(path, "utf8")).toBe("before\nbefore-release-failure\n");
	});

	it("propagates a non-EEXIST failure when the lock directory cannot be created", () => {
		chmodSync(dir, 0o500);
		expect(() => appendFileWithMutationLock(path, "unreachable\n")).toThrow(/EACCES|EPERM/);
		chmodSync(dir, 0o755);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("retries after a transient ENOENT during lease creation instead of failing outright", () => {
		vi.mocked(writeFileSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("ENOENT: no such file or directory, open 'owner'"), {
				code: "ENOENT",
			});
		});
		appendFileWithMutationLock(path, "healed-after-transient-enoent\n");
		expect(readFileSync(path, "utf8")).toBe("before\nhealed-after-transient-enoent\n");
	});

	it("propagates a non-transient lease-write failure instead of silently retrying", () => {
		vi.mocked(writeFileSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("EACCES: permission denied, open 'owner'"), {
				code: "EACCES",
			});
		});
		expect(() => appendFileWithMutationLock(path, "unreachable\n")).toThrow(/EACCES/);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});
});
