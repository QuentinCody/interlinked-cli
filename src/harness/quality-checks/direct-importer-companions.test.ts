import { nonNull } from "../../lib/non-null.js";
// Exercises runDirectImporterCompanions (test-dispatchers.ts's phase 3) in
// isolation from phases 1/2 (vitest --related + the edited file's own
// convention fallback), which have their own coverage in
// src/harness/__tests__/test-dispatchers.integration.test.ts.
//
// Real (not mocked) temporary directories for the fs side — same rationale
// as direct-importers.test.ts and project-graph.test.ts: companion-test
// resolution goes through real `existsSync` calls, so a filesystem mock
// would need to reproduce that logic faithfully. Only `spawnSync` is
// mocked (scoped to this file only — vitest gives every test file its own
// module registry, so this does not share call-count state with the
// integration test file's own `node:child_process` mock).

import type { SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("./test-process-gate.js", async () => {
	const { spawnSync } = await import("node:child_process");
	return {
		runBoundedTestProcess: async (spec: {
			command: string;
			args: string[];
			cwd: string;
			timeoutMs: number;
		}) => {
			const result = spawnSync(spec.command, spec.args, {
				shell: false,
				timeout: spec.timeoutMs,
				cwd: spec.cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			return {
				kind: "completed" as const,
				code: result.status,
				stdout: result.stdout || "",
				stderr: result.stderr || "",
				timedOut: false,
			};
		},
	};
});

import { spawnSync as mockedSpawnSync } from "node:child_process";
import { getProfileForFile } from "../language-profiles.js";
import { capDependentTests, __test_only__ } from "./test-dispatchers.js";

const { runDirectImporterCompanions } = __test_only__;
const spawnSyncMock = vi.mocked(mockedSpawnSync);

let root: string;

function write(rel: string, content: string): string {
	const full = path.join(root, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content, "utf-8");
	return full;
}

function mkResult(opts: { status?: number | null; stdout?: string; stderr?: string }): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, opts.stdout ?? "", opts.stderr ?? ""],
		stdout: opts.stdout ?? "",
		stderr: opts.stderr ?? "",
		status: opts.status === undefined ? 0 : opts.status,
		signal: null,
		// SAFETY: fixture builder for the mocked spawnSync return value — the
		// real SpawnSyncReturns carries pid/stdout/stderr typed as Buffer
		// unions this fixture never needs; only the fields runDirectImporterCompanions
		// actually reads (status, stdout, stderr) are asserted on.
	};
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "direct-importer-companions-"));
	spawnSyncMock.mockReset();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function tsProfile() {
	const profile = getProfileForFile("modes.ts");
	if (!profile) throw new Error("typescript profile missing");
	return profile;
}

describe("runDirectImporterCompanions — positive (must fire)", () => {
	// test-contract: public-api — the forensics scenario this feature exists
	// for: editing modes.ts must select install-hooks.ts's companion test
	// (a DIRECT importer), the exact gap buildTestCandidates alone left open.
	it("P1: modes.ts-style edit runs its direct importer's companion test", async () => {
		const target = write("src/modes.ts", "export const ALL_PRESETS = [];\n");
		write("src/install-hooks.ts", "import { ALL_PRESETS } from './modes.js';\n");
		write("src/install-hooks.test.ts", "it('x', () => {});\n");
		spawnSyncMock.mockReturnValue(
			mkResult({ status: 1, stdout: "FAIL src/install-hooks.test.ts\n  AssertionError: boom" }),
		);

		const out = await runDirectImporterCompanions({
			filePath: "src/modes.ts",
			absPath: target,
			profile: tsProfile(),
			checkCwd: root,
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});

		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("src/modes.ts");
		expect(out[0]?.message).toContain("install-hooks.test.ts");
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const args = nonNull(spawnSyncMock.mock.calls[0]?.[1]);
		expect(args).toContain("src/install-hooks.test.ts");
	});

	it("P2: a clean pass across all companion tests yields no finding", async () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		write("src/user.ts", "import { X } from './modes.js';\n");
		write("src/user.test.ts", "it('x', () => {});\n");
		spawnSyncMock.mockReturnValue(mkResult({ status: 0, stdout: "PASS" }));

		const out = await runDirectImporterCompanions({
			filePath: "src/modes.ts",
			absPath: target,
			profile: tsProfile(),
			checkCwd: root,
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("P3: two direct importers each with a companion test both run in ONE invocation", async () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		write("src/a.ts", "import { X } from './modes.js';\n");
		write("src/a.test.ts", "it('a', () => {});\n");
		write("src/b.ts", "import { X } from './modes.js';\n");
		write("src/b.test.ts", "it('b', () => {});\n");
		spawnSyncMock.mockReturnValue(mkResult({ status: 0 }));

		await runDirectImporterCompanions({
			filePath: "src/modes.ts",
			absPath: target,
			profile: tsProfile(),
			checkCwd: root,
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});

		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		// SAFETY: spawnSync's second positional arg is always the string[]
		// argv this dispatcher builds itself two lines above the call site.
		const args = nonNull(spawnSyncMock.mock.calls[0]?.[1]);
		expect(args).toContain("src/a.test.ts");
		expect(args).toContain("src/b.test.ts");
	});
});

describe("runDirectImporterCompanions — negative (must not fire)", () => {
	// test-contract: boundary — DIRECT means one hop only; a companion test
	// belonging to an importer-of-an-importer must never run here, or this
	// phase silently grows into the unbounded transitive walk the task
	// explicitly scoped this feature to avoid.
	it("N1: a transitive (2-hop) importer's companion test does NOT run", async () => {
		// modes.ts <- install-hooks.ts (direct, no companion) <- uses-install-hooks.ts
		// (2 hops, HAS a companion). Only a direct importer's companion may run.
		const target = write("src/modes.ts", "export const ALL_PRESETS = [];\n");
		write("src/install-hooks.ts", "import { ALL_PRESETS } from './modes.js';\n");
		write("src/uses-install-hooks.ts", "import { install } from './install-hooks.js';\n");
		write("src/uses-install-hooks.test.ts", "it('x', () => {});\n");

		const out = await runDirectImporterCompanions({
			filePath: "src/modes.ts",
			absPath: target,
			profile: tsProfile(),
			checkCwd: root,
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("N2: returns [] when the edited file has no direct importers", async () => {
		const target = write("src/lonely.ts", "export const X = 1;\n");
		const out = await runDirectImporterCompanions({
			filePath: "src/lonely.ts",
			absPath: target,
			profile: tsProfile(),
			checkCwd: root,
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("N3: returns [] when a direct importer exists but has no companion test", async () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		write("src/no-test-user.ts", "import { X } from './modes.js';\n");
		const out = await runDirectImporterCompanions({
			filePath: "src/modes.ts",
			absPath: target,
			profile: tsProfile(),
			checkCwd: root,
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	// test-contract: boundary — the cap must decline the WHOLE set (never a
	// silently truncated subset) and must never invoke the test runner at
	// all once it declines, or "at most 8" becomes "run some unknown N".
	it("N4: over cap (default 8) skips ALL companion tests and does not spawn vitest", async () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		for (let i = 0; i < 9; i++) {
			write(`src/u${i}.ts`, "import { X } from './modes.js';\n");
			write(`src/u${i}.test.ts`, "it('x', () => {});\n");
		}

		const out = await runDirectImporterCompanions({
			filePath: "src/modes.ts",
			absPath: target,
			profile: tsProfile(),
			checkCwd: root,
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});

		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("warning");
		expect(out[0]?.message).toBe("9 dependent test files not run (over cap)");
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("N5: exactly at the cap (8) still runs — cap is inclusive", async () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		for (let i = 0; i < 8; i++) {
			write(`src/u${i}.ts`, "import { X } from './modes.js';\n");
			write(`src/u${i}.test.ts`, "it('x', () => {});\n");
		}
		spawnSyncMock.mockReturnValue(mkResult({ status: 0 }));

		const out = await runDirectImporterCompanions({
			filePath: "src/modes.ts",
			absPath: target,
			profile: tsProfile(),
			checkCwd: root,
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		// SAFETY: same argv shape as the P3 spawnSync call above.
		const args = nonNull(spawnSyncMock.mock.calls[0]?.[1]);
		expect(args.filter((a) => a.endsWith(".test.ts"))).toHaveLength(8);
	});

	it("N6: a custom maxDependentTests overrides the default cap", async () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		for (let i = 0; i < 3; i++) {
			write(`src/u${i}.ts`, "import { X } from './modes.js';\n");
			write(`src/u${i}.test.ts`, "it('x', () => {});\n");
		}

		const out = await runDirectImporterCompanions({
			filePath: "src/modes.ts",
			absPath: target,
			profile: tsProfile(),
			checkCwd: root,
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
			maxDependentTests: 2,
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toBe("3 dependent test files not run (over cap)");
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("N7: a pre-existing (module-resolution) failure is suppressed", async () => {
		const target = write("src/modes.ts", "export const X = 1;\n");
		write("src/user.ts", "import { X } from './modes.js';\n");
		write("src/user.test.ts", "it('x', () => {});\n");
		spawnSyncMock.mockReturnValue(
			mkResult({ status: 1, stdout: "Error: Cannot find module '@/preexisting'" }),
		);

		const out = await runDirectImporterCompanions({
			filePath: "src/modes.ts",
			absPath: target,
			profile: tsProfile(),
			checkCwd: root,
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});
});

describe("capDependentTests — pure boundary behavior", () => {
	it("returns ok with the full (copied) list at exactly the cap", () => {
		const tests = ["a.test.ts", "b.test.ts"];
		const decision = capDependentTests(tests, 2);
		expect(decision).toEqual({ kind: "ok", tests: ["a.test.ts", "b.test.ts"] });
	});

	it("returns over_cap with the true count one over the cap", () => {
		const decision = capDependentTests(["a.test.ts", "b.test.ts", "c.test.ts"], 2);
		expect(decision).toEqual({ kind: "over_cap", count: 3 });
	});
});
