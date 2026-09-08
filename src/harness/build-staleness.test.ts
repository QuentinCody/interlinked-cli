// ===========================================
// Build staleness guard — unit tests
// ===========================================
// Covers `distStaleness`'s public per-file walk against a real temp
// repo tree (dist/index.js + src/*), including the per-file
// `statSync` failure path inside `foldOneEntry`: a file that `readdirSync`
// lists but whose own `statSync` throws mid-walk (e.g. an unlinked-between-
// list-and-stat file) must not abort the whole scan — it is skipped and the
// walk's running max mtime survives.
//
// `statSync` is wrapped as a call-through spy (not a plain `vi.spyOn(fs, ...)`,
// which throws "Module namespace is not configurable in ESM" for node:fs
// under this vitest version) so exactly one path can be made to throw while
// every other fs call — including this file's own fixture setup — hits the
// real filesystem.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { statSyncControl } = vi.hoisted(() => {
	const statSyncControl: { poisonPath: string | null } = { poisonPath: null };
	return { statSyncControl };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		statSync: (...args: Parameters<typeof actual.statSync>) => {
			const [path] = args;
			if (statSyncControl.poisonPath !== null && String(path) === statSyncControl.poisonPath) {
				throw new Error(`ENOENT: no such file or directory, stat '${String(path)}'`);
			}
			return actual.statSync(...args);
		},
	};
});

import { distStaleness } from "./build-staleness.js";

// Each test owns exactly one temp repo root; cleaned up unconditionally so a
// failed assertion never leaks a fixture dir into the working tree.
let root: string | null = null;

afterEach(() => {
	statSyncControl.poisonPath = null;
	if (root !== null) {
		rmSync(root, { recursive: true, force: true });
		root = null;
	}
});

describe("distStaleness — per-file statSync failure inside the src/ walk", () => {
	it("skips the poisoned file and still reports staleness from the other file's mtime", () => {
		root = mkdtempSync(join(tmpdir(), "build-staleness-"));
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "dist", "index.js"), "// built");
		// Anchor the build artifact far in the past so any real src mtime
		// (set at test time) reads as newer -> stale: true.
		utimesSync(join(root, "dist", "index.js"), new Date(1000), new Date(1000));

		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "good.ts"), "// normal file");
		const poisonPath = join(root, "src", "poison.ts");
		writeFileSync(poisonPath, "// stat() on this one throws");
		statSyncControl.poisonPath = poisonPath;

		const result = distStaleness(root);
		// If the catch in foldOneEntry were removed, statSync's throw for
		// poison.ts would propagate out of distStaleness uncaught and this
		// call would throw instead of returning — failing this test.
		expect(result).not.toBeNull();
		expect(result?.stale).toBe(true);
		expect(result?.newestSrcMs).toBeGreaterThan(0);
	});
});
