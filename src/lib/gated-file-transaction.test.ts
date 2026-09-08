/**
 * Behavior tests for the gated write transaction: baseline capture, the CAS
 * commit, the worktree lock, and the guarded rollback.
 *
 * A real temp worktree drives every case a filesystem can construct — drift,
 * conflicts, deletions, mode preservation, an incumbent lock, a directory
 * removed between capture and staging, a FIFO target. Four node:fs entry
 * points are wrapped as call-through mocks for the failures a disk cannot be
 * talked into producing: a rename that fails mid-batch, a lock body that
 * cannot be written, a temp file that cannot be unlinked, a lock token that
 * cannot be read. Plain `vi.spyOn(fs, ...)` throws "Module namespace is not
 * configurable in ESM" for node:fs, so the module factory is the seam (prior
 * art: src/lib/file-mutation-lock.test.ts). The module under test is never
 * mocked; `actualFs` holds the unwrapped implementations for call-through and
 * for third-party writes a test needs to make behind the transaction's back.
 */
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
		renameSync: vi.fn(actual.renameSync),
		unlinkSync: vi.fn(actual.unlinkSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

import {
	captureGatedWriteBaseline,
	commitGatedWrites,
	GatedWriteConflictError,
	GatedWriteLockError,
	gatedWriteLockPath,
} from "./gated-file-transaction.js";

let root: string;
/** `root` after realpath — the form every transaction path and message uses. */
let realRoot: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-gated-write-"));
	realRoot = realpathSync(root);
});

afterEach(() => {
	vi.mocked(readFileSync).mockReset();
	vi.mocked(renameSync).mockReset();
	vi.mocked(unlinkSync).mockReset();
	vi.mocked(writeFileSync).mockReset();
	rmSync(root, { recursive: true, force: true });
});

function read(path: string): string {
	return readFileSync(join(root, path), "utf-8");
}

/** Returns the error a failing transaction threw, so one call can be inspected. */
function caught(run: () => void): Error {
	try {
		run();
	} catch (error) {
		// SAFETY: every throw site in the module under test throws an Error
		// subclass, and each caller asserts on `name`/`message` only.
		return error as Error;
	}
	throw new Error("expected the gated transaction to fail");
}

/** Fails every rename whose destination ends with `suffix`; others pass through. */
function failRenamesInto(suffix: string): void {
	vi.mocked(renameSync).mockImplementation((oldPath, newPath) => {
		if (String(newPath).endsWith(suffix)) {
			throw Object.assign(new Error("EXDEV: cross-device link not permitted, rename"), {
				code: "EXDEV",
			});
		}
		actualFs.renameSync(oldPath, newPath);
	});
}

/** The lock uses a UTF-8 JSON descriptor write; staging writes Buffer bytes. */
function failLockBodyWrite(): void {
	vi.mocked(writeFileSync).mockImplementation((target, data, options) => {
		if (typeof target === "number" && options === "utf-8") {
			throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
				code: "ENOSPC",
			});
		}
		actualFs.writeFileSync(target, data, options);
	});
}

describe("gated file transaction", () => {
	it("cleans a partially written staging file without changing its target", () => {
		writeFileSync(join(root, "target.txt"), "before");
		const transaction = captureGatedWriteBaseline(root, [{ path: "target.txt", content: "after" }]);
		vi.mocked(writeFileSync).mockImplementationOnce((target, data, options) => {
			actualFs.writeFileSync(target, data, options);
			throw new Error("disk full after partial write");
		});
		expect(() => commitGatedWrites(transaction)).toThrow("disk full after partial write");
		expect(read("target.txt")).toBe("before");
		expect(readdirSync(root).filter((name) => name.includes("interlinked-tx"))).toEqual([]);
	});

	it("commits a multi-file batch and preserves an existing file mode", () => {
		writeFileSync(join(root, "a.txt"), "before-a");
		writeFileSync(join(root, "b.txt"), "before-b");
		chmodSync(join(root, "a.txt"), 0o744);
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "a.txt", content: "after-a" },
			{ path: "b.txt", content: "after-b" },
		]);

		commitGatedWrites(transaction);

		expect(read("a.txt")).toBe("after-a");
		expect(read("b.txt")).toBe("after-b");
		expect(lstatSync(join(root, "a.txt")).mode & 0o7777).toBe(0o744);
		expect(existsSync(gatedWriteLockPath(root))).toBe(false);
	});

	it("aborts the whole batch when any target drifts after capture", () => {
		writeFileSync(join(root, "a.txt"), "before-a");
		writeFileSync(join(root, "b.txt"), "before-b");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "a.txt", content: "after-a" },
			{ path: "b.txt", content: "after-b" },
		]);
		writeFileSync(join(root, "b.txt"), "third-party");

		expect(() => commitGatedWrites(transaction)).toThrow(GatedWriteConflictError);
		expect(read("a.txt")).toBe("before-a");
		expect(read("b.txt")).toBe("third-party");
	});

	it("makes two same-baseline transactions serialize through CAS", () => {
		writeFileSync(join(root, "target.txt"), "base");
		const first = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "first" },
		]);
		const second = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "second" },
		]);

		commitGatedWrites(first);
		expect(() => commitGatedWrites(second)).toThrow(GatedWriteConflictError);
		expect(read("target.txt")).toBe("first");
	});

	it("detects a file created during the gate window", () => {
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "new.txt", content: "ours" },
		]);
		writeFileSync(join(root, "new.txt"), "theirs");

		expect(() => commitGatedWrites(transaction)).toThrow(GatedWriteConflictError);
		expect(read("new.txt")).toBe("theirs");
	});

	it("detects deletion and mode drift during the gate window", () => {
		writeFileSync(join(root, "deleted.txt"), "before");
		writeFileSync(join(root, "mode.txt"), "before");
		const deletion = captureGatedWriteBaseline(root, [
			{ path: "deleted.txt", content: "ours" },
		]);
		const mode = captureGatedWriteBaseline(root, [{ path: "mode.txt", content: "ours" }]);
		rmSync(join(root, "deleted.txt"));
		chmodSync(join(root, "mode.txt"), 0o700);

		expect(() => commitGatedWrites(deletion)).toThrow(GatedWriteConflictError);
		expect(() => commitGatedWrites(mode)).toThrow(GatedWriteConflictError);
		expect(existsSync(join(root, "deleted.txt"))).toBe(false);
		expect(read("mode.txt")).toBe("before");
	});

	it("supports creating and deleting regular files", () => {
		writeFileSync(join(root, "gone.txt"), "remove me");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "created.txt", content: "created", mode: 0o640 },
			{ path: "gone.txt", content: null },
		]);

		commitGatedWrites(transaction);

		expect(read("created.txt")).toBe("created");
		expect(lstatSync(join(root, "created.txt")).mode & 0o7777).toBe(0o640);
		expect(existsSync(join(root, "gone.txt"))).toBe(false);
	});

	it("applies the process umask to a new file's default mode", () => {
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "default-mode.txt", content: "created" },
		]);

		commitGatedWrites(transaction);

		expect(lstatSync(join(root, "default-mode.txt")).mode & 0o7777).toBe(
			0o666 & ~process.umask(),
		);
	});

	it("fails closed on an existing lock and never overwrites it", () => {
		writeFileSync(join(root, "target.txt"), "before");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "after" },
		]);
		const lockPath = gatedWriteLockPath(root);
		mkdirSync(join(root, ".interlinked", "transactions"), { recursive: true });
		writeFileSync(lockPath, JSON.stringify({ token: "incumbent" }));

		expect(() => commitGatedWrites(transaction)).toThrow(GatedWriteLockError);
		expect(read("target.txt")).toBe("before");
		expect(readFileSync(lockPath, "utf-8")).toContain("incumbent");
	});

	it("rejects duplicate, escaping, and symlink targets before gating", () => {
		writeFileSync(join(root, "real.txt"), "real");
		symlinkSync(join(root, "real.txt"), join(root, "link.txt"));

		expect(() =>
			captureGatedWriteBaseline(root, [
				{ path: "real.txt", content: "one" },
				{ path: join(root, "real.txt"), content: "two" },
			]),
		).toThrow(/Duplicate transactional target/);
		expect(() =>
			captureGatedWriteBaseline(root, [{ path: "../outside.txt", content: "no" }]),
		).toThrow(/escapes the Git worktree/);
		expect(() =>
			captureGatedWriteBaseline(root, [{ path: "link.txt", content: "no" }]),
		).toThrow(/regular file or missing/);
	});

	it("cleans transaction temp files after success and conflict", () => {
		writeFileSync(join(root, "target.txt"), "before");
		const success = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "after" },
		]);
		commitGatedWrites(success);
		const conflict = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "loser" },
		]);
		writeFileSync(join(root, "target.txt"), "newer");
		expect(() => commitGatedWrites(conflict)).toThrow(GatedWriteConflictError);

		expect(readdirSync(root).filter((name) => name.includes("interlinked-tx"))).toEqual([]);
	});

	it("surfaces a stat failure that is not a missing file while capturing", () => {
		const tooLongForAnyFilesystem = "n".repeat(300);

		expect(() =>
			captureGatedWriteBaseline(root, [{ path: tooLongForAnyFilesystem, content: "x" }]),
		).toThrow(/ENAMETOOLONG/);
	});

	it("refuses a target that is neither a regular file nor missing", () => {
		const fifo = join(realRoot, "pipe.fifo");
		execFileSync("mkfifo", [fifo]);

		expect(() =>
			captureGatedWriteBaseline(root, [{ path: "pipe.fifo", content: "no" }]),
		).toThrow(`Transactional target must be a regular file or missing: ${fifo}`);
	});

	it("removes every staged temp file when a later write cannot be staged", () => {
		writeFileSync(join(root, "kept.txt"), "before");
		mkdirSync(join(root, "sub"));
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "kept.txt", content: "after" },
			{ path: join("sub", "new.txt"), content: "created" },
		]);
		rmSync(join(root, "sub"), { recursive: true });

		expect(() => commitGatedWrites(transaction)).toThrow(/ENOENT/);
		expect(read("kept.txt")).toBe("before");
		expect(readdirSync(root).filter((name) => name.includes("interlinked-tx"))).toEqual([]);
	});

	it.each([new Error("EBUSY: resource busy or locked, unlink"), "unlink refused"])("keeps the conflict error when a staged temp file cannot be removed: %s", (cleanupError) => {
		writeFileSync(join(root, "target.txt"), "before");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "loser" },
		]);
		writeFileSync(join(root, "target.txt"), "newer");
		vi.mocked(unlinkSync).mockImplementationOnce(() => {
			throw cleanupError;
		});

		expect(() => commitGatedWrites(transaction)).toThrow(GatedWriteConflictError);
		expect(read("target.txt")).toBe("newer");
		expect(readdirSync(root).filter((name) => name.includes("interlinked-tx"))).toHaveLength(1);
	});

	it("removes the lock file when its body cannot be written", () => {
		writeFileSync(join(root, "target.txt"), "before");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "after" },
		]);
		failLockBodyWrite();

		expect(() => commitGatedWrites(transaction)).toThrow(/ENOSPC/);
		expect(existsSync(gatedWriteLockPath(root))).toBe(false);
		expect(read("target.txt")).toBe("before");
	});

	it("leaves the lock file behind when its body and its cleanup both fail", () => {
		writeFileSync(join(root, "target.txt"), "before");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "after" },
		]);
		failLockBodyWrite();
		vi.mocked(unlinkSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" });
		});

		expect(() => commitGatedWrites(transaction)).toThrow(/ENOSPC/);
		expect(existsSync(gatedWriteLockPath(root))).toBe(true);
		expect(read("target.txt")).toBe("before");
	});

	it("refuses to unlink a lock whose ownership token cannot be read", () => {
		writeFileSync(join(root, "target.txt"), "before");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "target.txt", content: "after" },
		]);
		const lockPath = gatedWriteLockPath(root);
		vi.mocked(readFileSync).mockImplementation((path, options) => {
			if (String(path).endsWith("commit.lock")) {
				throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
			}
			return actualFs.readFileSync(path, options);
		});

		const error = caught(() => commitGatedWrites(transaction));

		expect(error).toBeInstanceOf(GatedWriteLockError);
		expect(error.message).toBe(
			`Transactional write lock unavailable at ${lockPath}: ownership token changed; refusing to unlink it`,
		);
		expect(existsSync(lockPath)).toBe(true);
		expect(read("target.txt")).toBe("after");
	});

	it("restores an already-renamed file, mode included, when a later rename fails", () => {
		writeFileSync(join(root, "a.txt"), "before-a");
		writeFileSync(join(root, "b.txt"), "before-b");
		chmodSync(join(root, "a.txt"), 0o744);
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "a.txt", content: "after-a" },
			{ path: "b.txt", content: "after-b" },
		]);
		failRenamesInto("b.txt");

		expect(() => commitGatedWrites(transaction)).toThrow(/EXDEV/);
		expect(read("a.txt")).toBe("before-a");
		expect(read("b.txt")).toBe("before-b");
		expect(lstatSync(join(root, "a.txt")).mode & 0o7777).toBe(0o744);
		expect(existsSync(gatedWriteLockPath(root))).toBe(false);
	});

	it("undoes a committed deletion and a committed creation when a later rename fails", () => {
		writeFileSync(join(root, "del.txt"), "gone-content");
		chmodSync(join(root, "del.txt"), 0o640);
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "del.txt", content: null },
			{ path: "new.txt", content: "created" },
			{ path: "fail.txt", content: "never" },
		]);
		failRenamesInto("fail.txt");

		expect(() => commitGatedWrites(transaction)).toThrow(/EXDEV/);
		expect(read("del.txt")).toBe("gone-content");
		expect(lstatSync(join(root, "del.txt")).mode & 0o7777).toBe(0o640);
		expect(existsSync(join(root, "new.txt"))).toBe(false);
		expect(existsSync(join(root, "fail.txt"))).toBe(false);
	});

	it("refuses to roll back a file another writer changed after the commit", () => {
		writeFileSync(join(root, "a.txt"), "before-a");
		writeFileSync(join(root, "b.txt"), "before-b");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "a.txt", content: "after-a" },
			{ path: "b.txt", content: "after-b" },
		]);
		vi.mocked(renameSync).mockImplementation((oldPath, newPath) => {
			if (String(newPath).endsWith("b.txt")) {
				actualFs.writeFileSync(join(realRoot, "a.txt"), "third-party");
				throw Object.assign(new Error("EXDEV: cross-device link not permitted, rename"), {
					code: "EXDEV",
				});
			}
			actualFs.renameSync(oldPath, newPath);
		});

		const error = caught(() => commitGatedWrites(transaction));

		expect(error.name).toBe("GatedWriteRollbackError");
		expect(error.message).toBe(
			"Transactional write failed (EXDEV: cross-device link not permitted, rename); " +
				`guarded rollback incomplete: ${join(realRoot, "a.txt")}: newer content present; rollback refused`,
		);
		expect(read("a.txt")).toBe("third-party");
	});

	it.each([
		{ failure: new Error("rename refused"), message: "rename refused" },
		{ failure: "rollback refused", message: "rollback refused" },
	])("names the path whose baseline could not be restored and cleans its rollback temp: $message", ({ failure, message }) => {
		writeFileSync(join(root, "a.txt"), "before-a");
		writeFileSync(join(root, "b.txt"), "before-b");
		const transaction = captureGatedWriteBaseline(root, [
			{ path: "a.txt", content: "after-a" },
			{ path: "b.txt", content: "after-b" },
		]);
		let renames = 0;
		vi.mocked(renameSync).mockImplementation((oldPath, newPath) => {
			renames += 1;
			if (renames === 1) {
				actualFs.renameSync(oldPath, newPath);
				return;
			}
			throw failure;
		});

		const error = caught(() => commitGatedWrites(transaction));

		expect(error.name).toBe("GatedWriteRollbackError");
		expect(error.message).toBe(
			`Transactional write failed (${message}); ` +
				`guarded rollback incomplete: ${join(realRoot, "a.txt")}: ${message}`,
		);
		expect(read("a.txt")).toBe("after-a");
		expect(readdirSync(root).filter((name) => name.includes("interlinked-rollback"))).toEqual([]);
	});

	it("reports missing rollback bytes when a transaction carries a non-file baseline", () => {
		// captureGatedWriteBaseline only ever produces "missing" or "file"
		// baselines, so the guard that refuses to restore bytes it never
		// captured is reachable only through a hand-built transaction.
		writeFileSync(join(realRoot, "real.txt"), "real");
		symlinkSync(join(realRoot, "real.txt"), join(realRoot, "link.txt"));
		mkdirSync(join(realRoot, "adir"));

		const error = caught(() =>
			commitGatedWrites({
				id: "handmade-non-file-baseline",
				repoRoot: realRoot,
				writes: [
					{
						path: join(realRoot, "link.txt"),
						content: null,
						mode: null,
						baseline: {
							kind: "symlink",
							mode: lstatSync(join(realRoot, "link.txt")).mode & 0o7777,
							sha256: null,
							content: null,
						},
					},
					{
						path: join(realRoot, "adir"),
						content: null,
						mode: null,
						baseline: {
							kind: "directory",
							mode: lstatSync(join(realRoot, "adir")).mode & 0o7777,
							sha256: null,
							content: null,
						},
					},
				],
			}),
		);

		expect(error.name).toBe("GatedWriteRollbackError");
		expect(error.message).toContain(
			`guarded rollback incomplete: ${join(realRoot, "link.txt")}: Missing rollback bytes for ${join(realRoot, "link.txt")}`,
		);
		expect(existsSync(join(realRoot, "link.txt"))).toBe(false);
		expect(existsSync(join(realRoot, "adir"))).toBe(true);
	});

	it("uses distinct lock paths for distinct worktree roots", () => {
		const other = mkdtempSync(join(tmpdir(), "interlinked-gated-write-other-"));
		try {
			expect(gatedWriteLockPath(other)).not.toBe(gatedWriteLockPath(root));
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});
