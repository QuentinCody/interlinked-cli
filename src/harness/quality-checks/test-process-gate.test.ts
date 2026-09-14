import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tryAcquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { tryAcquireForegroundCapacity } from "../test-capacity.js";
import { readResourceMemory } from "../resource-memory.js";
import { runBoundedTestProcess } from "./test-process-gate.js";

vi.mock("../resource-memory.js", () => ({ readResourceMemory: vi.fn() }));
beforeEach(() => vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 }));

describe("runBoundedTestProcess", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "interlinked-test-process-gate-"));
	afterAll(() => rmSync(projectRoot, { recursive: true, force: true }));

    it("defers another project's tests while a foreground check owns the host lane", async () => {
        const owner = tryAcquireForegroundCapacity();
        expect(owner).not.toBeNull();
        try {
            await expect(runBoundedTestProcess({ command: process.execPath, args: ["-e", "process.exit(0)"],
                cwd: join(projectRoot, "another-project"), timeoutMs: 2000, admissionAlreadyHeld: true,
            })).resolves.toEqual({ kind: "deferred", reason: "busy" });
        } finally { owner?.release(); }
    });

    it("defers missing memory capacity and releases admission for a later retry", async () => {
        const spec = { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: projectRoot, timeoutMs: 2000 };
        vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 8 * 1024 ** 3, availableBytes: 0 });
        await expect(runBoundedTestProcess(spec)).resolves.toEqual({ kind: "deferred", reason: "unavailable" });
        vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 });
        await expect(runBoundedTestProcess(spec)).resolves.toMatchObject({ kind: "completed", code: 0 });
    });

    it("passes bounded worker and heap settings to the actual runner", async () => {
        const result = await runBoundedTestProcess({ command: process.execPath,
            args: ["-e", "console.log(JSON.stringify([process.env.VITEST_MAX_WORKERS, process.env.NODE_OPTIONS]))"],
            cwd: projectRoot, timeoutMs: 2000,
        });
        expect(result).toMatchObject({ kind: "completed", code: 0, stdout: '["1","--max-old-space-size=768"]\n' });
    });

	it("keeps the event loop live and declines a burst instead of queueing it", async () => {
		let timerFired = false;
		const first = runBoundedTestProcess({
			command: process.execPath,
			args: ["-e", "setTimeout(() => process.exit(0), 80)"],
			cwd: projectRoot,
			timeoutMs: 2_000,
		});
		setTimeout(() => {
			timerFired = true;
		}, 10);

		const burst = await Promise.all(
			Array.from({ length: 24 }, () =>
				runBoundedTestProcess({
					command: process.execPath,
					args: ["-e", "process.exit(0)"],
					cwd: projectRoot,
					timeoutMs: 2_000,
				}),
			),
		);
		expect(burst).toHaveLength(24);
		expect(burst.every((outcome) => outcome.kind === "deferred" && outcome.reason === "busy")).toBe(
			true,
		);

		const completed = await first;
		expect(completed).toMatchObject({ kind: "completed", code: 0 });
		expect(timerFired).toBe(true);
	});

	it("returns an explicit deferral when the child times out", async () => {
		const outcome = await runBoundedTestProcess({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			cwd: projectRoot,
			timeoutMs: 50,
		});
		expect(outcome).toEqual({ kind: "deferred", reason: "timeout" });
	});

	it("returns unavailable when the child cannot be spawned", async () => {
		const outcome = await runBoundedTestProcess({
			command: "/definitely/not/an/interlinked-test-runner",
			args: [],
			cwd: projectRoot,
			timeoutMs: 2_000,
		});
		expect(outcome).toEqual({ kind: "deferred", reason: "unavailable" });
	});

	it("returns unavailable when invalid launch arguments throw before spawn", async () => {
		const outcome = await runBoundedTestProcess({
			command: "",
			args: [],
			cwd: projectRoot,
			timeoutMs: 2_000,
		});
		expect(outcome).toEqual({ kind: "deferred", reason: "unavailable" });
	});

	it("returns interrupted when the owning request aborts the child", async () => {
		const controller = new AbortController();
		const pending = runBoundedTestProcess({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			cwd: projectRoot,
			timeoutMs: 2_000,
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).resolves.toEqual({ kind: "deferred", reason: "interrupted" });
	});

	it("treats a wrapper-encoded signal exit as interrupted, never as a red suite", async () => {
		const outcome = await runBoundedTestProcess({
			command: process.execPath,
			args: ["-e", "process.exit(143)"],
			cwd: projectRoot,
			timeoutMs: 2_000,
		});
		expect(outcome).toEqual({ kind: "deferred", reason: "interrupted" });
	});

	it("releases the admission slot after a completed process", async () => {
		const outcome = await runBoundedTestProcess({
			command: process.execPath,
			args: ["-e", "process.exit(0)"],
			cwd: projectRoot,
			timeoutMs: 2_000,
		});
		expect(outcome).toMatchObject({ kind: "completed", code: 0 });
	});

	it("lets a lexical outer owner compose compiler + test work without self-deferral", async () => {
		const release = tryAcquireProjectHeavyProcessLease(projectRoot);
		expect(release).not.toBeNull();
		try {
			await expect(
				runBoundedTestProcess({
					command: process.execPath,
					args: ["-e", "process.exit(0)"],
					cwd: projectRoot,
					timeoutMs: 2_000,
				}),
			).resolves.toEqual({ kind: "deferred", reason: "busy" });

			await expect(
				runBoundedTestProcess({
					command: process.execPath,
					args: ["-e", "process.exit(0)"],
					cwd: projectRoot,
					timeoutMs: 2_000,
					admissionAlreadyHeld: true,
				}),
			).resolves.toMatchObject({ kind: "completed", code: 0 });
		} finally {
			release?.();
		}
	});
});
