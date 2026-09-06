// Companion tests for src/harness/project-test-gate.ts — the async path.
// The synchronous checkProjectTestsClean() is already exercised (via its
// re-export) by project-typecheck-gate.mutation-kill-w61.test.ts; this file
// covers the two async-only branches that test suite does not reach: the
// env-var skip and the failure-list-mapped result.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runBoundedTestProcessMock = vi.fn();
vi.mock("./quality-checks/test-process-gate.js", () => ({
	runBoundedTestProcess: (...args: unknown[]) => runBoundedTestProcessMock(...args),
}));

import { checkProjectTestsCleanAsync } from "./project-test-gate.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "project-test-gate-"));
	runBoundedTestProcessMock.mockReset();
	delete process.env.INTERLINKED_SKIP_PROJECT_TESTS;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writePkg(scripts: Record<string, string>) {
	writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
}

describe("checkProjectTestsCleanAsync — env-var skip", () => {
	it("returns the skip warning without ever invoking a test process", async () => {
		writePkg({ test: "vitest run" });
		process.env.INTERLINKED_SKIP_PROJECT_TESTS = "1";
		const entries = await checkProjectTestsCleanAsync(dir);
		expect(entries).toEqual([
			{
				source: "structural",
				name: "project_tests_skipped",
				severity: "warning",
				message:
					"Project test gate bypassed via INTERLINKED_SKIP_PROJECT_TESTS=1. Verify CI manually before merging.",
				determinism: "fully_deterministic",
			},
		]);
		expect(runBoundedTestProcessMock).not.toHaveBeenCalled();
	});
});

describe("checkProjectTestsCleanAsync — parsed failure list", () => {
	it("returns one error entry per parsed failure, each message the failure text itself", async () => {
		writePkg({ test: "vitest run" });
		runBoundedTestProcessMock.mockResolvedValue({
			kind: "completed",
			code: 1,
			stdout: "✗ src/foo.test.ts > does the first thing\n✗ src/bar.test.ts > does the second thing\n",
			stderr: "",
		});
		const entries = await checkProjectTestsCleanAsync(dir);
		expect(entries).toEqual([
			{
				source: "structural",
				name: "project_tests_clean",
				severity: "error",
				message: "src/foo.test.ts > does the first thing",
				determinism: "fully_deterministic",
			},
			{
				source: "structural",
				name: "project_tests_clean",
				severity: "error",
				message: "src/bar.test.ts > does the second thing",
				determinism: "fully_deterministic",
			},
		]);
	});
});
