import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findManifestFiles } from "./manifest-file-walk.js";

let dirs: string[] = [];

function makeTmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "manifest-walk-w54-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of dirs) {
		rmSync(d, { recursive: true, force: true });
	}
	dirs = [];
});

describe("findManifestFiles — sort ordering (kills sort-comparator mutants)", () => {
	// test-contract: public-api — findManifestFiles's doc comment promises a
	// stable, deterministic ordering; the .sort() call is the only source of it.
	it("P1: returns matched files in ascending name order regardless of creation order", () => {
		const root = makeTmpDir();
		// Create files in a deliberately unsorted order so a missing/broken
		// comparator produces a different array than the correct ascending sort.
		writeFileSync(join(root, "delta.csproj"), "");
		writeFileSync(join(root, "alpha.csproj"), "");
		writeFileSync(join(root, "charlie.csproj"), "");
		writeFileSync(join(root, "bravo.csproj"), "");
		writeFileSync(join(root, "echo.csproj"), "");

		const result = findManifestFiles(root, (name) => name.endsWith(".csproj"));

		expect(result).toEqual(["alpha.csproj", "bravo.csproj", "charlie.csproj", "delta.csproj", "echo.csproj"]);
	});

	// test-contract: invariant — directory entries are sorted before recursion,
	// so DFS visits subdirectories in name order too, not just files.
	it("P2: sorts directory traversal order too, so nested files come back name-ordered", () => {
		const root = makeTmpDir();
		mkdirSync(join(root, "zeta"));
		mkdirSync(join(root, "alpha"));
		writeFileSync(join(root, "zeta", "z.csproj"), "");
		writeFileSync(join(root, "alpha", "a.csproj"), "");

		const result = findManifestFiles(root, (name) => name.endsWith(".csproj"));

		// alpha/ must be visited (and its file emitted) before zeta/ because the
		// directory listing itself is sorted before recursion.
		expect(result).toEqual(["alpha/a.csproj", "zeta/z.csproj"]);
	});
});

describe("findManifestFiles — depth cap (kills depth>=MAX_WALK_DEPTH and depth+1 mutants)", () => {
	// test-contract: boundary — MAX_WALK_DEPTH=8 is a deliberate recursion
	// bound (see module comment on ruinous node_modules-style descents).
	it("P3: finds a matching file at the depth boundary but not one nested one level deeper", () => {
		const root = makeTmpDir();
		// Build 9 nested directories: d1/d2/.../d9. The walk starts at depth 0
		// for root; each directory descent increments depth by one. A file
		// placed directly inside d8 sits at the last depth still scanned; a
		// file placed inside d9 requires descending past the cap and must be
		// excluded.
		let cur = root;
		let rel = "";
		for (let i = 1; i <= 9; i++) {
			cur = join(cur, `d${i}`);
			rel = rel ? `${rel}/d${i}` : `d${i}`;
			mkdirSync(cur);
			if (i === 8) {
				writeFileSync(join(cur, "shallow.manifest"), "");
			}
			if (i === 9) {
				writeFileSync(join(cur, "deep.manifest"), "");
			}
		}

		const result = findManifestFiles(root, (name) => name.endsWith(".manifest"));

		expect(result).toContain("d1/d2/d3/d4/d5/d6/d7/d8/shallow.manifest");
		expect(result).not.toContain("d1/d2/d3/d4/d5/d6/d7/d8/d9/deep.manifest");
	});
});

describe("findManifestFiles — isFile && match (kills LogicalOperator mutant)", () => {
	// test-contract: public-api — the `match` predicate parameter is the
	// caller's filename filter; a real file that fails it must be excluded.
	it("P4: excludes a file whose name does not match, even though it is a real file", () => {
		const root = makeTmpDir();
		writeFileSync(join(root, "app.csproj"), "");
		writeFileSync(join(root, "readme.txt"), "");

		const result = findManifestFiles(root, (name) => name.endsWith(".csproj"));

		expect(result).toEqual(["app.csproj"]);
		expect(result).not.toContain("readme.txt");
	});
});

describe("findManifestFiles — WALK_IGNORE_DIRS string literals (kills StringLiteral mutants)", () => {
	// test-contract: invariant — WALK_IGNORE_DIRS names (module comment: avoids
	// ruinous node_modules-style descents and build-output duplicates).
	it("P5: never descends into any of the named ignore directories", () => {
		const root = makeTmpDir();
		const ignored = [
			".git",
			".interlinked",
			"dist",
			"build",
			"obj",
			"target",
			"coverage",
			"vendor",
			"venv",
			"out",
			".next",
			".venv",
			"__pycache__",
		];
		for (const name of ignored) {
			const d = join(root, name);
			mkdirSync(d);
			writeFileSync(join(d, "hidden.manifest"), "");
		}
		// Control: a normal, non-ignored directory whose file must still show up.
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "visible.manifest"), "");

		const result = findManifestFiles(root, (name) => name.endsWith(".manifest"));

		expect(result).toEqual(["src/visible.manifest"]);
		for (const name of ignored) {
			expect(result).not.toContain(`${name}/hidden.manifest`);
		}
	});

	// test-contract: boundary — WALK_IGNORE_DIRS is a Set of exact literal
	// names; a StringLiteral mutant turning "dist" into "" must not make
	// unrelated names like "distfiles" match instead.
	it("N1: a directory whose name merely contains an ignore-list substring is still walked", () => {
		const root = makeTmpDir();
		// "distfiles" is not the literal "dist", so it must not be filtered
		// even though "dist" is one of the ignored names.
		mkdirSync(join(root, "distfiles"));
		writeFileSync(join(root, "distfiles", "kept.manifest"), "");

		const result = findManifestFiles(root, (name) => name.endsWith(".manifest"));

		expect(result).toEqual(["distfiles/kept.manifest"]);
	});
});
