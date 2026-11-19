// ===========================================
// file-discovery unit tests
// ===========================================

import { execSync } from "node:child_process";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CODE_EXTENSIONS,
	discoverFiles,
	discoverFunctionTokenFiles,
} from "./file-discovery.js";

let tempDir: string;
let counter = 0;

beforeEach(() => {
	tempDir = join(tmpdir(), `file-discovery-test-${process.pid}-${++counter}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function gitInit(dir: string): void {
	execSync("git init -q", { cwd: dir });
	execSync('git config user.email "t@example.com"', { cwd: dir });
	execSync('git config user.name "test"', { cwd: dir });
}

describe("CODE_EXTENSIONS", () => {
	it("includes major TS/JS extensions", () => {
		expect(CODE_EXTENSIONS.has(".ts")).toBe(true);
		expect(CODE_EXTENSIONS.has(".tsx")).toBe(true);
		expect(CODE_EXTENSIONS.has(".js")).toBe(true);
		expect(CODE_EXTENSIONS.has(".mjs")).toBe(true);
	});

	it("includes every remaining source extension", () => {
		// Each of these is a distinct Set member — assert them individually so
		// a mutant that blanks out any single string literal is caught.
		const rest = [
			".jsx",
			".cjs",
			".mts",
			".cts",
			".py",
			".rs",
			".go",
			".c",
			".cpp",
			".cc",
			".cxx",
			".h",
			".hpp",
			".java",
		];
		for (const ext of rest) {
			expect(CODE_EXTENSIONS.has(ext)).toBe(true);
		}
	});

	it("excludes markdown/json/text", () => {
		expect(CODE_EXTENSIONS.has(".md")).toBe(false);
		expect(CODE_EXTENSIONS.has(".json")).toBe(false);
		expect(CODE_EXTENSIONS.has(".txt")).toBe(false);
	});
});

describe("discoverFiles", () => {
	it("returns code + config + docs (wide text-scan policy)", () => {
		// Policy: scan every tracked text file, then let individual checks
		// filter by applicable extension. Fixes the summary-line bug where
		// files like tsconfig.json were flagged by external tools but never
		// counted in the "files scanned" denominator.
		writeFileSync(join(tempDir, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(tempDir, "b.js"), "module.exports = {};\n");
		writeFileSync(join(tempDir, "c.md"), "# docs\n");
		writeFileSync(join(tempDir, "tsconfig.json"), "{}\n");
		const files = discoverFiles(tempDir);
		const names = files.map((f) => f.split("/").pop()).sort();
		expect(names).toContain("a.ts");
		expect(names).toContain("b.js");
		expect(names).toContain("c.md");
		expect(names).toContain("tsconfig.json");
	});

	it("excludes binary assets and lock files", () => {
		writeFileSync(join(tempDir, "src.ts"), "export const z = 1;\n");
		writeFileSync(join(tempDir, "logo.png"), "\x89PNG\r\n\x1a\n");
		writeFileSync(join(tempDir, "font.woff2"), "binary");
		writeFileSync(join(tempDir, "package-lock.json"), "{}\n");
		writeFileSync(join(tempDir, "yarn.lock"), "# yarn lockfile\n");
		const files = discoverFiles(tempDir);
		const names = files.map((f) => f.split("/").pop()).sort();
		expect(names).toContain("src.ts");
		expect(names).not.toContain("logo.png");
		expect(names).not.toContain("font.woff2");
		expect(names).not.toContain("package-lock.json");
		expect(names).not.toContain("yarn.lock");
	});

	it("skips node_modules and dist directories", () => {
		mkdirSync(join(tempDir, "node_modules"), { recursive: true });
		writeFileSync(join(tempDir, "node_modules", "dep.ts"), "export const x = 1;\n");
		mkdirSync(join(tempDir, "dist"), { recursive: true });
		writeFileSync(join(tempDir, "dist", "out.ts"), "export const y = 1;\n");
		writeFileSync(join(tempDir, "src.ts"), "export const z = 1;\n");
		const files = discoverFiles(tempDir);
		const paths = files.map((f) => f.replace(tempDir, ""));
		expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
		expect(paths.some((p) => p.includes("/dist/"))).toBe(false);
		expect(paths.some((p) => p.endsWith("src.ts"))).toBe(true);
	});

	it("returns empty array for empty directory", () => {
		expect(discoverFiles(tempDir)).toEqual([]);
	});

	it("excludes every listed binary extension (manual-walk fallback)", () => {
		// One file per BINARY_EXTENSIONS member. If any single entry's string
		// literal is corrupted, the corresponding file leaks into the result.
		const binaryExts = [
			".png",
			".jpg",
			".jpeg",
			".gif",
			".webp",
			".avif",
			".ico",
			".bmp",
			".tiff",
			".heic",
			".mp3",
			".mp4",
			".wav",
			".ogg",
			".webm",
			".m4a",
			".mov",
			".flac",
			".avi",
			".mkv",
			".woff",
			".woff2",
			".ttf",
			".otf",
			".eot",
			".zip",
			".tar",
			".gz",
			".tgz",
			".bz2",
			".7z",
			".rar",
			".xz",
			".lz4",
			".zst",
			".exe",
			".dll",
			".so",
			".dylib",
			".bin",
			".class",
			".pyc",
			".pyo",
			".wasm",
			".a",
			".lib",
			".obj",
			".o",
			".node",
			".pdf",
			".psd",
			".ai",
			".sketch",
			".fig",
			".iso",
			".dmg",
			".img",
		];
		for (const [i, ext] of binaryExts.entries()) {
			writeFileSync(join(tempDir, `bin${i}${ext}`), "x");
		}
		writeFileSync(join(tempDir, "keep.ts"), "export const x = 1;\n");
		const names = discoverFiles(tempDir)
			.map((f) => f.split("/").pop())
			.sort();
		expect(names).toEqual(["keep.ts"]);
	});

	it("excludes every listed blocked basename (manual-walk fallback)", () => {
		const basenames = [
			"pnpm-lock.yaml",
			"npm-shrinkwrap.json",
			"Cargo.lock",
			"poetry.lock",
			"Pipfile.lock",
			"composer.lock",
			"Gemfile.lock",
			"go.sum",
		];
		for (const name of basenames) {
			writeFileSync(join(tempDir, name), "x\n");
		}
		writeFileSync(join(tempDir, "keep.ts"), "export const x = 1;\n");
		const names = discoverFiles(tempDir)
			.map((f) => f.split("/").pop())
			.sort();
		expect(names).toEqual(["keep.ts"]);
	});

	it("skips build/coverage/target/__pycache__/venv directories (manual-walk skip set)", () => {
		for (const dir of ["build", "coverage", "target", "__pycache__", "venv"]) {
			mkdirSync(join(tempDir, dir), { recursive: true });
			writeFileSync(join(tempDir, dir, "should-not-appear.ts"), "export const x = 1;\n");
		}
		writeFileSync(join(tempDir, "keep.ts"), "export const y = 1;\n");
		const names = discoverFiles(tempDir)
			.map((f) => f.split("/").pop())
			.sort();
		expect(names).toEqual(["keep.ts"]);
	});

	it("keeps hidden source files and directories during the manual walk", () => {
		writeFileSync(join(tempDir, ".hidden.ts"), "export const x = 1;\n");
		mkdirSync(join(tempDir, ".hiddendir"), { recursive: true });
		writeFileSync(join(tempDir, ".hiddendir", "nested.ts"), "export const x = 1;\n");
		writeFileSync(join(tempDir, "keep.ts"), "export const y = 1;\n");
		const names = discoverFiles(tempDir)
			.map((f) => f.split("/").pop())
			.sort();
		expect(names).toEqual([".hidden.ts", "keep.ts", "nested.ts"]);
	});

	it("applies extension/basename filtering to nested files during the manual walk", () => {
		// Exercises the `rel` computation for depth >= 1: a nested binary file
		// must still be excluded by extension, proving the relative path is
		// built correctly rather than degrading to an empty/garbage segment.
		mkdirSync(join(tempDir, "sub"), { recursive: true });
		writeFileSync(join(tempDir, "sub", "logo.png"), "\x89PNG\r\n\x1a\n");
		writeFileSync(join(tempDir, "sub", "keep.ts"), "export const x = 1;\n");
		const names = discoverFiles(tempDir)
			.map((f) => f.split("/").pop())
			.sort();
		expect(names).toEqual(["keep.ts"]);
	});

	it("includes files at and above the former 1MB boundary", () => {
		const oneMb = 1_000_000;
		writeFileSync(join(tempDir, "at-limit.ts"), "x".repeat(oneMb));
		writeFileSync(join(tempDir, "under-limit.ts"), "x".repeat(oneMb - 1));
		writeFileSync(join(tempDir, "above-limit.ts"), "x".repeat(oneMb + 1));
		const names = discoverFiles(tempDir)
			.map((f) => f.split("/").pop())
			.sort();
		expect(names).toEqual(["above-limit.ts", "at-limit.ts", "under-limit.ts"]);
	});

	describe("git-based discovery path", () => {
		it("scans an explicitly selected ignored directory without treating an empty Git census as an empty project", () => {
			gitInit(tempDir); writeFileSync(join(tempDir, ".gitignore"), "selected/\n");
			const selected = join(tempDir, "selected"); mkdirSync(selected);
			const file = join(selected, "main.rs"); writeFileSync(file, "fn main(){}\n");
			expect(discoverFiles(selected)).toEqual([file]);
		});

		it("retains a Git inventory larger than the default subprocess output buffer", () => {
			gitInit(tempDir);
			writeFileSync(join(tempDir, ".gitignore"), "ignored.ts\n");
			writeFileSync(join(tempDir, "ignored.ts"), "export const ignored = true;");
			const suffix = `${"long-name-".repeat(23)}.ts`;
			for (let index = 0; index < 6000; index++) writeFileSync(join(tempDir, `${index}-${suffix}`), "export const value = true;");
			const files = discoverFiles(tempDir);
			expect(files).toHaveLength(6001);
			expect(files).toContain(join(tempDir, `5999-${suffix}`));
			expect(files).not.toContain(join(tempDir, "ignored.ts"));
		}, 20_000);

		it("agrees with the non-git population for large, hidden and explicitly excluded paths", () => {
			for (const dir of [".storybook", "build", "coverage", "scratch", "src/scratch"]) mkdirSync(join(tempDir, dir), { recursive: true });
			for (const name of [".hidden.ts", ".storybook/main.ts", "build/out.ts", "coverage/out.ts", "scratch/copy.ts", "src/scratch/real.ts"]) {
				writeFileSync(join(tempDir, name), "export const value = true;");
			}
			writeFileSync(join(tempDir, "large.ts"), " ".repeat(1_000_001) + "export const end = true;");
			const before = discoverFiles(tempDir).map(file => file.replace(tempDir, "")).sort();
			gitInit(tempDir);
			const after = discoverFiles(tempDir).map(file => file.replace(tempDir, "")).sort();
			expect(before).toEqual(["/.hidden.ts", "/.storybook/main.ts", "/large.ts", "/src/scratch/real.ts"]);
			expect(after).toEqual(before);
		});

		it("respects .gitignore and runs the git command in the target root (not process cwd)", () => {
			gitInit(tempDir);
			writeFileSync(join(tempDir, ".gitignore"), "ignored.ts\n");
			writeFileSync(join(tempDir, "keep.ts"), "export const a = 1;\n");
			writeFileSync(join(tempDir, "ignored.ts"), "export const b = 1;\n");
			const names = discoverFiles(tempDir)
				.map((f) => f.split("/").pop())
				.sort();
			// Exact equality: if the options object (incl. `cwd`) were dropped,
			// git would run in the real project checkout and return a large,
			// unrelated file list instead of this tiny fixture's two files.
			expect(names).toEqual([".gitignore", "keep.ts"]);
		});

		it("excludes .interlinked/.claude/dist/node_modules at any nesting depth via the git path", () => {
			gitInit(tempDir);
			mkdirSync(join(tempDir, ".interlinked"), { recursive: true });
			writeFileSync(join(tempDir, ".interlinked", "foo.ts"), "x");
			mkdirSync(join(tempDir, "sub", ".interlinked"), { recursive: true });
			writeFileSync(join(tempDir, "sub", ".interlinked", "bar.ts"), "x");
			mkdirSync(join(tempDir, ".claude"), { recursive: true });
			writeFileSync(join(tempDir, ".claude", "settings.json"), "{}");
			mkdirSync(join(tempDir, "sub2", ".claude"), { recursive: true });
			writeFileSync(join(tempDir, "sub2", ".claude", "settings.json"), "{}");
			mkdirSync(join(tempDir, "dist"), { recursive: true });
			writeFileSync(join(tempDir, "dist", "out.js"), "x");
			mkdirSync(join(tempDir, "sub3", "dist"), { recursive: true });
			writeFileSync(join(tempDir, "sub3", "dist", "out.js"), "x");
			mkdirSync(join(tempDir, "node_modules"), { recursive: true });
			writeFileSync(join(tempDir, "node_modules", "pkg.js"), "x");
			mkdirSync(join(tempDir, "sub4", "node_modules"), { recursive: true });
			writeFileSync(join(tempDir, "sub4", "node_modules", "pkg.js"), "x");
			writeFileSync(join(tempDir, "keep.ts"), "x");
			const names = discoverFiles(tempDir)
				.map((f) => f.split("/").pop())
				.sort();
			expect(names).toEqual(["keep.ts"]);
		});
	});

});

describe("discoverFunctionTokenFiles", () => {
	it("retains a missing tracked source path so downstream metrics can label it unreadable", () => {
		gitInit(tempDir);
		const file = join(tempDir, "missing.ts");
		writeFileSync(file, "export const value = true;");
		execSync("git add missing.ts", { cwd: tempDir });
		unlinkSync(file);
		expect(discoverFunctionTokenFiles(tempDir)).toContain(file);
	});

	it("keeps hidden source directories in a non-git codebase", () => {
		mkdirSync(join(tempDir, ".storybook"), { recursive: true });
		writeFileSync(join(tempDir, ".storybook", "main.ts"), "export const x = 1;\n");
		const paths = discoverFunctionTokenFiles(tempDir).map((file) => file.replace(tempDir, ""));
		expect(paths).toContain("/.storybook/main.ts");
	});

	it("keeps source files at and above the ordinary walk size limit", () => {
		writeFileSync(join(tempDir, "large.ts"), "x".repeat(1_000_000));
		const names = discoverFunctionTokenFiles(tempDir).map((file) => file.split("/").pop());
		expect(names).toContain("large.ts");
	});

	it("returns tracked build and runner paths for the shared scope policy to classify", () => {
		gitInit(tempDir);
		mkdirSync(join(tempDir, "dist"), { recursive: true });
		mkdirSync(join(tempDir, ".claude"), { recursive: true });
		writeFileSync(join(tempDir, "dist", "manual.ts"), "export const x = 1;\n");
		writeFileSync(join(tempDir, ".claude", "tool.ts"), "export const x = 1;\n");
		const paths = discoverFunctionTokenFiles(tempDir).map((file) => file.replace(tempDir, ""));
		expect(paths).toContain("/dist/manual.ts");
		expect(paths).toContain("/.claude/tool.ts");
	});
});
