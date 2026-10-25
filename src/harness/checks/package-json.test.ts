// Tests for the `package_json_publish_invariants` check.
//
// Strategy: use a real tmp directory so the check's on-disk pre-edit read and
// tree-root marker detection behave as they do in production. Mocking fs here
// would hide the check's actual gating behaviour, which is the load-bearing
// invariant we're trying to enforce.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkPackageJsonPublishInvariants,
	checkPackageJsonPublishInvariantsWithPublint,
	checkPackageJsonScriptPaths,
} from "./package-json.js";

// A "complete" pre-edit package.json with every field the check tracks.
const FULL_PKG = {
	name: "my-pkg",
	version: "1.0.0",
	license: "MIT",
	repository: { type: "git", url: "git+https://example.com/foo.git" },
	homepage: "https://example.com",
	bugs: { url: "https://example.com/issues" },
	keywords: ["a", "b"],
	author: "Someone",
	engines: { node: ">=22" },
	main: "dist/index.js",
	types: "dist/index.d.ts",
	exports: { ".": "./dist/index.js" },
	bin: { "my-cli": "./dist/cli.js" },
	files: ["dist/"],
	publishConfig: { access: "public" },
	sideEffects: false,
	type: "module",
	scripts: {
		build: "tsc",
		prepublishOnly: "npm test",
	},
};

describe("checkPackageJsonPublishInvariants", () => {
	let tmp: string;
	let pkgPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pjpi-"));
		// Create a lockfile so the tree-root gate passes.
		writeFileSync(join(tmp, "package-lock.json"), "{}");
		pkgPath = join(tmp, "package.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// Case 1
	it("flags when pre-edit has `files` but post-edit removes it", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG, null, 2));

		const { files: _files, ...postEdit } = FULL_PKG;
		void _files;

		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(postEdit, null, 2),
			pkgPath,
		);
		expect(findings.length).toBeGreaterThanOrEqual(1);
		expect(findings.some((f) => f.text.includes("`files`"))).toBe(true);
	});

	// Case 2
	it("does NOT flag when post-edit adds fields that were absent pre-edit", () => {
		const minimal = { name: "my-pkg", version: "1.0.0" };
		writeFileSync(pkgPath, JSON.stringify(minimal));

		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(FULL_PKG, null, 2),
			pkgPath,
		);
		expect(findings).toEqual([]);
	});

	// Case 3
	it("does NOT flag when pre and post both contain every field", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(FULL_PKG, null, 2),
			pkgPath,
		);
		expect(findings).toEqual([]);
	});

	// Case 4
	it("skips the entire check when pre-edit is private", () => {
		const privatePkg = { ...FULL_PKG, private: true };
		writeFileSync(pkgPath, JSON.stringify(privatePkg));

		// Post-edit strips everything but still private.
		const stripped = { name: "my-pkg", version: "1.0.0", private: true };
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(stripped), pkgPath);
		expect(findings).toEqual([]);
	});

	// Case 5
	it("emits a single parse-error finding when post-edit JSON is malformed", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
		const findings = checkPackageJsonPublishInvariants(
			'{ "name": "my-pkg", "version": "1.0.0", ',
			pkgPath,
		);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("not valid JSON");
	});

	// Case 6
	it("flags when pre-edit has scripts.prepublishOnly and post-edit removes it", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));

		const postEdit = { ...FULL_PKG, scripts: { build: "tsc" } };
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(postEdit, null, 2),
			pkgPath,
		);
		expect(findings.some((f) => f.text.includes("scripts.prepublishOnly"))).toBe(true);
	});

	// Case 7
	it.each(["echo npm test", "npm test || true", "echo 'npm test'"])("does not count %s as preserving the removed publish gate", (prepack) => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
		const postEdit = { ...FULL_PKG, scripts: { build: "tsc", prepack } };
		expect(checkPackageJsonPublishInvariants(JSON.stringify(postEdit), pkgPath).some((finding) => finding.text.includes("scripts.prepublishOnly"))).toBe(true);
	});

	it("does NOT flag when `exports` changes shape (object → string) but stays present", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));

		const postEdit = { ...FULL_PKG, exports: "./dist/index.js" };
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(postEdit, null, 2),
			pkgPath,
		);
		// `exports` is still present, so no finding for it.
		expect(findings.some((f) => f.text.includes("`exports`"))).toBe(false);
	});

	// Case 8
	it("does NOT flag when `files` array shrinks but still has entries", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));

		const postEdit = { ...FULL_PKG, files: ["dist/"] };
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(postEdit, null, 2),
			pkgPath,
		);
		expect(findings).toEqual([]);
	});

	it("DOES flag when `files` array shrinks to empty (treated as removed)", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));

		const postEdit = { ...FULL_PKG, files: [] };
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(postEdit, null, 2),
			pkgPath,
		);
		expect(findings.some((f) => f.text.includes("`files`"))).toBe(true);
	});

	// Case 10
	it("does NOT fire on package.json files that are not at a tree root", () => {
		// Create a nested fixture dir with a package.json but NO lockfile sibling.
		const fixtureDir = join(tmp, "test", "fixtures", "pkg");
		mkdirSync(fixtureDir, { recursive: true });
		const nestedPkgPath = join(fixtureDir, "package.json");
		writeFileSync(nestedPkgPath, JSON.stringify(FULL_PKG));

		const postEdit = { name: "my-pkg" }; // strips basically everything
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(postEdit), nestedPkgPath);
		expect(findings).toEqual([]);
	});

	it("does NOT fire when the file didn't exist pre-edit (first-time creation)", () => {
		// Do NOT write pkgPath — it's absent.
		expect(existsSync(pkgPath)).toBe(false);

		const postEdit = { name: "brand-new", version: "0.0.0" };
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(postEdit), pkgPath);
		expect(findings).toEqual([]);
	});

	it("does NOT fire on package.json inside node_modules", () => {
		const nmPath = join(tmp, "node_modules", "foo", "package.json");
		mkdirSync(join(tmp, "node_modules", "foo"), { recursive: true });
		writeFileSync(nmPath, JSON.stringify(FULL_PKG));

		const postEdit = { name: "foo" };
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(postEdit), nmPath);
		expect(findings).toEqual([]);
	});

	it("does NOT fire on files named something-package.json or package.json.bak", () => {
		writeFileSync(join(tmp, "package.json.bak"), JSON.stringify(FULL_PKG));
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify({ name: "x" }),
			join(tmp, "package.json.bak"),
		);
		expect(findings).toEqual([]);
	});

	it("treats a top-level JSON array as invalid (not an object) post-edit", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
		const findings = checkPackageJsonPublishInvariants("[1,2,3]", pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("not valid JSON");
	});

	it("treats a top-level JSON primitive as invalid (not an object) post-edit", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
		const findings = checkPackageJsonPublishInvariants("42", pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("not valid JSON");
	});

	it("does NOT fire when the pre-edit path is a directory (unreadable as a file)", () => {
		mkdirSync(pkgPath, { recursive: true });
		const findings = checkPackageJsonPublishInvariants(JSON.stringify({ name: "x" }), pkgPath);
		expect(findings).toEqual([]);
	});

	it("does NOT flag a field that pre-edit held only an empty string (not 'present')", () => {
		const pkgWithBlank = { ...FULL_PKG, homepage: "" };
		writeFileSync(pkgPath, JSON.stringify(pkgWithBlank));
		const { homepage: _homepage, ...postEdit } = pkgWithBlank;
		void _homepage;
		const findings = checkPackageJsonPublishInvariants(JSON.stringify(postEdit), pkgPath);
		expect(findings.some((f) => f.text.includes("`homepage`"))).toBe(false);
	});

	// Integration — the bug that triggered this check
	it("integration: silently stripping half of a real package.json produces N findings", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG, null, 2));

		// Reproduce the original incident: strip files/main/types/exports/license/
		// repository/homepage/bugs/keywords/author/engines/sideEffects/publishConfig
		// and scripts.prepublishOnly.
		const stripped = {
			name: FULL_PKG.name,
			version: FULL_PKG.version,
			scripts: { build: "tsc" }, // keeps scripts, drops prepublishOnly
			bin: FULL_PKG.bin, // keeps bin
			type: FULL_PKG.type, // keeps type
		};
		const findings = checkPackageJsonPublishInvariants(
			JSON.stringify(stripped, null, 2),
			pkgPath,
		);

		const expectedMissing = [
			"license",
			"repository",
			"homepage",
			"bugs",
			"keywords",
			"author",
			"engines",
			"main",
			"types",
			"exports",
			"files",
			"publishConfig",
			"sideEffects",
		];
		for (const field of expectedMissing) {
			expect(
				findings.some((f) => f.text.includes(`\`${field}\``)),
				`expected a finding for removed field "${field}"`,
			).toBe(true);
		}
		// And the script removal.
		expect(findings.some((f) => f.text.includes("scripts.prepublishOnly"))).toBe(true);

		// Should NOT flag name/version/bin/type (still present).
		for (const field of ["name", "version", "bin", "type"]) {
			expect(
				findings.some(
					(f) => f.text.includes(`\`${field}\``) && !f.text.includes(`scripts.${field}`),
				),
				`should NOT flag preserved field "${field}"`,
			).toBe(false);
		}
	});
});

describe("checkPackageJsonPublishInvariantsWithPublint", () => {
	let tmp: string;
	let pkgPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pjpi-publint-"));
		writeFileSync(join(tmp, "package-lock.json"), "{}");
		pkgPath = join(tmp, "package.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// Case 9 — we can't guarantee publint is installed in the test env, but we
	// can verify the async wrapper returns at least the sync findings and
	// doesn't throw if publint is missing.
	it("returns base findings and degrades gracefully when publint is unavailable", async () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG, null, 2));

		const { files: _files, ...postEdit } = FULL_PKG;
		void _files;

		const findings = await checkPackageJsonPublishInvariantsWithPublint(
			JSON.stringify(postEdit),
			pkgPath,
		);
		expect(findings.some((f) => f.text.includes("`files`"))).toBe(true);
	});

	it("short-circuits before calling publint when the base result is a parse error", async () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
		const findings = await checkPackageJsonPublishInvariantsWithPublint(
			'{ "name": "my-pkg", ',
			pkgPath,
		);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("not valid JSON");
	});

	it("skips publint on private packages even if installed", async () => {
		const privatePkg = { ...FULL_PKG, private: true };
		writeFileSync(pkgPath, JSON.stringify(privatePkg));

		// Post-edit is valid, private, has all fields — should produce zero
		// findings regardless of publint availability.
		const findings = await checkPackageJsonPublishInvariantsWithPublint(
			JSON.stringify(privatePkg),
			pkgPath,
		);
		expect(findings).toEqual([]);
	});
});

describe("checkPackageJsonScriptPaths", () => {
	let tmp: string;
	let pkgPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pjsp-"));
		pkgPath = join(tmp, "package.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns nothing when scripts is absent", () => {
		const content = JSON.stringify({ name: "x", version: "1.0.0" });
		expect(checkPackageJsonScriptPaths(content, pkgPath)).toEqual([]);
	});

	it("returns nothing when scripts have no file refs", () => {
		const content = JSON.stringify({
			scripts: { build: "tsc", test: "vitest run", lint: "eslint ." },
		});
		expect(checkPackageJsonScriptPaths(content, pkgPath)).toEqual([]);
	});

	it("flags `node ./path.mjs` referencing a missing file (the Schwab CI failure)", () => {
		const content = JSON.stringify({
			scripts: {
				"test:custom": "node ./scripts/structured-content-regression.mjs",
			},
		});
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("test:custom");
		expect(nonNull(findings[0]).text).toContain("structured-content-regression.mjs");
	});

	it("passes when the referenced file exists", () => {
		mkdirSync(join(tmp, "scripts"));
		writeFileSync(join(tmp, "scripts", "go.mjs"), "console.log(1);\n");
		const content = JSON.stringify({
			scripts: { run: "node ./scripts/go.mjs" },
		});
		expect(checkPackageJsonScriptPaths(content, pkgPath)).toEqual([]);
	});

	it("recognizes tsx, bun, deno runtimes", () => {
		const content = JSON.stringify({
			scripts: {
				a: "tsx ./missing-a.ts",
				b: "bun ./missing-b.ts",
				c: "deno ./missing-c.ts",
			},
		});
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(3);
	});

	it("flags `tsc -p tsconfig.build.json` when the config doesn't exist", () => {
		const content = JSON.stringify({
			scripts: { build: "tsc -p tsconfig.build.json" },
		});
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("tsconfig.build.json");
	});

	it("flags `--config X.json` when the config doesn't exist", () => {
		const content = JSON.stringify({
			scripts: { test: "vitest --config vitest.config.ts" },
		});
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("vitest.config.ts");
	});

	it("does not double-report the same (script, ref) pair", () => {
		const content = JSON.stringify({
			scripts: { run: "node ./missing.mjs && node ./missing.mjs" },
		});
		expect(checkPackageJsonScriptPaths(content, pkgPath)).toHaveLength(1);
	});

	it("does NOT flag `eslint .` or other non-file args", () => {
		const content = JSON.stringify({
			scripts: { lint: "eslint . --max-warnings 0" },
		});
		expect(checkPackageJsonScriptPaths(content, pkgPath)).toEqual([]);
	});

	it("skips node_modules paths", () => {
		const innerPkg = join(tmp, "node_modules", "foo", "package.json");
		mkdirSync(dirname(innerPkg), { recursive: true });
		const content = JSON.stringify({ scripts: { run: "node ./missing.mjs" } });
		expect(checkPackageJsonScriptPaths(content, innerPkg)).toEqual([]);
	});

	it("returns nothing when the post-edit content is not valid JSON", () => {
		expect(checkPackageJsonScriptPaths("{ not valid", pkgPath)).toEqual([]);
	});

	it("skips a script whose value is not a string (e.g. a number)", () => {
		const content = JSON.stringify({
			scripts: { weird: 123, run: "node ./scripts/missing.mjs" },
		});
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("scripts.run");
	});

	it("flags a missing file referenced by an absolute path", () => {
		const content = JSON.stringify({
			scripts: { run: "node /definitely/not-real/missing.mjs" },
		});
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("/definitely/not-real/missing.mjs");
	});

	it("falls back to line 1 when the script key's raw text can't be located (unicode escape)", () => {
		// The parsed key is "café", but the literal source text contains the
		// é escape sequence rather than the character itself, so the
		// per-line substring search for `"café"` never matches.
		const content = '{"scripts":{"caf\\u00e9":"node ./scripts/missing.mjs"}}';
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).line).toBe(1);
	});

	it("emits one finding per missing file across multiple scripts", () => {
		const content = JSON.stringify({
			scripts: {
				a: "node ./scripts/a.mjs",
				b: "tsx ./scripts/b.ts",
				c: "tsc -p tsconfig.build.json",
			},
		});
		const findings = checkPackageJsonScriptPaths(content, pkgPath);
		expect(findings).toHaveLength(3);
	});
});
