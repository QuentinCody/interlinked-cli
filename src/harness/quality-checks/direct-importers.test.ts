// Real (not mocked) temporary directories, matching the convention already
// established in src/harness/project-graph.test.ts: findDirectImporters
// resolves import specifiers via real `readdirSync`/`statSync`/`readFileSync`
// calls (through parseImports/resolveImportPath), so a filesystem mock would
// need to reproduce that resolution logic faithfully — real disk avoids
// that risk entirely.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDirectImporters } from "./direct-importers.js";

let root: string;

function write(rel: string, content: string): string {
	const full = path.join(root, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content, "utf-8");
	return full;
}

/** Thin wrapper around the options-object call so every test case below
 *  reads as `find(target)` against the current fixture root. */
function find(absPath: string, projectRoot: string = root): string[] {
	return findDirectImporters({ absPath, projectRoot });
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "direct-importers-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("findDirectImporters — positive (must fire)", () => {
	it("P1: finds a same-directory relative importer (./modes)", () => {
		const target = write("src/modes.ts", "export const ALL_PRESETS = [];\n");
		const importer = write(
			"src/install-hooks.ts",
			"import { ALL_PRESETS } from './modes.js';\nexport function f() { return ALL_PRESETS; }\n",
		);
		const found = find(target);
		expect(found).toEqual([importer]);
	});

	it("P2: finds a parent-relative importer (../modes)", () => {
		const target = write("src/harness/modes.ts", "export const ALL_PRESETS = [];\n");
		const importer = write(
			"src/commands/install-hooks.ts",
			"import { ALL_PRESETS } from '../harness/modes.js';\n",
		);
		const found = find(target);
		expect(found).toEqual([importer]);
	});

	it("P3: finds an importer using the extensionless specifier form", () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		const importer = write("src/user.ts", "import { X } from './modes';\n");
		const found = find(target);
		expect(found).toEqual([importer]);
	});

	it("P4: finds a require()-style importer", () => {
		const target = write("src/modes.js", "module.exports = { X: 1 };\n");
		const importer = write("src/user.js", "const { X } = require('./modes');\n");
		const found = find(target);
		expect(found).toEqual([importer]);
	});

	it("P5: finds every direct importer among multiple", () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		const a = write("src/a.ts", "import { X } from './modes.js';\n");
		const b = write("src/b.ts", "import { X } from './modes.js';\n");
		const found = find(target).sort();
		expect(found).toEqual([a, b].sort());
	});
});

describe("findDirectImporters — negative (must not fire)", () => {
	it("N1: does NOT include a transitive (2-hop) importer", () => {
		// modes.ts <- install-hooks.ts <- uses-install-hooks.ts
		// Editing modes.ts must surface install-hooks.ts (direct) but NOT
		// uses-install-hooks.ts (2 hops away) — that is the exact gap this
		// module exists to close without paying for a transitive graph walk.
		const target = write("src/modes.ts", "export const ALL_PRESETS = [];\n");
		const direct = write(
			"src/install-hooks.ts",
			"import { ALL_PRESETS } from './modes.js';\n",
		);
		write(
			"src/uses-install-hooks.ts",
			"import { install } from './install-hooks.js';\n",
		);
		const found = find(target);
		expect(found).toEqual([direct]);
	});

	it("N2: does NOT match a same-named file living in a different directory", () => {
		// This repo alone has several same-basename files (types.ts, index.ts) —
		// a text-only match would wrongly attribute an unrelated "modes.ts" as
		// an importer of a DIFFERENT "modes.ts" elsewhere in the tree.
		write("src/other/modes.ts", "export const UNRELATED = 1;\n");
		const target = write("src/harness/modes.ts", "export const ALL_PRESETS = [];\n");
		write(
			"src/other/user-of-other-modes.ts",
			"import { UNRELATED } from './modes.js';\n",
		);
		const found = find(target);
		expect(found).toEqual([]);
	});

	it("N3: does NOT match a bare textual mention that isn't an import statement", () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		write(
			"src/docs-like.ts",
			"// See modes.ts for details. const modes = 'not an import';\n",
		);
		const found = find(target);
		expect(found).toEqual([]);
	});

	it("N4: skips SKIP_DIRS directories (node_modules)", () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		write(
			"node_modules/pkg/user.ts",
			"import { X } from '../../src/modes.js';\n",
		);
		const found = find(target);
		expect(found).toEqual([]);
	});

	it("N5: skips SKIP_DIRS directories (.stryker-tmp sandbox mirror)", () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		write(
			".stryker-tmp/sandbox-abc/src/user.ts",
			"import { X } from '../../../src/modes.js';\n",
		);
		const found = find(target);
		expect(found).toEqual([]);
	});

	it("N6: returns [] when the file has no importers at all", () => {
		const target = write("src/lonely.ts", "export const X = 1;\n");
		const found = find(target);
		expect(found).toEqual([]);
	});

	it("N7: returns [] (fails safe) when projectRoot does not exist on disk", () => {
		const missingRoot = path.join(root, "does-not-exist");
		const target = path.join(missingRoot, "src/modes.ts");
		const found = find(target, missingRoot);
		expect(found).toEqual([]);
	});

	it("N8: never reports the target file as its own importer", () => {
		const target = write(
			"src/self.ts",
			"import { self as _self } from './self.js';\nexport const self = 1;\n",
		);
		const found = find(target);
		expect(found).toEqual([]);
	});

	// test-contract: boundary — a real (measured) repo hazard: a syntactically
	// valid importer living OUTSIDE src/ (this repo's own scratch/ held 17,160
	// TS/JS files of mutation-campaign debris — see resolveWalkRoot's doc
	// comment) must never be walked, regardless of what it imports.
	it("N9: a project with a src/ dir never walks a sibling directory, even a real importer", () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		write("scratch/rogue-importer.ts", "import { X } from '../src/modes.js';\n");
		const found = find(target);
		expect(found).toEqual([]);
	});

	it("N10: skips a dangling symlink (statSync race) and still finds the real importer", () => {
		// visitEntry's statSync(full) follows the symlink and throws ENOENT
		// when the link target is gone — the catch must skip only this one
		// entry, not abort the whole walk. Without that catch, the ENOENT
		// would propagate out of findDirectImporters entirely.
		const target = write("src/modes.ts", "export const X = 1;\n");
		const importer = write("src/user.ts", "import { X } from './modes.js';\n");
		symlinkSync(path.join(root, "src", "gone.ts"), path.join(root, "src", "dangling.ts"));
		const found = find(target);
		expect(found).toEqual([importer]);
	});

	it("N11: skips an unreadable candidate file (readFileSync race) and still finds the real importer", () => {
		// confirmCandidate's readFileSync(candidate, "utf-8") throws EACCES for
		// a file with no read permission — the catch must skip only this
		// candidate, not abort the walk. "locked.ts" textually imports the
		// target, so if the catch were missing, findDirectImporters would
		// throw instead of returning importer alone.
		const target = write("src/modes.ts", "export const X = 1;\n");
		const importer = write("src/user.ts", "import { X } from './modes.js';\n");
		const locked = write("src/locked.ts", "import { X } from './modes.js';\n");
		chmodSync(locked, 0o000);
		const found = find(target);
		expect(found).toEqual([importer]);
	});
});

describe("findDirectImporters — flat (non-src/-rooted) layout", () => {
	it("still finds a direct importer when the project root has no src/ subdirectory", () => {
		const target = write("modes.ts", "export const X = 1;\n");
		const importer = write("user.ts", "import { X } from './modes.js';\n");
		const found = find(target);
		expect(found).toEqual([importer]);
	});
});
