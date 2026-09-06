import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSourceFiles } from "./discovered-primitives-fs.js";

// Companion for discovered-primitives-fs.ts. The mutation-kill test file
// (discovered-primitives-fs.mutation-kill-w44.test.ts) covers the bulk of
// this module's behavior; this file targets the one remaining shallow gap
// (a stat failure mid-scan) using the same tmp-dir fixture convention.

let tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dpfs-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of tmpDirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch (err) {
			console.warn(`cleanup failed for ${d}:`, err);
		}
	}
	tmpDirs = [];
});

describe("listSourceFiles — stat failure mid-scan", () => {
	it("skips an entry whose stat throws (dangling symlink) and keeps scanning later entries", () => {
		const root = makeTmpDir();
		writeFileSync(join(root, "a.ts"), "export {}");
		// statSync follows symlinks, so a link to a missing target throws ENOENT
		// inside the per-entry try/catch — this is the branch under test.
		symlinkSync(join(root, "does-not-exist.ts"), join(root, "broken.ts"));
		writeFileSync(join(root, "z.ts"), "export {}");

		const result = listSourceFiles(root);

		// If the catch body did anything other than `continue` (rethrow, or
		// `break` out of the for-loop), "z.ts" would be missing from the
		// result or the call would throw — either way this exact array fails.
		expect(result).toEqual([join(root, "a.ts"), join(root, "z.ts")]);
	});
});
