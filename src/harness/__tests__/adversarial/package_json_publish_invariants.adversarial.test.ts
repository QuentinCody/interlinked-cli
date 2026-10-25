// Independent adversarial review of `package_json_publish_invariants`
// (pre_block). Each N-case is a legitimate package.json edit the detector
// once blocked. Probe:
// scratch/2026-10-21-adversarial/package_json_publish_invariants.probe.mts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPackageJsonPublishInvariants } from "../../checks/package-json.js";

const FULL_PKG = {
	name: "my-pkg",
	version: "1.0.0",
	license: "MIT",
	repository: { type: "git", url: "git+https://example.com/foo.git" },
	homepage: "https://example.com",
	bugs: { url: "https://example.com/issues" },
	keywords: ["a"],
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
	scripts: { build: "tsc", prepublishOnly: "npm test" },
};

let tmp: string;
let pkgPath: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pjpi-adv-"));
	writeFileSync(join(tmp, "package-lock.json"), "{}");
	pkgPath = join(tmp, "package.json");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function run(pre: object, post: object, path = pkgPath) {
	writeFileSync(path, JSON.stringify(pre, null, 2));
	return checkPackageJsonPublishInvariants(JSON.stringify(post, null, 2), path);
}

describe("package_json_publish_invariants — negative (must not fire)", () => {
	it("N1: an edit that turns the package private may drop every publish field", () => {
		const post = { name: "my-pkg", version: "1.0.0", private: true, scripts: { build: "tsc" } };
		expect(run(FULL_PKG, post)).toEqual([]);
	});

	it("N2: migrating main/types into exports conditions is not a removal", () => {
		const { main: _main, types: _types, ...rest } = FULL_PKG;
		void _main;
		void _types;
		const post = {
			...rest,
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
		};
		expect(run(FULL_PKG, post)).toEqual([]);
	});

	it("N3: a fixture package.json under __fixtures__ is not a publish target even beside a lockfile", () => {
		const dir = join(tmp, "src", "__fixtures__", "pkg");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package-lock.json"), "{}");
		const post = { name: "fixture", version: "0.0.0" };
		expect(run(FULL_PKG, post, join(dir, "package.json"))).toEqual([]);
	});

	it("N4: a post-edit file with a leading UTF-8 BOM is valid JSON (npm strips it)", () => {
		writeFileSync(pkgPath, JSON.stringify(FULL_PKG, null, 2));
		const post = `\uFEFF${JSON.stringify({ ...FULL_PKG, version: "1.0.1" }, null, 2)}`;
		expect(checkPackageJsonPublishInvariants(post, pkgPath)).toEqual([]);
	});

	it("N5: dropping the redundant default \"type\": \"commonjs\" is a no-op", () => {
		const pre = { ...FULL_PKG, type: "commonjs" };
		const { type: _type, ...post } = pre;
		void _type;
		expect(run(pre, post)).toEqual([]);
	});

	it("N6: dropping the redundant default \"sideEffects\": true is a no-op", () => {
		const pre = { ...FULL_PKG, sideEffects: true };
		const { sideEffects: _se, ...post } = pre;
		void _se;
		expect(run(pre, post)).toEqual([]);
	});

	it("N7: dropping an empty engines object removes no constraint", () => {
		const pre = { ...FULL_PKG, engines: {} };
		const { engines: _engines, ...post } = pre;
		void _engines;
		expect(run(pre, post)).toEqual([]);
	});

	it("N8: moving the prepublishOnly command into prepack still gates publish", () => {
		const post = {
			...FULL_PKG,
			scripts: { build: "tsc", prepack: "npm test" },
		};
		expect(run(FULL_PKG, post)).toEqual([]);
	});
});

describe("package_json_publish_invariants — positive (must fire)", () => {
	it("P1: dropping types while exports declares no types condition still fires", () => {
		const { types: _types, ...post } = FULL_PKG;
		void _types;
		const findings = run(FULL_PKG, post);
		expect(findings.some((f) => f.text.includes("`types`"))).toBe(true);
	});

	it("P2: dropping main without any exports still fires", () => {
		const { main: _main, exports: _exports, ...post } = FULL_PKG;
		void _main;
		void _exports;
		const findings = run(FULL_PKG, post);
		expect(findings.some((f) => f.text.includes("`main`"))).toBe(true);
		expect(findings.some((f) => f.text.includes("`exports`"))).toBe(true);
	});

	it("P3: a non-boolean private marker does not excuse the removal", () => {
		const post = { name: "my-pkg", version: "1.0.0", private: "true" };
		expect(run(FULL_PKG, post).length).toBeGreaterThan(0);
	});

	it("P4: a pnpm workspace package with its own node_modules is still a publish target", () => {
		const dir = join(tmp, "packages", "foo");
		mkdirSync(join(dir, "node_modules"), { recursive: true });
		const post = { name: "my-pkg", version: "1.0.0" };
		expect(run(FULL_PKG, post, join(dir, "package.json")).length).toBeGreaterThan(0);
	});

	it("P5: dropping \"type\": \"module\" (not the default) still fires", () => {
		const { type: _type, ...post } = FULL_PKG;
		void _type;
		expect(run(FULL_PKG, post).some((f) => f.text.includes("`type`"))).toBe(true);
	});

	it("P6: emptying a non-empty engines object to {} still fires", () => {
		const post = { ...FULL_PKG, engines: {} };
		expect(run(FULL_PKG, post).some((f) => f.text.includes("`engines`"))).toBe(true);
	});

	it("P7: dropping prepublishOnly when prepack runs a different command still fires", () => {
		const post = { ...FULL_PKG, scripts: { build: "tsc", prepack: "npm run build" } };
		expect(run(FULL_PKG, post).some((f) => f.text.includes("scripts.prepublishOnly"))).toBe(
			true,
		);
	});
});
