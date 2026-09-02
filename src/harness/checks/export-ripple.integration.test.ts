// Behavioral tests for export-ripple.ts.
//
// Two surfaces under test:
//   - getGitSourceFiles  — 30s-cached `git ls-files` wrapper.
//   - checkExportRipple  — flags importers that name an export which no
//     longer exists in the target module's current content.
//
// IMPORTANT contract discovered from the source (and pinned by these tests):
// checkExportRipple uses a COARSE substring pre-filter to decide which files
// are "candidate importers". That filter looks for the target's basename
// wrapped in quotes with NO leading separator — `"target"`, `"target.js"`,
// `'target.ts'`, etc. A normal relative import (`from "./target.js"`) does
// NOT satisfy it, because the char before the basename is `/`, not a quote.
// So for the deep matching logic to run, a candidate file must ALSO contain a
// bare-quoted mention of the basename (a string literal or comment token).
// Real importers hit this via re-export barrels / doc comments / path
// constants; the `bareRef()` helper reproduces it deterministically. The
// relative-only import gate (`specifier.startsWith(".") || "@/"`) is then what
// the actual `from "./target..."` line passes.
//
// Strategy:
//   - Happy paths + the bulk of branches run against REAL tmp git repos
//     (mkdtempSync + writeFileSync + `git add`), the same idiom as
//     cross-file.test.ts — exercising the real execFileSync/readFileSync/path
//     resolution end to end, deterministically (we own every file).
//   - The fs/git error arms (git throwing, readFileSync throwing) get a
//     dedicated describe block that vi.mock node:child_process / node:fs.

import { execFileSync as realExecFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkExportRipple, getGitSourceFiles } from "./export-ripple.js";

// --- tmp git-repo fixture helpers -------------------------------------------

/** Create an isolated tmp dir that is a real git repo, return its absolute path. */
function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "export-ripple-"));
	realExecFileSync("git", ["init", "-q"], { cwd: dir });
	realExecFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
	realExecFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	return dir;
}

/** Write a file (creating parent dirs) relative to repo root. */
function write(repo: string, rel: string, body: string): void {
	const abs = join(repo, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body);
}

/** Stage everything so `git ls-files --cached` sees the tree. */
function add(repo: string): void {
	realExecFileSync("git", ["add", "-A"], { cwd: repo });
}

/**
 * A bare-quoted basename token that satisfies checkExportRipple's coarse
 * pre-filter (quote directly adjacent to the basename). Appended to importer
 * fixtures so the deep matching logic actually runs on the real `from "./..."`
 * import line. `base` is the module basename WITHOUT extension.
 */
function bareRef(base: string): string {
	return `\nconst __ref = "${base}";\nvoid __ref;\n`;
}

// =============================================================================
// getGitSourceFiles
// =============================================================================

describe("getGitSourceFiles", () => {
	it("lists staged JS/TS source files and filters out non-source", () => {
		const repo = makeRepo();
		write(repo, "src/a.ts", "export const a = 1;\n");
		write(repo, "src/b.tsx", "export const b = 1;\n");
		write(repo, "src/c.js", "export const c = 1;\n");
		write(repo, "src/d.jsx", "export const d = 1;\n");
		write(repo, "src/e.mjs", "export const e = 1;\n");
		write(repo, "src/f.cjs", "export const f = 1;\n");
		write(repo, "README.md", "# not source\n");
		write(repo, "data.json", "{}\n");
		add(repo);

		const files = getGitSourceFiles(repo);
		expect(files).toContain("src/a.ts");
		expect(files).toContain("src/b.tsx");
		expect(files).toContain("src/c.js");
		expect(files).toContain("src/d.jsx");
		expect(files).toContain("src/e.mjs");
		expect(files).toContain("src/f.cjs");
		// Extension filter drops non-JS/TS.
		expect(files).not.toContain("README.md");
		expect(files).not.toContain("data.json");
	});

	it("P1: lists .mts/.cts files — the same JS/TS set the per-function gates put into ledger mode", () => {
		// A ledger scan (function-complexity-baseline.ts::computeOverCap) walks this
		// list; a .mts the gates treat as ledgerable but the scan never saw could
		// never be listed, so every edit to it false-blocked once a ledger existed.
		const repo = makeRepo();
		write(repo, "src/esm.mts", "export const m = 1;\n");
		write(repo, "src/cjs.cts", "export const c = 1;\n");
		write(repo, "src/notes.mdts", "not source\n");
		add(repo);
		const files = getGitSourceFiles(repo);
		expect(files).toContain("src/esm.mts");
		expect(files).toContain("src/cjs.cts");
		expect(files).not.toContain("src/notes.mdts");
	});

	it("includes untracked-but-not-ignored files (--others --exclude-standard)", () => {
		const repo = makeRepo();
		// Never `git add`-ed, but not ignored => should still appear.
		write(repo, "src/untracked.ts", "export const u = 1;\n");
		const files = getGitSourceFiles(repo);
		expect(files).toContain("src/untracked.ts");
	});

	it("respects .gitignore (excludes ignored files)", () => {
		const repo = makeRepo();
		write(repo, ".gitignore", "ignored.ts\n");
		write(repo, "ignored.ts", "export const x = 1;\n");
		write(repo, "kept.ts", "export const y = 1;\n");
		add(repo);
		const files = getGitSourceFiles(repo);
		expect(files).toContain("kept.ts");
		expect(files).not.toContain("ignored.ts");
	});

	it("returns a cached result within the TTL (cache-hit branch)", () => {
		const repo = makeRepo();
		write(repo, "src/one.ts", "export const a = 1;\n");
		add(repo);

		const first = getGitSourceFiles(repo);
		expect(first).toContain("src/one.ts");

		// Add a new file WITHOUT clearing the cache; within the 30s TTL the
		// cached array (no new file) must be returned — proving the cache-hit
		// short-circuit fires before git runs again.
		write(repo, "src/two.ts", "export const b = 1;\n");
		add(repo);
		const second = getGitSourceFiles(repo);
		expect(second).toBe(first); // same array reference => served from cache
		expect(second).not.toContain("src/two.ts");
	});

	it("returns [] when git fails (non-repo directory => catch branch)", () => {
		// A fresh tmp dir that is NOT a git repo: `git ls-files` exits non-zero,
		// execFileSync throws, the catch returns [].
		const notARepo = mkdtempSync(join(tmpdir(), "export-ripple-nogit-"));
		expect(getGitSourceFiles(notARepo)).toEqual([]);
	});
});

// =============================================================================
// checkExportRipple — early returns / guards
// =============================================================================

describe("checkExportRipple — early returns", () => {
	it("returns [] for a non-JS/TS extension", () => {
		expect(checkExportRipple("export const a = 1;", "foo.py", "/tmp")).toEqual([]);
		expect(checkExportRipple("export const a = 1;", "foo.go", "/tmp")).toEqual([]);
		// No extension at all.
		expect(checkExportRipple("export const a = 1;", "Makefile", "/tmp")).toEqual([]);
	});

	it("returns [] for a .d.ts declaration file even though the ext gate passes", () => {
		// .d.ts ends in `.ts` so the ext gate passes; the explicit .d.ts guard
		// is what returns [].
		expect(checkExportRipple("export const a: number;", "types.d.ts", "/tmp")).toEqual([]);
	});

	it("returns [] when the file declares no exports", () => {
		const repo = makeRepo();
		expect(
			checkExportRipple("const a = 1;\nfunction f() {}\n", join(repo, "src/x.ts"), repo),
		).toEqual([]);
	});

	it("returns [] when the basename is empty", () => {
		// A path whose filename (minus a stripped extension) is empty: ".ts"
		// => noExt "" => baseName "" => the `if (!baseName) return []` guard.
		const repo = makeRepo();
		expect(checkExportRipple("export const a = 1;\n", join(repo, ".ts"), repo)).toEqual([]);
	});

	it("returns [] when no importer references the basename (fast-filter rejects all)", () => {
		const repo = makeRepo();
		write(repo, "src/target.ts", "export const used = 1;\n");
		// An unrelated file that never mentions 'target'.
		write(repo, "src/other.ts", "export const z = 2;\nconsole.log('hi');\n");
		add(repo);
		expect(
			checkExportRipple("export const used = 1;\n", join(repo, "src/target.ts"), repo),
		).toEqual([]);
	});

	it("returns [] when a relative import alone (no bare-quoted token) fails the fast-filter", () => {
		// Pins the documented quirk: `from "./target.js"` as the ONLY mention
		// does NOT pass the coarse pre-filter, so even a genuinely-broken import
		// is not detected without a separate bare-quoted basename token.
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(repo, "src/importer.ts", `import { present, gone } from "./target.js";\n`);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});
});

// =============================================================================
// checkExportRipple — core ripple detection (real repos)
// =============================================================================

describe("checkExportRipple — ripple detection", () => {
	it("flags an importer that names an export which no longer exists", () => {
		const repo = makeRepo();
		const targetSrc = "export const stillHere = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		// Real relative import of a removed name `gone`, plus a bare-quoted
		// basename token so the candidate passes the fast-filter.
		write(
			repo,
			"src/importer.ts",
			`import { stillHere, gone } from "./target.js";${bareRef("target")}`,
		);
		add(repo);

		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(0);
		expect(nonNull(matches[0]).text).toContain("src/importer.ts:1");
		expect(nonNull(matches[0]).text).toContain('imports "gone"');
		expect(nonNull(matches[0]).text).toContain("no longer exists");
		// The present name must NOT be reported.
		expect(nonNull(matches[0]).text).not.toContain('"stillHere"');
	});

	it("does not flag when every imported name still exists", () => {
		const repo = makeRepo();
		const targetSrc = "export const a = 1;\nexport function b() {}\n";
		write(repo, "src/target.ts", targetSrc);
		write(repo, "src/importer.ts", `import { a, b } from "./target.js";${bareRef("target")}`);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});

	it("strips `as` aliases — checks the source name, not the local alias", () => {
		const repo = makeRepo();
		// Target exports `realName`; importer aliases a MISSING `missingName`.
		const targetSrc = "export const realName = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import { missingName as local } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		// Reported name is the source symbol (`missingName`), not the alias `local`.
		expect(nonNull(matches[0]).text).toContain('imports "missingName"');
		expect(nonNull(matches[0]).text).not.toContain("local");
	});

	it("does not flag an aliased import whose source name still exists", () => {
		const repo = makeRepo();
		const targetSrc = "export const realName = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import { realName as local } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});

	it("handles `import type { ... }` and inline `type` specifiers", () => {
		const repo = makeRepo();
		// Target exports type `Kept`; importer references missing type `Gone`.
		const targetSrc = "export type Kept = number;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import type { Kept, Gone } from "./target.js";\nimport { type Kept as K2 } from "./target.js";${bareRef(
				"target",
			)}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		// Only `Gone` is missing; `Kept` (both lines) exists.
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "Gone"');
	});

	it("skips non-relative (bare package) imports even when the fast-filter passes", () => {
		const repo = makeRepo();
		const targetSrc = "export const a = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		// The bare-quoted token passes the fast-filter, but the import specifier
		// is a bare package (`"target"`), not relative => relative-gate skips it.
		write(
			repo,
			"src/importer.ts",
			`import { gone } from "target";${bareRef("target")}`,
		);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});

	it("does not skip @/-prefixed specifiers at the relative-gate (but they don't resolve to us)", () => {
		const repo = makeRepo();
		const targetSrc = "export const a = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		// `@/` passes the relative-or-alias gate; specTail 'target' === basename;
		// but `resolve(importerDir, "@/target")` !== our abs target path, so the
		// resolvedImport-vs-target guard skips it. No throw, no false positive.
		write(
			repo,
			"src/importer.ts",
			`import { gone } from "@/target";${bareRef("target")}`,
		);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});

	it("skips an import whose basename matches but resolves to a DIFFERENT file", () => {
		const repo = makeRepo();
		// Two modules both named 'target.ts' in different dirs.
		const targetSrc = "export const a = 1;\n";
		write(repo, "pkg/target.ts", targetSrc);
		write(repo, "other/target.ts", "export const gone = 9;\n");
		// Importer imports the OTHER target (sibling), naming `gone` which DOES
		// exist there. specTail === 'target' but resolvedImport points at
		// other/target, not pkg/target => skipped (no false positive on pkg).
		write(
			repo,
			"other/importer.ts",
			`import { gone } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "pkg/target.ts"), repo)).toEqual([]);
	});

	it("skips an import line whose specifier basename differs from the target", () => {
		const repo = makeRepo();
		const targetSrc = "export const a = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		// Bare-quoted 'target' passes the fast-filter, but the only import is
		// from './helper' => specTail 'helper' !== 'target' => skipped.
		write(
			repo,
			"src/importer.ts",
			`import { thing } from "./helper.js";${bareRef("target")}`,
		);
		write(repo, "src/helper.ts", "export const thing = 1;\n");
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});

	it("ignores non-import lines and import lines without a named-import group", () => {
		const repo = makeRepo();
		const targetSrc = "export const a = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		// Default + namespace imports (no `{}` group); none match the
		// `import { ... }` regex => importMatch null => continue. Bare token
		// still passes the file-level fast-filter.
		write(
			repo,
			"src/importer.ts",
			`${[
				`import target from "./target.js";`, // default import, no braces
				`import * as T from "./target.js";`, // namespace, no braces
				`console.log(target, T);`,
			].join("\n")}${bareRef("target")}`,
		);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});

	it("accepts a relative import written WITHOUT an extension", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		// `from "./target"` — no suffix; specBase already has no ext to strip.
		write(
			repo,
			"src/importer.ts",
			`import { present, missing } from "./target";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "missing"');
	});

	it("resolves a relative import that points UP a directory (../)", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "lib/target.ts", targetSrc);
		// Importer one level deeper imports `../target`.
		write(
			repo,
			"lib/sub/importer.ts",
			`import { present, vanished } from "../target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "lib/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "vanished"');
		expect(nonNull(matches[0]).text).toContain("lib/sub/importer.ts");
	});

	it("reports across multiple importers and multiple missing names", () => {
		const repo = makeRepo();
		const targetSrc = "export const ok = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/a.ts",
			`import { ok, goneA } from "./target.js";${bareRef("target")}`,
		);
		write(
			repo,
			"src/b.ts",
			`import { goneB1, goneB2 } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		const texts = matches.map((m) => m.text).join("\n");
		expect(texts).toContain('imports "goneA"');
		expect(texts).toContain('imports "goneB1"');
		expect(texts).toContain('imports "goneB2"');
		expect(matches.length).toBe(3);
	});

	it("caps output at 15 matches even when far more imports are broken (inner break)", () => {
		const repo = makeRepo();
		const targetSrc = "export const ok = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		// One importer with 30 missing named imports on 30 lines.
		const lines: string[] = [];
		for (let i = 0; i < 30; i++) lines.push(`import { gone${i} } from "./target.js";`);
		write(repo, "src/importer.ts", `${lines.join("\n")}${bareRef("target")}`);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		// The `matches.length >= 15` break inside the per-line loop bounds it.
		expect(matches.length).toBe(15);
	});

	it("caps at 15 across MANY importer files (outer break path)", () => {
		const repo = makeRepo();
		const targetSrc = "export const ok = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		// 20 importer files, each contributing one broken import. The per-file
		// loop's `matches.length >= 15` break stops enumerating further files.
		for (let i = 0; i < 20; i++) {
			write(
				repo,
				`src/imp${i}.ts`,
				`import { gone${i} } from "./target.js";${bareRef("target")}`,
			);
		}
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches.length).toBe(15);
	});

	it("excludes the target file itself from the importer set", () => {
		const repo = makeRepo();
		// Self-referential bare-quoted mention of its own basename — the
		// `f !== relFromRoot` filter drops the target from allFiles so it is
		// never treated as its own importer.
		const targetSrc = `export const a = 1;\nconst self = "target";\nvoid self;\n`;
		write(repo, "src/target.ts", targetSrc);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});

	it("works when filePath is passed RELATIVE to cwd (isAbsolute false branch)", () => {
		const repo = makeRepo();
		const targetSrc = "export const keep = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import { keep, vanished } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		// Pass the path relative to cwd: exercises the `resolve(cwd, filePath)`
		// arm of the `isAbsolute ? : ` ternary.
		const matches = checkExportRipple(targetSrc, "src/target.ts", repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "vanished"');
	});

	it("strips an inline `type ` prefix together with an alias on a missing name", () => {
		const repo = makeRepo();
		const targetSrc = "export type Keep = string;\n";
		write(repo, "src/target.ts", targetSrc);
		// `type Missing as M` — inline type prefix AND alias on a missing name.
		write(
			repo,
			"src/importer.ts",
			`import { type Missing as M, Keep } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "Missing"');
	});

	it("ignores empty specifier entries from a trailing comma", () => {
		const repo = makeRepo();
		const targetSrc = "export const ok = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		// Trailing comma yields an empty split entry that the `.filter(n => n.length>0)`
		// drops — `ok` exists, so no findings and no crash on the empty name.
		write(
			repo,
			"src/importer.ts",
			`import { ok, } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});
});

// =============================================================================
// checkExportRipple — fast-filter quote-form coverage (real repos)
// =============================================================================

describe("checkExportRipple — fast-filter quote forms", () => {
	// Each case isolates ONE arm of the 6-way `||` substring pre-filter by
	// embedding exactly that quoted token, alongside a real relative import.
	const forms: Array<[label: string, token: string]> = [
		["double-quoted basename", `"target"`],
		["single-quoted basename", `'target'`],
		["double-quoted .js", `"target.js"`],
		["single-quoted .js", `'target.js'`],
		["double-quoted .ts", `"target.ts"`],
		["single-quoted .ts", `'target.ts'`],
	];

	for (const [label, token] of forms) {
		it(`fires via the ${label} pre-filter arm`, () => {
			const repo = makeRepo();
			const targetSrc = "export const present = 1;\n";
			write(repo, "src/target.ts", targetSrc);
			write(
				repo,
				"src/importer.ts",
				`import { present, gone } from "./target.js";\nconst t = ${token};\nvoid t;\n`,
			);
			add(repo);
			const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
			expect(matches).toHaveLength(1);
			expect(nonNull(matches[0]).text).toContain('imports "gone"');
		});
	}
});

// =============================================================================
// checkExportRipple — fs/git error branches via module mocks
// =============================================================================

describe("checkExportRipple — fs/git error branches (mocked)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("node:fs");
		vi.doUnmock("node:child_process");
		vi.resetModules();
	});

	it("returns [] when readFileSync throws during the importer fast-filter (inner catch => filtered out)", async () => {
		vi.resetModules();
		// git returns one candidate importer file...
		vi.doMock("node:child_process", () => ({
			execFileSync: () => "src/importer.ts\0",
		}));
		// ...but every readFileSync throws => the `.filter` callback's inner
		// try/catch returns false for it => importerFiles empty => [].
		vi.doMock("node:fs", () => ({
			readFileSync: () => {
				throw new Error("EACCES");
			},
		}));
		const mod = await import("./export-ripple.js");
		const out = mod.checkExportRipple("export const a = 1;\n", "/repo/src/target.ts", "/repo");
		expect(out).toEqual([]);
	});

	it("continues past an importer whose readFileSync throws on the per-importer re-read", async () => {
		vi.resetModules();
		vi.doMock("node:child_process", () => ({
			// One importer candidate.
			execFileSync: () => "src/importer.ts\0",
		}));
		// First read (fast-filter) succeeds and contains the bare-quoted basename
		// so the file is kept; the second read (per-importer parse loop) throws
		// => hits the `catch { continue }`.
		let call = 0;
		vi.doMock("node:fs", () => ({
			readFileSync: () => {
				call++;
				if (call === 1) {
					return `import { gone } from "./target.js";\nconst t = "target";`;
				}
				throw new Error("ENOENT on re-read");
			},
		}));
		const mod = await import("./export-ripple.js");
		const out = mod.checkExportRipple("export const a = 1;\n", "/repo/src/target.ts", "/repo");
		// The only importer was skipped via `continue` => no matches, no throw.
		expect(out).toEqual([]);
		expect(call).toBeGreaterThanOrEqual(2);
	});

	it("flags a missing export end-to-end with git+fs fully mocked", async () => {
		vi.resetModules();
		vi.doMock("node:child_process", () => ({
			execFileSync: () => "src/importer.ts\0",
		}));
		// Both reads return an importer that imports a missing name `phantom`
		// AND carries the bare-quoted basename token to pass the fast-filter.
		vi.doMock("node:fs", () => ({
			readFileSync: () => `import { phantom } from "./target.js";\nconst t = "target";`,
		}));
		const mod = await import("./export-ripple.js");
		const out = mod.checkExportRipple(
			"export const real = 1;\n",
			"/repo/src/target.ts",
			"/repo",
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain('imports "phantom"');
		expect(nonNull(out[0]).text).toContain("src/importer.ts:1");
	});
});
