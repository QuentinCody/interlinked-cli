import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectRepoProfile, getRepoProfile, resetRepoProfileCache } from "./repo-profile.js";

/** Build a fixture repo: each entry is a repo-relative file path + contents. */
function writeFixture(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content, "utf8");
	}
}

describe("repo-profile", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "repo-profile-"));
		resetRepoProfileCache();
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		resetRepoProfileCache();
	});

	describe("testLayout", () => {
		it("detects colocated when a *.test.* file sits beside source", () => {
			writeFixture(root, {
				"src/a.ts": "export const a = 1;\n",
				"src/a.test.ts": "import './a.js';\n",
			});
			const profile = detectRepoProfile(root);
			expect(profile.testLayout).toBe("colocated");
			expect(profile.testDirRoots).toEqual([]);
		});

		it("detects colocated for *.spec.* files too", () => {
			writeFixture(root, {
				"lib/b.js": "module.exports = 1;\n",
				"lib/b.spec.js": "require('./b');\n",
			});
			expect(detectRepoProfile(root).testLayout).toBe("colocated");
		});

		it("detects separate-tree when tests live only under top-level tests/", () => {
			writeFixture(root, {
				"src/a.ts": "export const a = 1;\n",
				"tests/a.test.ts": "import '../src/a.js';\n",
			});
			const profile = detectRepoProfile(root);
			expect(profile.testLayout).toBe("separate-tree");
			expect(profile.testDirRoots).toEqual(["tests"]);
		});

		it("recognizes test/ and __tests__/ as separate-tree roots", () => {
			writeFixture(root, {
				"src/a.ts": "export const a = 1;\n",
				"test/a.test.ts": "import '../src/a.js';\n",
				"__tests__/b.spec.ts": "export {};\n",
			});
			const profile = detectRepoProfile(root);
			expect(profile.testLayout).toBe("separate-tree");
			expect(profile.testDirRoots).toEqual(["__tests__", "test"]);
		});

		it("colocated wins over a separate tree when both exist", () => {
			writeFixture(root, {
				"src/a.ts": "export const a = 1;\n",
				"src/a.test.ts": "import './a.js';\n",
				"tests/b.test.ts": "export {};\n",
			});
			const profile = detectRepoProfile(root);
			expect(profile.testLayout).toBe("colocated");
			expect(profile.testDirRoots).toEqual(["tests"]);
		});

		it("returns none when no test files exist anywhere", () => {
			writeFixture(root, {
				"src/a.ts": "export const a = 1;\n",
				"README.md": "hello\n",
			});
			const profile = detectRepoProfile(root);
			expect(profile.testLayout).toBe("none");
			expect(profile.testDirRoots).toEqual([]);
		});

		it("returns none when the only tests/ dir holds no test files", () => {
			writeFixture(root, {
				"src/a.ts": "export const a = 1;\n",
				"tests/fixtures/data.json": "{}\n",
			});
			expect(detectRepoProfile(root).testLayout).toBe("none");
		});

		it("ignores test files inside node_modules, dist, and dot-dirs", () => {
			writeFixture(root, {
				"src/a.ts": "export const a = 1;\n",
				"node_modules/pkg/x.test.js": "x\n",
				"dist/out.test.js": "x\n",
				".venv/lib/test_thing.py": "x\n",
			});
			const profile = detectRepoProfile(root);
			expect(profile.testLayout).toBe("none");
			expect(profile.runners.python).toBe(false);
		});
	});

	describe("runners.js", () => {
		it("detects vitest in devDependencies", () => {
			writeFixture(root, {
				"package.json": JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }),
			});
			expect(detectRepoProfile(root).runners.js).toBe(true);
		});

		it("detects jest in dependencies", () => {
			writeFixture(root, {
				"package.json": JSON.stringify({ dependencies: { jest: "^29.0.0" } }),
			});
			expect(detectRepoProfile(root).runners.js).toBe(true);
		});

		it("detects a jest config file at root without package.json deps", () => {
			writeFixture(root, {
				"jest.config.js": "module.exports = {};\n",
			});
			expect(detectRepoProfile(root).runners.js).toBe(true);
		});

		it("detects a vitest config file at root", () => {
			writeFixture(root, {
				"vitest.config.ts": "export default {};\n",
			});
			expect(detectRepoProfile(root).runners.js).toBe(true);
		});

		it("stays false when package.json declares neither vitest nor jest", () => {
			writeFixture(root, {
				"package.json": JSON.stringify({
					dependencies: { lodash: "^4.0.0" },
					devDependencies: { typescript: "^5.0.0" },
				}),
			});
			expect(detectRepoProfile(root).runners.js).toBe(false);
		});

		it("stays false with no package.json and no runner config", () => {
			writeFixture(root, { "src/a.ts": "export const a = 1;\n" });
			expect(detectRepoProfile(root).runners.js).toBe(false);
		});

		it("fails toward enforcement (true) when package.json is malformed JSON", () => {
			writeFixture(root, { "package.json": "{ this is not valid json" });
			expect(detectRepoProfile(root).runners.js).toBe(true);
		});

		it.each([null, [], 42])("does not infer a test runner from a non-object package manifest: %j", (manifest) => {
			writeFixture(root, { "package.json": JSON.stringify(manifest) });
			expect(detectRepoProfile(root).runners.js).toBe(false);
		});
	});

	describe("runners.python", () => {
		it("detects pytest.ini", () => {
			writeFixture(root, { "pytest.ini": "[pytest]\n" });
			expect(detectRepoProfile(root).runners.python).toBe(true);
		});

		it("detects [tool.pytest] sections in pyproject.toml", () => {
			writeFixture(root, {
				"pyproject.toml": '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
			});
			expect(detectRepoProfile(root).runners.python).toBe(true);
		});

		it("detects [tool:pytest] in setup.cfg", () => {
			writeFixture(root, { "setup.cfg": "[tool:pytest]\naddopts = -q\n" });
			expect(detectRepoProfile(root).runners.python).toBe(true);
		});

		it("detects test_*.py under a top-level test dir", () => {
			writeFixture(root, {
				"pkg/mod.py": "x = 1\n",
				"tests/test_mod.py": "def test_x(): pass\n",
			});
			const profile = detectRepoProfile(root);
			expect(profile.runners.python).toBe(true);
			expect(profile.testLayout).toBe("separate-tree");
		});

		it("stays false for pyproject.toml without a pytest section", () => {
			writeFixture(root, { "pyproject.toml": '[tool.poetry]\nname = "x"\n' });
			expect(detectRepoProfile(root).runners.python).toBe(false);
		});

		it("stays false for setup.cfg without [tool:pytest]", () => {
			writeFixture(root, { "setup.cfg": "[metadata]\nname = x\n" });
			expect(detectRepoProfile(root).runners.python).toBe(false);
		});

		it("stays false when no python markers exist at all", () => {
			writeFixture(root, { "src/a.ts": "export const a = 1;\n" });
			expect(detectRepoProfile(root).runners.python).toBe(false);
		});
	});

	describe("fail-safe error path", () => {
		it("returns the fail-toward-enforcement profile for a nonexistent root", () => {
			const profile = detectRepoProfile(join(root, "does-not-exist"));
			expect(profile.runners).toEqual({ js: true, python: true });
			expect(profile.testLayout).toBe("colocated");
			expect(profile.testDirRoots).toEqual([]);
		});

		it("never throws when the root is a file, and fails toward enforcement", () => {
			const filePath = join(root, "not-a-dir");
			writeFileSync(filePath, "x", "utf8");
			const profile = detectRepoProfile(filePath);
			expect(profile.runners).toEqual({ js: true, python: true });
			expect(profile.testLayout).toBe("colocated");
		});

		it("stamps detectedAt as a parseable ISO timestamp even on error", () => {
			const profile = detectRepoProfile(join(root, "does-not-exist"));
			expect(Number.isFinite(Date.parse(profile.detectedAt))).toBe(true);
			expect(new Date(profile.detectedAt).toISOString()).toBe(profile.detectedAt);
		});
	});

	describe("scan truncation fails toward enforcement", () => {
		it("resolves an unknown layout to colocated (never 'none') when the depth cap truncates", () => {
			// The one deep directory sits past MAX_WALK_DEPTH (6), so the walk prunes it
			// and never sees what's inside. With no test found shallow, an unbounded scan
			// would report "none" — which DEMOTES the TDD gate to advisory. A partial scan
			// must instead fail toward enforcement.
			writeFixture(root, {
				"src/app.ts": "export const app = 1;\n",
				// depth: a=1 b=2 c=3 d=4 e=5 f=6 g=7(pruned) — the leaf is never scanned
				"a/b/c/d/e/f/g/h/leaf.ts": "export const leaf = 1;\n",
			});
			const profile = detectRepoProfile(root);
			expect(profile.scanTruncated).toBe(true);
			expect(profile.testLayout).not.toBe("none");
			expect(profile.testLayout).toBe("colocated");
		});

		it("resolves an unknown layout to colocated (never 'none') when the entry budget truncates", () => {
			// Exceed MAX_WALK_ENTRIES (2000) with plain (non-test) files so the walk bails
			// out before it could ever confirm the repo is test-free.
			const files: Record<string, string> = { "src/app.ts": "export const app = 1;\n" };
			for (let i = 0; i < 2100; i++) files[`flat/f${i}.ts`] = "export {};\n";
			writeFixture(root, files);
			const profile = detectRepoProfile(root);
			expect(profile.scanTruncated).toBe(true);
			expect(profile.testLayout).not.toBe("none");
			expect(profile.testLayout).toBe("colocated");
		}, 20000);

		it("keeps an accurately-detected separate-tree layout even when the walk truncates", () => {
			// Real tests live under tests/ (found shallow) AND an unrelated deep dir trips
			// the depth cap. Truncation must NOT override an already-accurate layout — it
			// only upgrades the otherwise-unknown "none" case.
			writeFixture(root, {
				"src/a.ts": "export const a = 1;\n",
				"tests/a.test.ts": "import '../src/a.js';\n",
				"deep/b/c/d/e/f/g/leaf.ts": "export const leaf = 1;\n",
			});
			const profile = detectRepoProfile(root);
			expect(profile.scanTruncated).toBe(true);
			expect(profile.testLayout).toBe("separate-tree");
			expect(profile.testDirRoots).toEqual(["tests"]);
		});

		it("does not flag scanTruncated on a small, fully-scanned repo", () => {
			writeFixture(root, {
				"src/a.ts": "export const a = 1;\n",
				"src/a.test.ts": "import './a.js';\n",
			});
			const profile = detectRepoProfile(root);
			expect(profile.scanTruncated).toBe(false);
			expect(profile.testLayout).toBe("colocated");
		});
	});

	describe("memoization", () => {
		let otherRoot: string;
		beforeEach(() => {
			otherRoot = mkdtempSync(join(tmpdir(), "repo-profile-other-"));
		});
		afterEach(() => {
			rmSync(otherRoot, { recursive: true, force: true });
		});

		it("returns the identical object on a second getRepoProfile call", () => {
			writeFixture(root, { "src/a.test.ts": "export {};\n" });
			const first = getRepoProfile(root);
			const second = getRepoProfile(root);
			expect(second).toBe(first);
		});

		it("does not re-scan after the repo changes (daemon-lifetime memo)", () => {
			writeFixture(root, { "src/a.ts": "export const a = 1;\n" });
			const first = getRepoProfile(root);
			expect(first.testLayout).toBe("none");
			writeFixture(root, { "src/a.test.ts": "export {};\n" });
			expect(getRepoProfile(root).testLayout).toBe("none");
		});

		it("resetRepoProfileCache forces a fresh detection", () => {
			writeFixture(root, { "src/a.ts": "export const a = 1;\n" });
			const first = getRepoProfile(root);
			writeFixture(root, { "src/a.test.ts": "export {};\n" });
			resetRepoProfileCache();
			const second = getRepoProfile(root);
			expect(second).not.toBe(first);
			expect(second.testLayout).toBe("colocated");
		});

		it("memoizes per resolved root — different roots get different profiles", () => {
			writeFixture(root, { "src/a.test.ts": "export {};\n" });
			writeFixture(otherRoot, { "src/a.ts": "export const a = 1;\n" });
			expect(getRepoProfile(root).testLayout).toBe("colocated");
			expect(getRepoProfile(otherRoot).testLayout).toBe("none");
		});
	});
});
