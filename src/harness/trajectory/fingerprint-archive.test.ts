import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FINGERPRINT_TTL_MS, fingerprintBlock } from "./block-fingerprint.js";
import {
	clearArchive,
	loadArmedFingerprints,
	persistArmedFingerprints,
} from "./fingerprint-archive.js";

const T0 = 5_000_000;
let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "fp-archive-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("fingerprint-archive round-trip", () => {
	it("persists and rehydrates a fingerprint (shingles Set survives JSON)", () => {
		const fp = fingerprintBlock({
			ruleId: "empty_catch",
			content: "try { risky() } catch (e) {}",
			target: "src/a.ts",
			atMs: T0,
		});
		persistArmedFingerprints(cwd, "sess-1", [fp], [{ detector: "d1", ruleId: "empty_catch" }]);

		const loaded = loadArmedFingerprints(cwd, "sess-1", T0 + 1000);
		expect(loaded).not.toBeNull();
		expect(loaded?.fingerprints).toHaveLength(1);
		expect(loaded?.fingerprints[0]?.ruleId).toBe("empty_catch");
		expect(loaded?.fingerprints[0]?.target).toBe("src/a.ts");
		expect(loaded?.fingerprints[0]?.shingles).toBeInstanceOf(Set);
		expect(loaded?.fingerprints[0]?.shingles.size).toBeGreaterThan(0);
		expect(loaded?.signals).toEqual([{ detector: "d1", ruleId: "empty_catch" }]);
	});

	it("prunes expired fingerprints on load (TTL enforced across restart)", () => {
		const fp = fingerprintBlock({ ruleId: "old", content: "aaa bbb ccc ddd", atMs: T0 });
		persistArmedFingerprints(cwd, "sess-2", [fp], []);

		const loaded = loadArmedFingerprints(cwd, "sess-2", T0 + DEFAULT_FINGERPRINT_TTL_MS + 1);
		expect(loaded?.fingerprints).toHaveLength(0);
	});

	it("sanitizes the session id into a safe basename (no path escape)", () => {
		const fp = fingerprintBlock({ ruleId: "r", content: "x y z", atMs: T0 });
		// A session id with slashes/dots must not write outside the archive dir.
		persistArmedFingerprints(cwd, "../../etc/passwd", [fp], []);
		const loaded = loadArmedFingerprints(cwd, "../../etc/passwd", T0 + 1);
		expect(loaded?.fingerprints).toHaveLength(1);
	});
});

describe("fingerprint-archive fail-open", () => {
	it("returns null when no archive exists", () => {
		expect(loadArmedFingerprints(cwd, "never-written", T0)).toBeNull();
	});

	it("returns null (not throw) on a corrupt archive", () => {
		const dir = join(cwd, ".interlinked", "trajectory-armed");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "corrupt.json"), "{ this is not json ");
		expect(loadArmedFingerprints(cwd, "corrupt", T0)).toBeNull();
	});

	it("clearArchive removes a session's file and is a no-op when absent", () => {
		const fp = fingerprintBlock({ ruleId: "r", content: "x y z", atMs: T0 });
		persistArmedFingerprints(cwd, "sess-clear", [fp], []);
		expect(loadArmedFingerprints(cwd, "sess-clear", T0 + 1)?.fingerprints).toHaveLength(1);
		clearArchive(cwd, "sess-clear");
		expect(loadArmedFingerprints(cwd, "sess-clear", T0 + 1)).toBeNull();
		expect(() => clearArchive(cwd, "never")).not.toThrow(); // idempotent
	});

	it("clearArchive swallows a non-ENOENT rmSync failure instead of throwing", () => {
		// force:true suppresses ENOENT, but rmSync (no `recursive`) still throws
		// EISDIR when the archive path is occupied by a directory instead of a
		// file — the case the catch block at fingerprint-archive.ts:166 exists
		// for. If that catch were removed the EISDIR would propagate and this
		// call would throw; instead it must return normally and leave the
		// directory in place (rmSync never removed it).
		const dir = join(cwd, ".interlinked", "trajectory-armed");
		mkdirSync(dir, { recursive: true });
		const collidingPath = join(dir, "dir-sess.json");
		mkdirSync(collidingPath);
		expect(() => clearArchive(cwd, "dir-sess")).not.toThrow();
		expect(existsSync(collidingPath)).toBe(true);
	});
});

// =============================================================================
// parseArchiveShape (internal, exercised through loadArmedFingerprints) —
// the well-formed-JSON-but-wrong-shape boundary the JSON.parse-throw tests
// above don't reach.
// =============================================================================

function writeRawArchive(dir: string, sessionId: string, body: unknown): void {
	const armedDir = join(dir, ".interlinked", "trajectory-armed");
	mkdirSync(armedDir, { recursive: true });
	writeFileSync(join(armedDir, `${sessionId}.json`), JSON.stringify(body));
}

describe("parseArchiveShape — positive (must load)", () => {
	it("P1: loads a well-formed archive with fingerprints and signals", () => {
		writeRawArchive(cwd, "shape-p1", {
			fingerprints: [{ ruleId: "r1", shingles: ["a", "b"], target: "src/a.ts", atMs: T0 }],
			signals: [{ detector: "d1", ruleId: "r1" }],
		});
		const loaded = loadArmedFingerprints(cwd, "shape-p1", T0 + 1);
		expect(loaded?.fingerprints).toHaveLength(1);
		expect(loaded?.signals).toEqual([{ detector: "d1", ruleId: "r1" }]);
	});

	it("P2: accepts a null target on a fingerprint", () => {
		writeRawArchive(cwd, "shape-p2", {
			fingerprints: [{ ruleId: "r1", shingles: ["a"], target: null, atMs: T0 }],
			signals: [],
		});
		const loaded = loadArmedFingerprints(cwd, "shape-p2", T0 + 1);
		expect(loaded?.fingerprints[0]?.target).toBeNull();
	});

	it("P3: defaults missing fingerprints/signals keys to empty arrays (older-writer compatibility)", () => {
		writeRawArchive(cwd, "shape-p3", {});
		const loaded = loadArmedFingerprints(cwd, "shape-p3", T0 + 1);
		expect(loaded).toEqual({ fingerprints: [], signals: [] });
	});
});

describe("parseArchiveShape — negative (must degrade gracefully, never throw)", () => {
	it("N1: a top-level bare array (not an object) is rejected — same as no archive", () => {
		writeRawArchive(cwd, "shape-n1", ["not", "an", "object"]);
		expect(loadArmedFingerprints(cwd, "shape-n1", T0 + 1)).toBeNull();
	});

	it("N2: a malformed fingerprint entry is filtered out, valid siblings survive", () => {
		writeRawArchive(cwd, "shape-n2", {
			fingerprints: [
				{ ruleId: "good", shingles: ["a"], target: null, atMs: T0 },
				{ ruleId: "bad-shingles-not-array", shingles: "oops", target: null, atMs: T0 },
				{ ruleId: 42, shingles: ["a"], target: null, atMs: T0 }, // ruleId wrong type
			],
			signals: [],
		});
		const loaded = loadArmedFingerprints(cwd, "shape-n2", T0 + 1);
		expect(loaded?.fingerprints).toHaveLength(1);
		expect(loaded?.fingerprints[0]?.ruleId).toBe("good");
	});

	it("N3: fingerprints as a non-array value degrades to empty, signals still load", () => {
		writeRawArchive(cwd, "shape-n3", {
			fingerprints: "not-an-array",
			signals: [{ detector: "d", ruleId: "r" }],
		});
		const loaded = loadArmedFingerprints(cwd, "shape-n3", T0 + 1);
		expect(loaded?.fingerprints).toEqual([]);
		expect(loaded?.signals).toEqual([{ detector: "d", ruleId: "r" }]);
	});

	it("N4: a malformed signal entry (missing ruleId) is filtered out", () => {
		writeRawArchive(cwd, "shape-n4", {
			fingerprints: [],
			signals: [{ detector: "d1", ruleId: "r1" }, { detector: "d2" }],
		});
		const loaded = loadArmedFingerprints(cwd, "shape-n4", T0 + 1);
		expect(loaded?.signals).toEqual([{ detector: "d1", ruleId: "r1" }]);
	});
});
