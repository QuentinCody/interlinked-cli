// Config effect arm (red team 2026-10-21): snapshot the BLOCKING config
// water-lines before a call, detect a loosening against that pre-call
// snapshot after it. Fixtures are disposable mkdtemp roots (not git repos, so
// discovery takes the bounded-walk route; one case inits git explicitly).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BASELINE_RESTORE_PREFIX,
	captureConfigWaterLines,
	detectConfigWaterLineLoosening,
	isConfigWaterLineName,
	resetConfigDiscovery,
} from "./config-effect-guard.js";

const STRICT = '{\n  "compilerOptions": { "strict": true }\n}\n';
const LOOSE = '{\n  "compilerOptions": { "strict": false }\n}\n';
const STRICTER = '{\n  "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true }\n}\n';
const VITEST_TIGHT = 'export default { test: { coverage: { include: ["src/**"], exclude: [] } } };\n';
const VITEST_LOOSE = 'export default { test: { coverage: { include: ["src/**"], exclude: ["src/a.ts"] } } };\n';

let root: string;
const read = (abs: string): string | null => {
	try {
		return statSync(abs).size > 2 * 1024 * 1024 ? null : readFileSync(abs, "utf8");
	} catch {
		return null;
	}
};

beforeEach(() => {
	resetConfigDiscovery();
	root = mkdtempSync(join(tmpdir(), "config-effect-"));
	writeFileSync(join(root, "tsconfig.json"), STRICT);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("config effect arm — positive (must fire)", () => {
	it("P1: strict true→false in the root tsconfig is a loosening carrying the pre-call bytes", () => {
		const before = captureConfigWaterLines(root, read);
		writeFileSync(join(root, "tsconfig.json"), LOOSE);
		const found = detectConfigWaterLineLoosening(root, before, read);
		expect(found.map((f) => f.file)).toEqual(["tsconfig.json"]);
		expect(found[0]?.beforeText).toBe(STRICT);
		expect(found[0]?.details.join("\n")).toContain("strict");
	});

	it("P2: loosening an extends TARGET is reported against the changed base file", () => {
		mkdirSync(join(root, "configs"));
		writeFileSync(join(root, "configs", "base.json"), STRICT);
		writeFileSync(join(root, "tsconfig.json"), '{ "extends": "./configs/base.json" }');
		const before = captureConfigWaterLines(root, read);
		expect(Object.keys(before)).toContain(join("configs", "base.json"));
		writeFileSync(join(root, "configs", "base.json"), LOOSE);
		const found = detectConfigWaterLineLoosening(root, before, read);
		expect(found.map((f) => f.file)).toEqual([join("configs", "base.json")]);
		expect(found[0]?.details.join("\n")).toContain("via tsconfig.json");
	});

	it("P3: deleting a strict tsconfig is a loosening", () => {
		const before = captureConfigWaterLines(root, read);
		rmSync(join(root, "tsconfig.json"));
		const found = detectConfigWaterLineLoosening(root, before, read);
		expect(found[0]?.afterText).toBeNull();
	});

	it("snapshots transitive local bases with arbitrary filenames", () => {
		writeFileSync(join(root, "tsconfig.json"), '{ "extends": "./base.json" }');
		writeFileSync(join(root, "base.json"), '{ "extends": "./strict.json" }');
		writeFileSync(join(root, "strict.json"), STRICT);
		const before = captureConfigWaterLines(root, read);
		expect(before["strict.json"]).toBe(STRICT);
		writeFileSync(join(root, "strict.json"), LOOSE);
		const found = detectConfigWaterLineLoosening(root, before, read);
		expect(found.map((f) => f.file)).toEqual(["strict.json"]);
		expect(found[0]?.beforeText).toBe(STRICT);
	});

	it("ends discovery when arbitrary base files form a cycle", () => {
		writeFileSync(join(root, "tsconfig.json"), '{ "extends": "./base.json" }');
		writeFileSync(join(root, "base.json"), '{ "extends": "./other.json" }');
		writeFileSync(join(root, "other.json"), '{ "extends": "./base.json" }');
		expect(Object.keys(captureConfigWaterLines(root, read)).sort()).toEqual(["base.json", "other.json", "tsconfig.json"]);
	});

	it("P4: a vitest coverage.exclude gaining a member is a loosening", () => {
		writeFileSync(join(root, "vitest.config.ts"), VITEST_TIGHT);
		const before = captureConfigWaterLines(root, read);
		writeFileSync(join(root, "vitest.config.ts"), VITEST_LOOSE);
		const found = detectConfigWaterLineLoosening(root, before, read);
		expect(found.map((f) => f.file)).toEqual(["vitest.config.ts"]);
	});

	it.each(["deleted", "empty", "dynamic"])("reports unavailable coverage scope when a config is %s", (kind) => {
		writeFileSync(join(root, "vitest.config.ts"), VITEST_TIGHT);
		const before = captureConfigWaterLines(root, read);
		if (kind === "deleted") rmSync(join(root, "vitest.config.ts"));
		else writeFileSync(join(root, "vitest.config.ts"), kind === "empty" ? "" : "export default { test: { coverage: { include: files } } };\n");
		const warnings: string[] = [];
		expect(detectConfigWaterLineLoosening(root, before, read, warnings)).toEqual([]);
		expect(warnings.join("\n")).toContain("NOT CHECKED");
		expect(warnings.join("\n")).toContain("vitest.config.ts");
	});

	it("P5: a nested package tsconfig is discovered by the bounded walk", () => {
		mkdirSync(join(root, "packages", "api"), { recursive: true });
		writeFileSync(join(root, "packages", "api", "tsconfig.json"), STRICT);
		const before = captureConfigWaterLines(root, read);
		writeFileSync(join(root, "packages", "api", "tsconfig.json"), LOOSE);
		expect(detectConfigWaterLineLoosening(root, before, read).map((f) => f.file)).toEqual([
			join("packages", "api", "tsconfig.json"),
		]);
	});

	it("P6: in a git repository the tracked nested configs are snapshotted", () => {
		mkdirSync(join(root, "pkg"));
		writeFileSync(join(root, "pkg", "tsconfig.build.json"), STRICT);
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["add", "-A"], { cwd: root });
		const before = captureConfigWaterLines(root, read);
		expect(Object.keys(before).sort()).toEqual([join("pkg", "tsconfig.build.json"), "tsconfig.json"].sort());
	});
});

describe("config effect arm — negative (must not fire)", () => {
	it("N1: an unchanged snapshot is silent and parses nothing", () => {
		const before = captureConfigWaterLines(root, read);
		expect(detectConfigWaterLineLoosening(root, before, read)).toEqual([]);
	});

	it("N2: tightening tsconfig is silent", () => {
		const before = captureConfigWaterLines(root, read);
		writeFileSync(join(root, "tsconfig.json"), STRICTER);
		expect(detectConfigWaterLineLoosening(root, before, read)).toEqual([]);
	});

	it("N3: a non-config file and bulk directories are never snapshotted", () => {
		mkdirSync(join(root, "node_modules", "x"), { recursive: true });
		writeFileSync(join(root, "node_modules", "x", "tsconfig.json"), STRICT);
		writeFileSync(join(root, "package.json"), "{}");
		expect(Object.keys(captureConfigWaterLines(root, read))).toEqual(["tsconfig.json"]);
	});

	it("N4: a tsconfig created during the call is no loosening (no pre-call bytes)", () => {
		rmSync(join(root, "tsconfig.json"));
		const before = captureConfigWaterLines(root, read);
		writeFileSync(join(root, "tsconfig.json"), LOOSE);
		expect(detectConfigWaterLineLoosening(root, before, read)).toEqual([]);
	});
});

describe("naming", () => {
	it("recognizes exactly the blocking config basenames", () => {
		expect(isConfigWaterLineName("a/tsconfig.app.json")).toBe(true);
		expect(isConfigWaterLineName("vite.config.mts")).toBe(true);
		expect(isConfigWaterLineName("package.json")).toBe(false);
		expect(BASELINE_RESTORE_PREFIX).toBe("[interlinked:baseline-effect] RESTORED");
	});
});
