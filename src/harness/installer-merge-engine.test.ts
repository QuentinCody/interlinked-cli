// Companion tests for installer-merge-engine.ts — merge engine, JSON-pointer
// path helpers, and low-level fs helpers extracted from installer.ts.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../lib/json-types.js";

// Default-delegating wrappers: every existing test's real fs behavior is
// unaffected (each routes to `actual.*` unless a specific test overrides the
// implementation for one call via `mockImplementationOnce`, which self-resets
// after firing) — the seam that lets the mode-preservation catch blocks below
// be exercised without touching the module under test. Declared via
// vi.hoisted() (not a bare top-level const) because the vi.mock factory below
// is itself hoisted above ordinary module-level statements and would
// otherwise read these before their `const` initializers ran.
const { rmSyncMock, chmodSyncMock, statSyncMock } = vi.hoisted(() => ({
	rmSyncMock: vi.fn(),
	chmodSyncMock: vi.fn(),
	statSyncMock: vi.fn(),
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	chmodSyncMock.mockImplementation((...args: Parameters<typeof actual.chmodSync>) =>
		actual.chmodSync(...args),
	);
	statSyncMock.mockImplementation((...args: Parameters<typeof actual.statSync>) => actual.statSync(...args));
	return {
		...actual,
		rmSync: (...args: Parameters<typeof actual.rmSync>) => {
			rmSyncMock(...args);
			return actual.rmSync(...args);
		},
		chmodSync: (...args: Parameters<typeof actual.chmodSync>) => chmodSyncMock(...args),
		statSync: (...args: Parameters<typeof actual.statSync>) => statSyncMock(...args),
	};
});

const {
	ensureDir,
	mergeSettings,
	readJson,
	removeJsonPath,
	restoreTextFile,
	snapshotTextFile,
	writeAtomic,
	writeTextAtomic,
} = await import("./installer-merge-engine.js");

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "merge-engine-"));
	rmSyncMock.mockClear();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// -----------------------------------------------------------------------------
// mergeSettings
// -----------------------------------------------------------------------------

describe("mergeSettings", () => {
	it("returns target unchanged when fragment is null", () => {
		const target: JsonObject = { a: 1 };
		expect(mergeSettings(target, null, "deep-merge", "", [])).toBe(target);
		expect(target).toEqual({ a: 1 });
	});

	it("returns target unchanged when fragment is a non-object scalar", () => {
		const target: JsonObject = { a: 1 };
		expect(mergeSettings(target, "not an object", "deep-merge", "", [])).toBe(target);
		expect(target).toEqual({ a: 1 });
	});

	it("returns target unchanged when fragment is an array", () => {
		const target: JsonObject = { a: 1 };
		expect(mergeSettings(target, [1, 2], "deep-merge", "", [])).toBe(target);
		expect(target).toEqual({ a: 1 });
	});

	it("deep-merges a plain-object fragment, recording added scalar paths", () => {
		const target: JsonObject = { existing: "keep" };
		const added: string[] = [];
		const result = mergeSettings(target, { newKey: "value" }, "deep-merge", "", added);
		expect(result).toEqual({ existing: "keep", newKey: "value" });
		expect(added).toEqual(["newKey"]);
	});

	it("does not clobber an existing scalar value", () => {
		const target: JsonObject = { key: "original" };
		const added: string[] = [];
		mergeSettings(target, { key: "incoming" }, "deep-merge", "", added);
		expect(target.key).toBe("original");
		expect(added).toEqual([]);
	});

	it("recurses into nested objects, creating a fresh object when absent", () => {
		const target: JsonObject = {};
		const added: string[] = [];
		mergeSettings(target, { nested: { inner: 1 } }, "deep-merge", "", added);
		expect(target).toEqual({ nested: { inner: 1 } });
		expect(added).toEqual(["nested.inner"]);
	});

	it("merges into an existing nested object rather than replacing it", () => {
		const target: JsonObject = { nested: { keep: "yes" } };
		const added: string[] = [];
		mergeSettings(target, { nested: { added: "new" } }, "deep-merge", "", added);
		expect(target).toEqual({ nested: { keep: "yes", added: "new" } });
	});
});

// -----------------------------------------------------------------------------
// mergeArrayField (via mergeSettings, since it is not exported directly)
// -----------------------------------------------------------------------------

describe("mergeSettings — array fields", () => {
	it("replaces the array wholesale under replace-key strategy", () => {
		const target: JsonObject = { list: [1, 2] };
		const added: string[] = [];
		mergeSettings(target, { list: [9] }, "replace-key", "", added);
		expect(target.list).toEqual([9]);
		expect(added).toEqual(["list"]);
	});

	it("appends items and records owned indices under array-append strategy", () => {
		const target: JsonObject = { list: ["a"] };
		const added: string[] = [];
		mergeSettings(target, { list: ["b", "c"] }, "array-append", "", added);
		expect(target.list).toEqual(["a", "b", "c"]);
		expect(added).toEqual(["list[1]", "list[2]"]);
	});

	it("treats a missing array field as empty before appending", () => {
		const target: JsonObject = {};
		const added: string[] = [];
		mergeSettings(target, { list: ["only"] }, "deep-merge", "", added);
		expect(target.list).toEqual(["only"]);
		expect(added).toEqual(["list[0]"]);
	});
});

// -----------------------------------------------------------------------------
// removeJsonPath
// -----------------------------------------------------------------------------

describe("removeJsonPath", () => {
	it("returns false for a null target", () => {
		expect(removeJsonPath(null, "a")).toBe(false);
	});

	it("returns false for a non-object primitive target", () => {
		expect(removeJsonPath("scalar", "a")).toBe(false);
	});

	it("returns false for an empty path (no segments)", () => {
		expect(removeJsonPath({ a: 1 }, "")).toBe(false);
	});

	it("deletes a top-level key and returns true", () => {
		const target: JsonObject = { a: 1, b: 2 };
		expect(removeJsonPath(target, "a")).toBe(true);
		expect(target).toEqual({ b: 2 });
	});

	it("returns false when the top-level key is absent", () => {
		const target: JsonObject = { a: 1 };
		expect(removeJsonPath(target, "missing")).toBe(false);
		expect(target).toEqual({ a: 1 });
	});

	it("deletes a nested key across multiple segments", () => {
		const target: JsonObject = { a: { b: { c: 1, keep: 2 } } };
		expect(removeJsonPath(target, "a.b.c")).toBe(true);
		expect(target).toEqual({ a: { b: { keep: 2 } } });
	});

	it("deletes an array element by bracket index", () => {
		const target: JsonObject = { list: [1, 2, 3] };
		expect(removeJsonPath(target, "list[1]")).toBe(true);
		expect(target.list).toEqual([1, 3]);
	});

	it("removes a bracket-only path segment on an array target", () => {
		const target: unknown = [1, 2, 3];
		expect(removeJsonPath(target, "[0]")).toBe(true);
		expect(target).toEqual([2, 3]);
	});

	it("returns false for an out-of-range array index", () => {
		const target: JsonObject = { list: [1, 2] };
		expect(removeJsonPath(target, "list[5]")).toBe(false);
		expect(target.list).toEqual([1, 2]);
	});

	it("returns false for a negative array index", () => {
		const target: JsonObject = { list: [1, 2] };
		expect(removeJsonPath(target, "list[-1]")).toBe(false);
	});

	it("returns false when an index segment targets a non-array cursor", () => {
		const target: JsonObject = { a: {} };
		expect(removeJsonPath(target, "a[0]")).toBe(false);
	});

	it("returns false when a mid-path key segment steps through an array cursor", () => {
		const target: JsonObject = { a: [1, 2] };
		expect(removeJsonPath(target, "a.b.c")).toBe(false);
	});

	it("returns false when a mid-path key segment steps through a primitive cursor", () => {
		const target: JsonObject = { a: 5 };
		expect(removeJsonPath(target, "a.b.c")).toBe(false);
	});

	it("steps through an array via an index segment mid-path", () => {
		const target: JsonObject = { a: [{ b: { c: 1 } }] };
		expect(removeJsonPath(target, "a[0].b.c")).toBe(true);
		expect(target).toEqual({ a: [{ b: {} }] });
	});

	it("returns false when the final key segment targets a non-object cursor", () => {
		const target: JsonObject = { a: 5 };
		expect(removeJsonPath(target, "a.b")).toBe(false);
	});

	it("returns false when the final key segment targets an array cursor", () => {
		const target: JsonObject = { a: [1, 2] };
		expect(removeJsonPath(target, "a.b")).toBe(false);
	});

	it("returns false when a mid-path index segment targets a non-array cursor", () => {
		// "a[0].b": the index segment is NOT last, so it is resolved via the
		// internal `step` helper (not the final-segment branch in removeJsonPath).
		const target: JsonObject = { a: {} };
		expect(removeJsonPath(target, "a[0].b")).toBe(false);
	});

	it("skips a bracket index too large to be a finite number", () => {
		const hugeDigits = "9".repeat(400);
		const target: JsonObject = { list: [1, 2] };
		// The huge index parses to a non-finite number, so parsePath drops the
		// index segment entirely, leaving only the "list" key segment.
		expect(removeJsonPath(target, `list[${hugeDigits}]`)).toBe(true);
		expect(target.list).toBeUndefined();
	});
});

// -----------------------------------------------------------------------------
// readJson
// -----------------------------------------------------------------------------

describe("readJson", () => {
	it("returns an empty object when the file does not exist", () => {
		expect(readJson(join(tmp, "missing.json"))).toEqual({});
	});

	it("returns an empty object when the read throws (e.g. path is a directory)", () => {
		const dirPath = join(tmp, "a-directory");
		mkdirSync(dirPath);
		expect(readJson(dirPath)).toEqual({});
	});

	it("returns null when the file contains invalid JSON", () => {
		const p = join(tmp, "bad.json");
		writeFileSync(p, "{ not valid json");
		expect(readJson(p)).toBeNull();
	});

	it("returns null when the parsed settings root is an array", () => {
		const p = join(tmp, "array.json");
		writeFileSync(p, "[]\n");
		expect(readJson(p)).toBeNull();
	});

	it("returns an empty object when the parsed JSON is not an object", () => {
		const p = join(tmp, "scalar.json");
		writeFileSync(p, "42");
		expect(readJson(p)).toEqual({});
	});

	it("returns the parsed object for valid JSON", () => {
		const p = join(tmp, "good.json");
		writeFileSync(p, JSON.stringify({ hello: "world" }));
		expect(readJson(p)).toEqual({ hello: "world" });
	});
});

// -----------------------------------------------------------------------------
// writeAtomic / ensureDir
// -----------------------------------------------------------------------------

describe("writeAtomic", () => {
	it("creates parent directories and writes JSON atomically", () => {
		const p = join(tmp, "nested", "dir", "out.json");
		writeAtomic(p, { hello: "world" });
		expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ hello: "world" });
	});

	it("overwrites an existing file", () => {
		const p = join(tmp, "out.json");
		writeFileSync(p, "old content");
		writeAtomic(p, { fresh: true });
		expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ fresh: true });
	});

	// test-contract: bug — review 2026-08-30: the old helper DELETED the
	// destination before renaming, leaving a crash window with no file at
	// all. Replacement now goes through rename alone; rmSync must never fire.
	it("replaces via rename alone — the destination is never unlinked first", () => {
		const p = join(tmp, "swallow.json");
		writeFileSync(p, "old content");
		rmSyncMock.mockClear();
		writeAtomic(p, { landed: true });
		expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ landed: true });
		expect(rmSyncMock).not.toHaveBeenCalled();
	});

	// test-contract: invariant — the destination's file mode survives the
	// replacement (snapshots/restores depend on it).
	it("preserves the destination's file mode across the replacement", () => {
		const p = join(tmp, "mode.json");
		writeFileSync(p, "old content");
		chmodSync(p, 0o600);
		writeAtomic(p, { landed: true });
		// SAFETY: statSync mode includes type bits; mask to permissions.
		expect(statSync(p).mode & 0o777).toBe(0o600);
	});

	// test-contract: invariant — mode preservation is best-effort. If chmodSync
	// were NOT swallowed, the throw would propagate out of writeAtomic before
	// renameSync ever runs, leaving the destination's OLD content in place (or,
	// as here, invalid JSON) — so a successful, up-to-date read is proof the
	// catch actually fired, not merely that nothing else went wrong.
	it("swallows a chmodSync failure during mode preservation and still lands the write", () => {
		const p = join(tmp, "chmod-fail.json");
		writeFileSync(p, "old content");
		chmodSyncMock.mockImplementationOnce(() => {
			throw new Error("EPERM: chmod not permitted");
		});
		writeAtomic(p, { landed: true });
		expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ landed: true });
	});
});

// -----------------------------------------------------------------------------
// writeTextAtomic — plain-text sibling of writeAtomic
// -----------------------------------------------------------------------------

describe("writeTextAtomic", () => {
	// test-contract: invariant — same fail-open contract as writeAtomic's mode
	// preservation. A rethrow would abort before renameSync, leaving the OLD
	// text on disk — so the destination reading back the NEW content is proof
	// the catch fired rather than merely that nothing else failed.
	it("swallows a chmodSync failure during mode preservation and still lands the text write", () => {
		const p = join(tmp, "chmod-fail.txt");
		writeFileSync(p, "old content");
		chmodSyncMock.mockImplementationOnce(() => {
			throw new Error("EPERM: chmod not permitted");
		});
		writeTextAtomic(p, "new content");
		expect(readFileSync(p, "utf-8")).toBe("new content");
	});
});

// -----------------------------------------------------------------------------
// snapshotTextFile / restoreTextFile
// -----------------------------------------------------------------------------

describe("snapshotTextFile", () => {
	// test-contract: invariant — a stat failure AFTER existsSync already
	// passed (the classic TOCTOU race) must degrade to null, not throw or
	// report a fabricated snapshot a caller would trust for rollback.
	it("returns null when statSync fails after the file was confirmed to exist", () => {
		const p = join(tmp, "race.txt");
		writeFileSync(p, "will vanish from stat's perspective");
		statSyncMock.mockImplementationOnce(() => {
			throw new Error("EACCES: permission denied, stat");
		});
		expect(snapshotTextFile(p)).toBeNull();
	});
});

describe("restoreTextFile", () => {
	// test-contract: invariant — a snapshot of `existed: false` means the
	// artifact was CREATED by the failed install, so restoring means deleting
	// it, not writing empty text. If the leftover file is still present after
	// restoreTextFile returns, the delete branch never ran.
	it("deletes a file the snapshot says did not exist beforehand", () => {
		const p = join(tmp, "created-by-failed-install.json");
		writeFileSync(p, "leftover from a partially-applied install");
		restoreTextFile(p, { existed: false });
		expect(existsSync(p)).toBe(false);
	});
});

describe("removeJsonPath — prototype-chain hardening (review 2026-08-30)", () => {
	// test-contract: security — the reviewer's repro: a manifest path of
	// `__proto__.toString` reached INHERITED properties. Forbidden segments
	// refuse outright and inherited members are never traversed.
	it("refuses __proto__/prototype/constructor segments", () => {
		const target = { hooks: { PreToolUse: [{ command: "x" }] } };
		expect(removeJsonPath(target, "__proto__.toString")).toBe(false);
		expect(removeJsonPath(target, "hooks.__proto__")).toBe(false);
		expect(removeJsonPath(target, "constructor.prototype")).toBe(false);
		expect(target.hooks.PreToolUse).toHaveLength(1);
		// SAFETY: probing that the prototype survived — toString must remain.
		expect(typeof ({} as Record<string, unknown>).toString).toBe("function");
	});

	// test-contract: security — inherited keys are not own data: stepping to
	// them returns false rather than mutating shared prototypes.
	it("never removes through an inherited (non-own) property", () => {
		const target = { a: {} };
		expect(removeJsonPath(target, "a.toString")).toBe(false);
	});
});

describe("ensureDir", () => {
	it("creates a missing directory", () => {
		const dirPath = join(tmp, "new-dir");
		ensureDir(dirPath);
		expect(() => readFileSync(join(dirPath, "does-not-exist"))).toThrow();
	});

	it("is a no-op when the directory already exists", () => {
		const dirPath = join(tmp, "existing-dir");
		mkdirSync(dirPath);
		writeFileSync(join(dirPath, "marker.txt"), "keep");
		ensureDir(dirPath);
		expect(readFileSync(join(dirPath, "marker.txt"), "utf-8")).toBe("keep");
	});
});
