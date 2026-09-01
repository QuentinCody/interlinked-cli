import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:path so `dirname` can be redirected to a synthetic directory
// chain for the parent-walk tests, while every other export (join, etc.)
// stays the real implementation. Default behavior (no per-test override)
// delegates straight through to the real `dirname`.
vi.mock("node:path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:path")>();
	return {
		...actual,
		dirname: vi.fn(actual.dirname),
	};
});

// Mock the companion loader so the .env.example lookup can be redirected
// (found-at-a-specific-hop / call-counting tests) while defaulting to the
// real filesystem-backed implementation for every other test.
vi.mock("./env-loader.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./env-loader.js")>();
	return {
		...actual,
		readEnvExampleFromDir: vi.fn(actual.readEnvExampleFromDir),
	};
});

import { checkUndefinedEnvVars } from "./env-vars.js";
import { readEnvExampleFromDir } from "./env-loader.js";

const actualReadEnvExampleFromDir = (
	await vi.importActual<typeof import("./env-loader.js")>("./env-loader.js")
).readEnvExampleFromDir;
const realDirname = (await vi.importActual<typeof import("node:path")>("node:path")).dirname;

let baseDir: string;

beforeEach(() => {
	baseDir = mkdtempSync(join(tmpdir(), "env-vars-w58-"));
	vi.mocked(dirname).mockImplementation(realDirname);
	vi.mocked(readEnvExampleFromDir).mockImplementation(actualReadEnvExampleFromDir);
	vi.mocked(dirname).mockClear();
	vi.mocked(readEnvExampleFromDir).mockClear();
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// Kills 9aa681b0f6e6ca94 — BlockStatement `{ return []; }` -> `{}` in the
// readFileSync catch handler: without the return, `content` stays
// unassigned and the function throws instead of returning [].
describe("read failure — positive (must fire safely, never throw)", () => {
	it("returns [] and does not throw when the file cannot be read", () => {
		const missing = join(baseDir, "does-not-exist.ts");
		let result: unknown;
		expect(() => {
			result = checkUndefinedEnvVars(missing, "does-not-exist.ts");
		}).not.toThrow();
		expect(result).toEqual([]);
	});
});

// Kills 39471a0dd2271283 — StringLiteral "utf-8" -> "": an invalid encoding
// makes readFileSync throw, which the catch swallows into [], so a
// genuine finding would silently disappear.
describe("read encoding — positive (must fire)", () => {
	it("reads the file as utf-8 and reports an undefined var", () => {
		writeFileSync(join(baseDir, ".env.example"), "UNRELATED=1\n", "utf-8");
		const filePath = join(baseDir, "probe.ts");
		writeFileSync(filePath, "const v = process.env.TOTALLY_UNDOCUMENTED_VAR;\n", "utf-8");

		const result = checkUndefinedEnvVars(filePath, "probe.ts");
		expect(result).toHaveLength(1);
		expect(result[0]?.message).toContain("TOTALLY_UNDOCUMENTED_VAR");
	});
});

// Kills 32a5e9114006894d — ConditionalExpression `usedVars.size === 0` ->
// `false` in checkUndefinedEnvVars itself: with zero env-var references the
// function must short-circuit BEFORE ever consulting the env-example
// loader.
describe("empty usedVars — negative (must not fire, must not look up example)", () => {
	it("never calls readEnvExampleFromDir when the file has no process.env refs", () => {
		writeFileSync(join(baseDir, ".env.example"), "SOME_VAR=1\n", "utf-8");
		const filePath = join(baseDir, "no-env-refs.ts");
		writeFileSync(filePath, "const x = 1;\n", "utf-8");

		const result = checkUndefinedEnvVars(filePath, "no-env-refs.ts");
		expect(result).toEqual([]);
		expect(vi.mocked(readEnvExampleFromDir)).not.toHaveBeenCalled();
	});
});

// Kills e15928f2a4fcb4ff (`i < 10` -> `i <= 10`) AND 332813d99a1dbe27
// (`i++` -> `i--`) in findEnvExampleVars: place a "found" .env.example
// exactly at the 11th directory hop (index 10), reachable only if the loop
// runs an 11th iteration (either via the widened bound or the always-true
// decrementing condition).
describe("parent-walk hop bound — negative (must not fire beyond hop 10)", () => {
	it("does not find an .env.example placed at the 11th walked directory", () => {
		const filePath = join(baseDir, "probe.ts");
		writeFileSync(filePath, "const v = process.env.OTHER_VAR;\n", "utf-8");

		const chain: Record<string, string> = {
			[baseDir]: "/hop1",
			"/hop1": "/hop2",
			"/hop2": "/hop3",
			"/hop3": "/hop4",
			"/hop4": "/hop5",
			"/hop5": "/hop6",
			"/hop6": "/hop7",
			"/hop7": "/hop8",
			"/hop8": "/hop9",
			"/hop9": "/hop10",
		};
		vi.mocked(dirname).mockImplementation((p: string) => chain[p] ?? realDirname(p));
		vi.mocked(readEnvExampleFromDir).mockImplementation((dir: string) =>
			dir === "/hop10" ? new Set(["SUPER_CUSTOM_VAR"]) : null,
		);

		const result = checkUndefinedEnvVars(filePath, "probe.ts");
		// Original: hop10 is never checked (max is 10 checks, hops 0..9),
		// findEnvExampleVars returns null, and the whole check reports
		// nothing. Either widening the loop bound or reversing the
		// counter direction would reach hop10, find the example file,
		// and produce a finding for OTHER_VAR instead.
		expect(result).toEqual([]);
	});
});

// Kills a6f405805f1d41f5 — ConditionalExpression `parent === dir` -> `false`
// in findEnvExampleVars: once the walk reaches a self-referencing "root"
// directory, the loop must stop there instead of re-checking it for the
// remainder of the 10-iteration budget.
describe("parent-walk root stop — call count", () => {
	it("stops walking as soon as the parent directory repeats", () => {
		const filePath = join(baseDir, "probe.ts");
		writeFileSync(filePath, "const v = process.env.OTHER_VAR;\n", "utf-8");

		const chain: Record<string, string> = {
			[baseDir]: "/root",
			"/root": "/root", // self-loop: simulated filesystem root
		};
		vi.mocked(dirname).mockImplementation((p: string) => chain[p] ?? realDirname(p));
		vi.mocked(readEnvExampleFromDir).mockImplementation(() => null);

		const result = checkUndefinedEnvVars(filePath, "probe.ts");
		expect(result).toEqual([]);
		// Original: checks baseDir (hop0), then /root (hop1); dirname(/root)
		// === /root triggers the stop, so exactly 2 lookups happen. A
		// disabled stop would keep re-checking /root for the remaining
		// budget (10 lookups total).
		expect(vi.mocked(readEnvExampleFromDir)).toHaveBeenCalledTimes(2);
	});
});

// Kills the fourteen StringLiteral mutants replacing individual entries of
// the `standardVars` allowlist with "": each entry must independently
// suppress its own env var name from being reported.
describe("standardVars allowlist — negative (must not fire)", () => {
	const cases: Array<{ name: string; mutantId: string }> = [
		{ name: "SHELL", mutantId: "7c79b0f3873f2929" },
		{ name: "PATH", mutantId: "232a322e7a452876" },
		{ name: "HOME", mutantId: "1027b6ad27588723" },
		{ name: "USER", mutantId: "26e01a1ebe2d9ad5" },
		{ name: "TERM", mutantId: "6fd5d4f3aff0024a" },
		{ name: "CI", mutantId: "1060c98f2965490f" },
		{ name: "HOST", mutantId: "c7279515b58b706c" },
		{ name: "TZ", mutantId: "aeed7e266cfbf5d1" },
		{ name: "LC_ALL", mutantId: "6e7029bcf804efbe" },
		{ name: "LANG", mutantId: "f30629fbf3ddd1d5" },
		{ name: "HOSTNAME", mutantId: "fef0add046181dbe" },
		{ name: "PWD", mutantId: "66ed48fc6160a93c" },
		{ name: "DEBUG", mutantId: "b7abff4fd4b08d05" },
		{ name: "VERBOSE", mutantId: "15cce9d6ce3021e9" },
	];

	it.each(cases)("$name is recognized as standard ($mutantId)", ({ name }) => {
		writeFileSync(join(baseDir, ".env.example"), "UNRELATED=1\n", "utf-8");
		const filePath = join(baseDir, "probe.ts");
		writeFileSync(filePath, `const v = process.env.${name};\n`, "utf-8");

		const result = checkUndefinedEnvVars(filePath, "probe.ts");
		expect(result).toEqual([]);
	});
});

// Kills 847b74c1d53e4043 — StringLiteral ", " -> "" (the join separator
// for the reported var list).
describe("message formatting — join separator", () => {
	it("joins multiple undefined var names with a comma-space", () => {
		writeFileSync(join(baseDir, ".env.example"), "UNRELATED=1\n", "utf-8");
		const filePath = join(baseDir, "probe.ts");
		writeFileSync(
			filePath,
			"const a = process.env.VAR_ALPHA;\nconst b = process.env.VAR_BETA;\n",
			"utf-8",
		);

		const result = checkUndefinedEnvVars(filePath, "probe.ts");
		expect(result).toHaveLength(1);
		expect(result[0]?.message).toContain("VAR_ALPHA, VAR_BETA");
	});
});

// Kills 85a9ed74ed5fb5b6 — EqualityOperator `undefinedVars.length > 5` ->
// `>= 5`, AND 03c9fd4aa3a59efc — StringLiteral "" -> "Stryker was here!"
// (the ternary's false-branch text): exactly 5 undefined vars must NOT
// trigger the "+N more" suffix.
describe("message formatting — five-var boundary", () => {
	it("does not append a 'more' suffix or stray text at exactly 5 undefined vars", () => {
		writeFileSync(join(baseDir, ".env.example"), "UNRELATED=1\n", "utf-8");
		const filePath = join(baseDir, "probe.ts");
		const vars = ["VAR_ONE", "VAR_TWO", "VAR_THREE", "VAR_FOUR", "VAR_FIVE"];
		writeFileSync(
			filePath,
			vars.map((v) => `const x_${v} = process.env.${v};`).join("\n"),
			"utf-8",
		);

		const result = checkUndefinedEnvVars(filePath, "probe.ts");
		expect(result).toHaveLength(1);
		const msg = result[0]?.message ?? "";
		expect(msg).not.toMatch(/more/);
		expect(msg).not.toContain("Stryker was here!");
		expect(msg).toBe(
			`probe.ts references 5 env var(s) not in .env.example: ${vars.join(", ")}. Add them to .env.example for documentation.`,
		);
	});
});
