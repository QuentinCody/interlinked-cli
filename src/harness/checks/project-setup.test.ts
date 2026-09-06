// Tests for project-setup.ts — focuses on the universal
// tsconfig.types ↔ deps cross-check helper.

import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkClaudeSettingsPermissions,
	checkProjectSetup,
	checkTsConfigTypesAgainstDeps,
} from "./project-setup.js";

describe("checkTsConfigTypesAgainstDeps", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "psetup-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function writePkg(deps: Record<string, string>, devDeps: Record<string, string> = {}) {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ name: "x", dependencies: deps, devDependencies: devDeps }),
		);
	}

	it("returns nothing when types[] is absent", () => {
		writePkg({});
		expect(checkTsConfigTypesAgainstDeps({}, tmp)).toEqual([]);
	});

	it("returns nothing when types[] is empty", () => {
		writePkg({});
		expect(checkTsConfigTypesAgainstDeps({ types: [] }, tmp)).toEqual([]);
	});

	it("flags scoped types[] entry that isn't in deps (the @cloudflare/workers-types CI failure)", () => {
		writePkg({}, {});
		const issues = checkTsConfigTypesAgainstDeps(
			{ types: ["@cloudflare/workers-types"] },
			tmp,
		);
		expect(issues).toHaveLength(1);
		expect(nonNull(issues[0]).message).toContain("@cloudflare/workers-types");
		expect(nonNull(issues[0]).fix).toContain("@cloudflare/workers-types");
	});

	it("passes when scoped types[] entry IS in deps", () => {
		writePkg({}, { "@cloudflare/workers-types": "^4.0.0" });
		expect(
			checkTsConfigTypesAgainstDeps({ types: ["@cloudflare/workers-types"] }, tmp),
		).toEqual([]);
	});

	it("passes when unscoped types[] entry exists as the package itself", () => {
		writePkg({}, { vitest: "^1.0.0" });
		expect(checkTsConfigTypesAgainstDeps({ types: ["vitest"] }, tmp)).toEqual([]);
	});

	it("passes when unscoped types[] entry exists as @types/<name>", () => {
		writePkg({}, { "@types/node": "^20.0.0" });
		expect(checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp)).toEqual([]);
	});

	it("reads regular dependencies when satisfying an unscoped type entry", () => {
		writePkg({ vitest: "^1.0.0" });
		expect(checkTsConfigTypesAgainstDeps({ types: ["vitest"] }, tmp)).toEqual([]);
	});

	it("reads optional dependencies when satisfying an unscoped type entry", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ name: "x", optionalDependencies: { "@types/node": "^20.0.0" } }),
		);
		expect(checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp)).toEqual([]);
	});

	it("flags unscoped types[] entry when neither variant is installed", () => {
		writePkg({}, {});
		const issues = checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp);
		expect(issues).toHaveLength(1);
		expect(nonNull(issues[0]).message).toContain("node");
		expect(nonNull(issues[0]).message).toContain("@types/node");
		expect(nonNull(issues[0]).fix).toBe("Run `npm i --save-dev @types/node`");
	});

	it("preserves the exact scoped-package diagnostic and install fix", () => {
		writePkg({}, {});
		expect(checkTsConfigTypesAgainstDeps({ types: ["@scope/types"] }, tmp)).toEqual([
			{
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message:
					'tsconfig.json includes types: ["@scope/types"] but "@scope/types" is not in package.json. tsc will fail to resolve these globals.',
				fix: "Run `npm i --save-dev @scope/types`",
			},
		]);
	});

	it("checks peer- and optional-dependencies too", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				name: "x",
				peerDependencies: { "@types/node": "^20.0.0" },
			}),
		);
		expect(checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp)).toEqual([]);
	});

	// test-contract: public-api — every declared package relationship can satisfy a scoped compiler type
	it("recognizes scoped types from peer and optional dependencies", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				name: "x",
				peerDependencies: { "@scope/peer-types": "^1.0.0" },
				optionalDependencies: { "@scope/optional-types": "^1.0.0" },
			}),
		);

		expect(
			checkTsConfigTypesAgainstDeps(
				{ types: ["@scope/peer-types", "@scope/optional-types"] },
				tmp,
			),
		).toEqual([]);
	});

	// test-contract: boundary — malformed dependency metadata fails open to an actionable missing-type issue
	it("treats malformed package.json as having no installed dependencies", () => {
		writeFileSync(join(tmp, "package.json"), "{ not valid json");

		const issues = checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp);
		expect(issues).toHaveLength(1);
		expect(nonNull(issues[0]).message).toContain("neither \"node\" nor \"@types/node\"");
	});

	// test-contract: boundary — a non-array compiler types value is ignored without producing a false finding
	it("ignores a non-array types value", () => {
		writePkg({}, {});
		expect(checkTsConfigTypesAgainstDeps({ types: "node" }, tmp)).toEqual([]);
	});

	it("emits one finding per missing entry", () => {
		writePkg({}, {});
		const issues = checkTsConfigTypesAgainstDeps(
			{ types: ["node", "vitest", "@cloudflare/workers-types"] },
			tmp,
		);
		expect(issues).toHaveLength(3);
	});

	it("ignores non-string entries silently", () => {
		writePkg({}, {});
		expect(checkTsConfigTypesAgainstDeps({ types: [42, null, ""] }, tmp)).toEqual([]);
	});

	it("returns no findings when package.json is unreadable", () => {
		// no package.json written — readAllDeps() returns {} on miss.
		expect(checkTsConfigTypesAgainstDeps({ types: ["node"] }, tmp)).toHaveLength(1);
	});

	// test-contract: public-api — malformed permission rules are reported consistently across allow, deny, and ask buckets
	it("reports malformed rules from every permission bucket", () => {
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			JSON.stringify({
				permissions: {
					allow: ["not-a-rule"],
					deny: [""],
					ask: ["Bash(unclosed *"],
				},
			}),
		);

		const issues = checkClaudeSettingsPermissions(tmp);
		expect(issues).toHaveLength(3);
		expect(issues.map((issue) => issue.message)).toEqual([
			expect.stringContaining("permissions.allow[0]"),
			expect.stringContaining("permissions.deny[0]"),
			expect.stringContaining("permissions.ask[0]"),
		]);
	});
});

describe("checkProjectSetup", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "psetup-int-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns no issues when there are no TypeScript files", () => {
		expect(checkProjectSetup(tmp)).toEqual([]);
	});

	it("does not descend into hidden or generated source directories", () => {
		for (const dir of [
			".hidden",
			"dist",
			"build",
			"out",
			"coverage",
			"target",
			"vendor",
			"__pycache__",
		]) {
			mkdirSync(join(tmp, dir), { recursive: true });
			writeFileSync(join(tmp, dir, "not-first-party.ts"), "export const x = 1;\n");
		}
		expect(checkProjectSetup(tmp)).toEqual([]);
	});

	it("does not treat a non-TypeScript filename suffix as a project source", () => {
		writeFileSync(join(tmp, "example.ts.bak"), "export const x = 1;\n");
		expect(checkProjectSetup(tmp)).toEqual([]);
	});

	it("integrates the types ↔ deps check end-to-end", () => {
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				strict: true,
				moduleResolution: "bundler",
				types: ["@cloudflare/workers-types"],
			},
		}));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("@cloudflare/workers-types"))).toBe(true);
	});

	it("finds a tsconfig exactly five parent directories away only when the bound allows it", () => {
		const cwd = join(tmp, "a", "b", "c", "d", "e");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(cwd, "index.ts"), "export const x = 1;\n");

		expect(checkProjectSetup(cwd)).toEqual([
			{
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message: "TypeScript files found but no tsconfig.json exists",
				fix: "Run `npx tsc --init` to create a tsconfig.json",
			},
		]);
	});

	it("continues searching past five parents only if the loop makes progress", () => {
		const cwd = join(tmp, "a", "b", "c", "d", "e", "f");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(cwd, "index.ts"), "export const x = 1;\n");

		const issues = checkProjectSetup(cwd);
		expect(issues).toEqual([
			{
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message: "TypeScript files found but no tsconfig.json exists",
				fix: "Run `npx tsc --init` to create a tsconfig.json",
			},
		]);
	});

	// test-contract: public-api — a project-local tsconfig within the documented upward search window is used
	it("uses a tsconfig found within the upward search window", () => {
		const cwd = join(tmp, "a", "b", "c", "d");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(cwd, "index.ts"), "export const x = 1;\n");

		expect(checkProjectSetup(cwd)).toEqual([]);
	});

	it("surfaces malformed .claude/settings.json rules even in non-TS projects", () => {
		// No tsconfig.json, no .ts files — the TS-only checks short-circuit
		// but the Claude settings scan must still run.
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			JSON.stringify({
				permissions: {
					allow: ["Bash(ok *)", 'Bash(SESS_B="demo-$(date *)'],
				},
			}),
		);
		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.check === "permission_rule_syntax")).toBe(true);
		expect(issues.find((i) => i.check === "permission_rule_syntax")?.fix).toMatch(
			/interlinked doctor --fix/,
		);
	});

	it("does NOT recommend @types/node for node: imports that exist only in node_modules", () => {
		// Regression: the node:-protocol probe walked cwd recursively, including
		// node_modules, so a dependency's own `node:` imports made the check
		// fire on projects whose first-party code never touches a node builtin.
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");
		writeFileSync(
			join(tmp, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true } }),
		);
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		mkdirSync(join(tmp, "node_modules", "some-dep"), { recursive: true });
		writeFileSync(
			join(tmp, "node_modules", "some-dep", "index.ts"),
			'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
		);

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("@types/node"))).toBe(false);
	});

	it("still recommends @types/node when first-party source uses node: imports", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(
			join(tmp, "src", "app.ts"),
			'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
		);
		writeFileSync(
			join(tmp, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true } }),
		);
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("@types/node"))).toBe(true);
	});

	it("accepts @types/node from dependencies and reports no setup issue", () => {
		writeFileSync(join(tmp, "src.ts"), 'import { readFileSync } from "node:fs";\n');
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ name: "x", dependencies: { "@types/node": "^20.0.0" } }),
		);

		expect(checkProjectSetup(tmp)).toEqual([]);
	});

	it("accepts @types/node from devDependencies and reports no setup issue", () => {
		writeFileSync(join(tmp, "src.ts"), 'import { readFileSync } from "node:fs";\n');
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ name: "x", devDependencies: { "@types/node": "^20.0.0" } }),
		);

		expect(checkProjectSetup(tmp)).toEqual([]);
	});

	// test-contract: public-api — node protocol imports require a directly declared runtime or development @types/node package
	it("does not treat a peer-only @types/node declaration as a direct install", () => {
		writeFileSync(join(tmp, "src.ts"), 'import { readFileSync } from "node:fs";\n');
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ name: "x", peerDependencies: { "@types/node": "^20.0.0" } }),
		);

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("@types/node is not in devDependencies"))).toBe(true);
	});

	// test-contract: public-api — node protocol imports require a directly declared runtime or development @types/node package
	it("does not treat a peer-only @types/node declaration as a direct install", () => {
		writeFileSync(join(tmp, "src.ts"), 'import { readFileSync } from "node:fs";\n');
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ name: "x", peerDependencies: { "@types/node": "^20.0.0" } }),
		);

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("@types/node is not in devDependencies"))).toBe(true);
	});

	it("recognizes node: imports with more than one separating whitespace character", () => {
		writeFileSync(join(tmp, "src.ts"), 'import { readFileSync } from  "node:fs";\n');
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("node: protocol imports"))).toBe(true);
	});

	it("does not scan JavaScript files for node: imports", () => {
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");
		writeFileSync(join(tmp, "helper.js"), 'import { readFileSync } from "node:fs";\n');
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));

		expect(checkProjectSetup(tmp)).toEqual([]);
	});

	// test-contract: public-api — the node protocol probe recognizes single-quoted static imports in TypeScript
	it("recognizes single-quoted node protocol imports", () => {
		writeFileSync(join(tmp, "index.ts"), "import { readFileSync } from 'node:fs';\n");
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("node: protocol imports"))).toBe(true);
	});

	it("does NOT label a pure-JavaScript project as TypeScript because node_modules ships .ts files", () => {
		// hasTypeScriptFiles must not be fooled by dependency .ts/.d.ts files.
		writeFileSync(join(tmp, "index.js"), "module.exports = 1;\n");
		mkdirSync(join(tmp, "node_modules", "some-dep"), { recursive: true });
		writeFileSync(
			join(tmp, "node_modules", "some-dep", "index.d.ts"),
			"export const x: number;\n",
		);

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => /tsconfig\.json/.test(i.message))).toBe(false);
	});

	it("reports missing tsconfig.json when TypeScript files exist but no tsconfig is found up the tree", () => {
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");

		const issues = checkProjectSetup(tmp);
		expect(issues).toEqual([
			{
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message: "TypeScript files found but no tsconfig.json exists",
				fix: "Run `npx tsc --init` to create a tsconfig.json",
			},
		]);
	});

	it("reports a parse error and stops when tsconfig.json exists but is invalid JSON", () => {
		writeFileSync(join(tmp, "tsconfig.json"), "{ not valid json");
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");

		const issues = checkProjectSetup(tmp);
		expect(issues).toEqual([
			{
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message: "tsconfig.json exists but cannot be parsed (invalid JSON)",
				fix: "Fix the JSON syntax in tsconfig.json",
			},
		]);
	});

	it("defaults compilerOptions to {} when tsconfig.json omits it", () => {
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");

		const issues = checkProjectSetup(tmp);
		// No node: imports, so only the strict-mode issue should fire — proves
		// `compilerOptions` didn't throw when accessed despite being absent.
		expect(issues).toEqual([
			{
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message:
					"TypeScript strict mode is not enabled — agents produce safer code with strict checks",
				fix: 'Add "strict": true to compilerOptions',
			},
		]);
	});

	it("skips unreadable first-party files during the node:-import scan instead of throwing", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		const unreadable = join(tmp, "src", "secret.ts");
		writeFileSync(unreadable, 'import { readFileSync } from "node:fs";\n');
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		chmodSync(unreadable, 0o000);
		try {
			expect(() => checkProjectSetup(tmp)).not.toThrow();
			const issues = checkProjectSetup(tmp);
			expect(issues.some((i) => i.message.includes("@types/node"))).toBe(false);
		} finally {
			chmodSync(unreadable, 0o644);
		}
	});

	it("flags a types[] field that omits \"node\" when node: imports are present", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(
			join(tmp, "src", "app.ts"),
			'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
		);
		writeFileSync(
			join(tmp, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true, types: ["vitest"] } }),
		);
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^1.0.0", "@types/node": "^20.0.0" } }));

		const issues = checkProjectSetup(tmp);
		expect(
			issues.some((i) =>
				i.message.includes('tsconfig.json has a "types" field but "node" is not included'),
			),
		).toBe(true);
	});

	it("does not flag types[] when it already includes \"node\"", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(
			join(tmp, "src", "app.ts"),
			'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
		);
		writeFileSync(
			join(tmp, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true, types: ["node"] } }),
		);
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@types/node": "^20.0.0" } }));

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes('"node" is not included'))).toBe(false);
	});

	// test-contract: boundary — an explicitly empty types list still fails to opt into node globals when node imports are used
	it("flags an empty types list when node imports are present", () => {
		writeFileSync(join(tmp, "src.ts"), 'import { readFileSync } from "node:fs";\n');
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: [] } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@types/node": "^20.0.0" } }));

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes('"node" is not included'))).toBe(true);
	});

	it("flags an incompatible moduleResolution when node: imports are present", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(
			join(tmp, "src", "app.ts"),
			'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
		);
		writeFileSync(
			join(tmp, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true, moduleResolution: "classic" } }),
		);
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@types/node": "^20.0.0" } }));

		const issues = checkProjectSetup(tmp);
		expect(
			issues.some((i) =>
				i.message === 'moduleResolution "classic" may not resolve node: protocol imports',
			),
		).toBe(true);
	});

	it("does not flag moduleResolution values that are compatible (case-insensitively)", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(
			join(tmp, "src", "app.ts"),
			'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
		);
		writeFileSync(
			join(tmp, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true, moduleResolution: "NodeNext" } }),
		);
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@types/node": "^20.0.0" } }));

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("may not resolve"))).toBe(false);
	});

	// test-contract: public-api — documented module resolution names remain accepted regardless of casing
	it.each(["NODE16", "BUNDLER"])("accepts uppercase compatible moduleResolution %s", (moduleResolution) => {
		writeFileSync(join(tmp, "src.ts"), 'import { readFileSync } from "node:fs";\n');
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, moduleResolution } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@types/node": "^20.0.0" } }));

		expect(checkProjectSetup(tmp)).toEqual([]);
	});

	it("reports every node-import setup diagnostic with stable fields", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(
			join(tmp, "src", "app.ts"),
			'import { readFileSync } from  "node:fs";\nexport const read = readFileSync;\n',
		);
		writeFileSync(
			join(tmp, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true, moduleResolution: "classic", types: ["vitest"] } }),
		);
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));

		expect(checkProjectSetup(tmp)).toEqual([
			{
				check: "project_setup",
				file: "package.json",
				line: 0,
				message:
					"Code uses node: protocol imports (node:fs, node:path, etc.) but @types/node is not in devDependencies",
				fix: "Run `npm i --save-dev @types/node`",
			},
			{
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message:
					'tsconfig.json has a "types" field but "node" is not included — node: imports will fail',
				fix: 'Add "node" to the "types" array in compilerOptions',
			},
			{
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message:
					'tsconfig.json includes types: ["vitest"] but neither "vitest" nor "@types/vitest" is in package.json. tsc will fail to resolve these globals.',
				fix: "Run `npm i --save-dev @types/vitest`",
			},
			{
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message: 'moduleResolution "classic" may not resolve node: protocol imports',
				fix: 'Set "moduleResolution": "node16" or "bundler" in compilerOptions',
			},
		]);
	});

	it("accepts each documented node-import moduleResolution value", () => {
		for (const moduleResolution of ["node16", "bundler"]) {
			const caseDir = join(tmp, moduleResolution);
			mkdirSync(caseDir, { recursive: true });
			writeFileSync(join(caseDir, "app.ts"), 'import { readFileSync } from "node:fs";\n');
			writeFileSync(
				join(caseDir, "tsconfig.json"),
				JSON.stringify({ compilerOptions: { strict: true, moduleResolution } }),
			);
			writeFileSync(
				join(caseDir, "package.json"),
				JSON.stringify({ name: "x", devDependencies: { "@types/node": "^20.0.0" } }),
			);
			expect(checkProjectSetup(caseDir)).toEqual([]);
		}
	});

	// test-contract: boundary — packageHasTypesNode's catch treats an
	// unreadable package.json as "not installed" rather than throwing or
	// silently claiming @types/node is present.
	it("still recommends @types/node when package.json is missing entirely (packageHasTypesNode read failure)", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(
			join(tmp, "src", "app.ts"),
			'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
		);
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		// Deliberately no package.json — packageHasTypesNode's readFileSync
		// throws ENOENT, and the catch must fall back to "not installed"
		// rather than crashing or claiming @types/node is present.
		let issues: ReturnType<typeof checkProjectSetup> = [];
		expect(() => {
			issues = checkProjectSetup(tmp);
		}).not.toThrow();
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message:
						"Code uses node: protocol imports (node:fs, node:path, etc.) but @types/node is not in devDependencies",
				}),
			]),
		);
	});

	it("flags strict mode disabled", () => {
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: false } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");

		const issues = checkProjectSetup(tmp);
		expect(issues).toEqual([
			{
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message:
					"TypeScript strict mode is not enabled — agents produce safer code with strict checks",
				fix: 'Add "strict": true to compilerOptions',
			},
		]);
	});

	it("does not flag strict mode when explicitly enabled", () => {
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");

		expect(checkProjectSetup(tmp)).toEqual([]);
	});

	// test-contract: boundary — strict mode is enabled only by the boolean true, not truthy lookalikes
	it("requires strict to be the boolean true", () => {
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: "true" } }));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");

		const issues = checkProjectSetup(tmp);
		expect(issues.some((i) => i.message.includes("strict mode is not enabled"))).toBe(true);
	});

	it("aborts a directory walk that exceeds the scan entry cap without crashing", () => {
		const huge = join(tmp, "huge");
		mkdirSync(huge, { recursive: true });
		for (let i = 0; i < 20_000; i++) {
			closeSync(openSync(join(huge, `f${i}.txt`), "w"));
		}
		writeFileSync(join(huge, "late.ts"), "export const x = 1;\n");
		expect(checkProjectSetup(tmp)).toEqual([]);
	}, 30_000);

	it("skips a hidden directory even when its name does not end in a dot", () => {
		mkdirSync(join(tmp, ".private"), { recursive: true });
		writeFileSync(join(tmp, ".private", "secret.ts"), "export const x = 1;\n");
		expect(checkProjectSetup(tmp)).toEqual([]);
	});

	it("skips an unreadable directory during the project walk instead of throwing", () => {
		const locked = join(tmp, "locked");
		mkdirSync(locked, { recursive: true });
		writeFileSync(join(locked, "hidden.ts"), "export const x = 1;\n");
		chmodSync(locked, 0o000);
		try {
			expect(() => checkProjectSetup(tmp)).not.toThrow();
			expect(checkProjectSetup(tmp)).toEqual([]);
		} finally {
			chmodSync(locked, 0o700);
		}
	});
});

describe("checkClaudeSettingsPermissions", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "psetup-claude-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns no issues when no .claude/ directory exists", () => {
		expect(checkClaudeSettingsPermissions(tmp)).toEqual([]);
	});

	it("returns no issues when settings.json is clean", () => {
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			JSON.stringify({
				permissions: {
					allow: ["Bash(grep *)", "Bash(git *)", "WebFetch(domain:github.com)"],
				},
			}),
		);
		expect(checkClaudeSettingsPermissions(tmp)).toEqual([]);
	});

	it("flags each kind of malformed rule with its reason in the message", () => {
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			JSON.stringify({
				permissions: {
					allow: [
						"Bash(ok *)",
						'Bash(SESS_B="demo-$(date *)', // parens + quotes
						"",                              // empty
						"not-a-rule",                    // prefix
					],
				},
			}),
		);
		const issues = checkClaudeSettingsPermissions(tmp);
		expect(issues).toHaveLength(3);
		const reasons = issues.map((i) => i.message).join(" | ");
		expect(reasons).toMatch(/mismatched parentheses/);
		expect(reasons).toMatch(/empty rule/);
		expect(reasons).toMatch(/missing Tool\(\.\.\.\) prefix/);
	});

	it("scans both settings.json and settings.local.json", () => {
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash(ok *)"] } }),
		);
		writeFileSync(
			join(tmp, ".claude", "settings.local.json"),
			// 2 opens, 1 close — depth = 1, mismatched parens (mirrors the
			// real-world `Bash(MARKER=$(date *)` shape that bit us on main).
			JSON.stringify({ permissions: { allow: ["Bash(SESS=$(date *)"] } }),
		);
		const issues = checkClaudeSettingsPermissions(tmp);
		expect(issues).toHaveLength(1);
		expect(nonNull(issues[0]).file).toMatch(/settings\.local\.json$/);
	});

	it("surfaces a parse error as a single issue instead of crashing", () => {
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(join(tmp, ".claude", "settings.json"), "{ not json");
		const issues = checkClaudeSettingsPermissions(tmp);
		expect(issues).toHaveLength(1);
		expect(nonNull(issues[0]).message).toMatch(/not valid JSON/);
		expect(nonNull(issues[0]).fix).toBe("Fix the JSON syntax (or restore from version control).");
	});

	it("renders the complete malformed-rule payload and a safe correction suggestion", () => {
		mkdirSync(join(tmp, ".claude"));
		const rule = "Bash(echo hello *";
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: [rule] } }),
		);

		const issues = checkClaudeSettingsPermissions(tmp);
		expect(issues).toHaveLength(1);
		expect(nonNull(issues[0]).message).toBe(
			`permissions.allow[0] = ${JSON.stringify(rule)} is malformed (mismatched parentheses). Did you mean ${JSON.stringify(`${rule})`)}? Claude Code's /doctor skips this rule at load time.`,
		);
		expect(nonNull(issues[0]).check).toBe("permission_rule_syntax");
		expect(nonNull(issues[0]).line).toBe(0);
		expect(nonNull(issues[0]).fix).toBe(
			"Run `interlinked doctor --fix` to strip malformed permission rules.",
		);
	});

	it("does not invent a suggestion for an empty malformed rule", () => {
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(
			join(tmp, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: [""] } }),
		);

		const issues = checkClaudeSettingsPermissions(tmp);
		expect(issues).toHaveLength(1);
		expect(nonNull(issues[0]).message).toBe(
			'permissions.allow[0] = "" is malformed (empty rule). Claude Code\'s /doctor skips this rule at load time.',
		);
	});
});
