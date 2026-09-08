import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Wrap only statSync (call-through by default) so one test can inflate the
// reported file size for the oversized-suffix guard without disturbing every
// other statSync caller in this file or in file-mutation-lock.ts's own lock
// bookkeeping — the vitest-documented workaround for `node:fs` being a
// non-configurable ESM namespace (same pattern as config.mutation-kill.test.ts).
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

import {
	fileIdentity,
	FileIdentityChangedError,
	replaceFileWithSuffix,
} from "./file-suffix-replacement.js";
import {
	appendFileWithMutationLock,
	FileMutationLockTimeoutError,
} from "./file-mutation-lock.js";

describe("append-safe suffix replacement", () => {
	let dir: string;
	let path: string;
	let actualStatSync: typeof statSync;

	beforeAll(async () => {
		({ statSync: actualStatSync } = await vi.importActual<typeof import("node:fs")>("node:fs"));
	});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "suffix-replacement-"));
		path = join(dir, "activity.jsonl");
		writeFileSync(path, "old-1\nold-2\nkeep\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		// Restore the plain passthrough so a test that inflates the reported
		// size (below) never leaks into an unrelated test's statSync calls.
		vi.mocked(statSync).mockImplementation(actualStatSync);
	});

	it("preserves an append injected after the initial suffix copy and before rename", () => {
		const start = Buffer.byteLength("old-1\nold-2\n");
		const prepared = replaceFileWithSuffix(path, start, {
			afterInitialCopy: () => appendFileSync(path, "racing-append\n"),
		});
		expect(readFileSync(path, "utf8")).toBe("keep\nracing-append\n");
		expect(prepared.retainedBytes).toBe(Buffer.byteLength("keep\nracing-append\n"));
	});

	it("publishes source and replacement inode identities before the atomic swap", () => {
		const source = fileIdentity(path);
		let callbackSawReplacement = false;
		const prepared = replaceFileWithSuffix(path, Buffer.byteLength("old-1\n"), {
			expectedSource: source,
			beforeReplace: (pending) => {
				callbackSawReplacement = readFileSync(pending.temporaryPath, "utf8") === "old-2\nkeep\n";
			},
		});
		expect(callbackSawReplacement).toBe(true);
		expect(fileIdentity(path)).toEqual(prepared.replacement);
	});

	it("refuses to replace a different inode than the caller planned", () => {
		const expected = fileIdentity(path);
		const foreignPath = join(dir, "foreign.jsonl");
		writeFileSync(foreignPath, "foreign\n");
		const foreign = fileIdentity(foreignPath);
		expect(foreign).not.toEqual(expected);
		renameSync(foreignPath, path);
		expect(fileIdentity(path)).toEqual(foreign);
		expect(() => replaceFileWithSuffix(path, 0, { expectedSource: expected })).toThrow(
			FileIdentityChangedError,
		);
		expect(readFileSync(path, "utf8")).toBe("foreign\n");
	});

	it("preserves a replacement that arrives while the suffix copy is being prepared", () => {
		const foreignPath = join(dir, "foreign.jsonl");
		writeFileSync(foreignPath, "foreign\n");
		expect(() => replaceFileWithSuffix(path, 0, {
			afterInitialCopy: () => renameSync(foreignPath, path),
		})).toThrow(FileIdentityChangedError);
		expect(readFileSync(path, "utf8")).toBe("foreign\n");
	});

	it("runs afterReplace after the rename but before releasing the append lock", () => {
		let sawReplacement = false;
		const prepared = replaceFileWithSuffix(path, Buffer.byteLength("old-1\n"), {
			afterReplace: (replacement) => {
				sawReplacement = fileIdentity(path).ino === replacement.replacement.ino;
				expect(() =>
					appendFileWithMutationLock(path, "overlap\n", { waitMs: 0 }),
				).toThrow(FileMutationLockTimeoutError);
			},
		});
		expect(sawReplacement).toBe(true);
		expect(fileIdentity(path)).toEqual(prepared.replacement);
		expect(readFileSync(path, "utf8")).toBe("old-2\nkeep\n");
	});

	it("rejects a suffix start outside the source file's byte range", () => {
		expect(() => replaceFileWithSuffix(path, -1)).toThrow(
			"invalid suffix start -1 for 17-byte file",
		);
	});

	it("copies a large suffix outside the append lock and catches up participating writers", () => {
		const size = 65 * 1024 * 1024;
		truncateSync(path, size);
		const prepared = replaceFileWithSuffix(path, 0, {
			afterInitialCopy: () => appendFileWithMutationLock(path, "tail\n", { waitMs: 0 }),
		});
		expect(prepared.retainedBytes).toBe(size + 5);
		expect(statSync(path).size).toBe(size + 5);
	});

	it("refuses an oversized catch-up without replacing the original file", () => {
		const inflatedSize = actualStatSync(path).size + 64 * 1024 * 1024 + 1;
		const afterInitialCopy = () => vi.mocked(statSync).mockImplementation((target, options) => {
			if (target === path && options === undefined) {
				return { ...actualStatSync(path), size: inflatedSize };
			}
			// SAFETY: `options` is exactly what the caller passed to the mocked
			// statSync; forwarding it verbatim to the real implementation is the
			// whole point of the passthrough branch.
			return actualStatSync(target, options);
		});
		expect(() => replaceFileWithSuffix(path, 0, { afterInitialCopy })).toThrow(
			`refusing to hold the append lock while copying ${64 * 1024 * 1024 + 1} catch-up bytes`,
		);
		expect(readFileSync(path, "utf8")).toBe("old-1\nold-2\nkeep\n");
	});
});
