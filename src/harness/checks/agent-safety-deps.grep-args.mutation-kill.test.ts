// ===========================================
// Mutation-kill companion for src/harness/checks/agent-safety-deps.ts
// ===========================================
// Two survivors in `_isDepReferencedInProject` (the grep options object, and
// its `stdio: "pipe"` field) are unobservable through grep's real pass/fail
// behavior: Node's own execFileSync default for `stdio` already matches
// "pipe", and a 5s timeout doesn't change the outcome of a fast successful
// or failing call. The only way to distinguish these mutants is to inspect
// the LITERAL arguments passed to the subprocess call, so this file mocks
// `node:child_process` (vi.mock is file-scoped — the real-grep-based
// coverage in the sibling *.test.ts files is untouched) instead of spawning
// anything for real, keeping this file fast and sandbox-safe.
//
// Provenance: scratch/fleet-r3/receipts/src_harness_checks_agent-safety-deps.ts.jsonl (fleet W9).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";

const mockExecFileSync = vi.fn<typeof import("node:child_process").execFileSync>();
vi.mock("node:child_process", () => ({
	execFileSync: (...args: Parameters<typeof mockExecFileSync>) => mockExecFileSync(...args),
}));

import { checkPhantomDependencies } from "./agent-safety-deps.js";

describe("_isDepReferencedInProject — grep invocation shape", () => {
	let tmp: string;

	beforeEach(() => {
		vi.clearAllMocks();
		mockExecFileSync.mockReturnValue("");
		tmp = mkdtempSync(join(tmpdir(), "phantom-grep-args-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: boundary — the grep subprocess is invoked with a bounded
	// 5000ms timeout (so a pathological search can't hang the daemon
	// forever) and piped stdio (so grep's own stdout/stderr never leak onto
	// the daemon process's real stdio streams). Asserted via the exact call
	// arguments rather than real grep's pass/fail behavior, which does not
	// observably differ between these options and `{}` for a fast call.
	it("invokes grep with the exact command, exclude flags, and options", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ dependencies: { "grep-args-probe-dep": "1.0.0" } }),
		);

		checkPhantomDependencies(join(tmp, "package.json"));

		expect(mockExecFileSync).toHaveBeenCalledTimes(1);
		const call = nonNull(mockExecFileSync.mock.calls[0]);
		const [cmd, args, options] = call;
		expect(cmd).toBe("grep");
		expect(args).toEqual([
			"-rqI",
			"--exclude-dir=node_modules",
			"--exclude-dir=.git",
			"--exclude-dir=dist",
			"--exclude-dir=build",
			"--exclude-dir=.next",
			"--exclude-dir=coverage",
			"--exclude=package.json",
			"--exclude=package-lock.json",
			"--exclude=yarn.lock",
			"--exclude=pnpm-lock.yaml",
			"--exclude=bun.lockb",
			"grep-args-probe-dep",
			tmp,
		]);
		expect(options).toEqual({ timeout: 5000, stdio: "pipe" });
	});
});
