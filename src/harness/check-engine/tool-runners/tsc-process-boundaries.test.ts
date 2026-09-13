import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { tryAcquireProjectCompilerLease } from "../../project-compiler-gate.js";
import { runTsc, runTscAsync } from "./tsc.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const { spawnSync: nativeSpawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tsc-process-boundary-"));
	writeFileSync(join(root, "tsconfig.json"), '{"files":["target.ts"]}');
	writeFileSync(join(root, "target.ts"), "export const answer = 42;");
});
afterEach(() => {
	vi.mocked(spawnSync).mockReset().mockImplementation(nativeSpawnSync);
	rmSync(root, { recursive: true, force: true });
});

function input() {
	return { scope: { projectRoot: root, mode: "file" as const, targetFile: join(root, "target.ts"), filterToFile: true }, timeoutMs: 5_000 };
}

describe("compiler process boundaries", () => {
	it("preserves native spawn failure evidence when filtering diagnostics to a file", () => {
		const failed = nativeSpawnSync(join(root, "missing-compiler"), [], { encoding: "utf-8", timeout: 5_000 });
		expect(failed.error?.message).toContain("ENOENT");
		vi.mocked(spawnSync).mockReturnValue(failed);
		expect(runTsc(input())).toEqual([expect.objectContaining({ ruleId: "tsc-unavailable", message: expect.stringContaining("ENOENT") })]);
	});

	it("preserves an actual child signal as unavailable compiler evidence", () => {
		const killed = nativeSpawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], { encoding: "utf-8", timeout: 5_000 });
		expect(killed.signal).toBe("SIGTERM");
		vi.mocked(spawnSync).mockReturnValue(killed);
		expect(runTsc(input())).toEqual([expect.objectContaining({ ruleId: "tsc-unavailable", message: expect.stringContaining("killed by SIGTERM") })]);
	});

	it("reports an occupied synchronous compiler lease without spawning a second compiler", () => {
		const release = nonNull(tryAcquireProjectCompilerLease(root));
		try {
			expect(runTsc(input())).toEqual([expect.objectContaining({ ruleId: "tsc-unavailable", message: expect.stringContaining("another compiler owns this project") })]);
			expect(spawnSync).not.toHaveBeenCalled();
		} finally { release(); }
	});

	it("preserves asynchronous admission failure when filtering to the edited file", async () => {
		const release = nonNull(tryAcquireProjectCompilerLease(root));
		try {
			expect(await runTscAsync(input())).toEqual([expect.objectContaining({ ruleId: "tsc-unavailable", message: expect.stringContaining("compiler admission timed out") })]);
		} finally { release(); }
	});
});
