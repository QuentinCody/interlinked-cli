import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

    it("waits for project capacity during recovery, then executes within the shared deadline", async () => {
        const owner = tryAcquireProjectHeavyProcessLease(projectRoot);
        expect(owner).not.toBeNull();
        const timer = setTimeout(() => owner?.(), 40);
        try {
            await expect(runBoundedTestProcess({ command: process.execPath, args: ["-e", "console.log('executed')"],
                cwd: projectRoot, timeoutMs: 2000, waitForCapacity: true })).resolves.toMatchObject({ kind: "completed", stdout: "executed\n" });
        } finally { clearTimeout(timer); owner?.(); }
    });

    it("cancels a waiting recovery without starting a child", async () => {
        const owner = tryAcquireProjectHeavyProcessLease(projectRoot);
        const controller = new AbortController();
        const pending = runBoundedTestProcess({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd: projectRoot,
            timeoutMs: 2000, waitForCapacity: true, signal: controller.signal });
        controller.abort();
        try { expect(await pending).toMatchObject({ kind: "deferred" }); }
        finally { owner?.(); }
    });

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

    // test-contract: invariant — a resource-budget lookup failure that races
    // ahead of any abort must be classified "unavailable", never "interrupted";
    // the ternary at the deferral site reads live signal state at throw time.
    it("classifies a resource-budget lookup failure as unavailable when no abort is in flight", async () => {
        vi.mocked(readResourceMemory).mockImplementationOnce(() => { throw new Error("memory probe failed"); });
        const outcome = await runBoundedTestProcess({
            command: process.execPath, args: ["-e", "process.exit(0)"], cwd: projectRoot, timeoutMs: 2_000,
        });
        expect(outcome).toEqual({ kind: "deferred", reason: "unavailable" });
    });

    // test-contract: invariant — the same failure classifies as "interrupted"
    // once the caller's signal has actually aborted by throw time, covering
    // the other side of the ternary in the outer catch handler.
    it("classifies the same failure as interrupted once the caller's signal has aborted", async () => {
        const controller = new AbortController();
        vi.mocked(readResourceMemory).mockImplementationOnce(() => { controller.abort(); throw new Error("memory probe failed"); });
        const outcome = await runBoundedTestProcess({
            command: process.execPath, args: ["-e", "process.exit(0)"], cwd: projectRoot, timeoutMs: 2_000, signal: controller.signal,
        });
        expect(outcome).toEqual({ kind: "deferred", reason: "interrupted" });
    });

    // test-contract: boundary — the shared deadline is checked again right
    // before spawning; if admission consumed the whole budget the run must
    // defer as a timeout instead of spawning a doomed child process.
    it("returns a timeout deferral when the shared deadline has already expired before spawn", async () => {
        const outcome = await runBoundedTestProcess({
            command: process.execPath, args: ["-e", "process.exit(0)"], cwd: projectRoot, timeoutMs: -1,
        });
        expect(outcome).toEqual({ kind: "deferred", reason: "timeout" });
    });

    // test-contract: invariant — a child that is already running when its
    // owner aborts must classify as interrupted via the post-spawn kill path
    // (child_process's `killed` flag), distinct from the pre-spawn short
    // circuit at `signal.aborted` covered by the synchronous-abort case above.
    it("classifies a mid-run abort of an already-spawned child as interrupted", async () => {
        const controller = new AbortController();
        const marker = join(projectRoot, "spawned.marker");
        const pending = runBoundedTestProcess({
            command: process.execPath,
            args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '1'); setInterval(() => {}, 1000);`],
            cwd: projectRoot, timeoutMs: 5_000, signal: controller.signal,
        });
        const deadline = Date.now() + 4_000;
        while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        expect(existsSync(marker)).toBe(true);
        controller.abort();
        await expect(pending).resolves.toEqual({ kind: "deferred", reason: "interrupted" });
    });

    // test-contract: invariant — a run whose captured stdout or stderr was
    // truncated at the buffer cap must never be certified as a completed
    // measurement, since the truncated tail could hide the actual verdict.
    it("declines a measurement whose stdout was truncated at the capture cap", async () => {
        // `process.stdout.write` is async and `process.exit` can cut off its
        // buffered pipe writes before they land, silently shrinking captured
        // output below the cap. `fs.writeSync(1, ...)` forces each 1MB chunk
        // to actually reach the pipe before the loop continues, guaranteeing
        // some chunks land entirely after the 10MB capture cap.
        const outcome = await runBoundedTestProcess({
            command: process.execPath,
            args: ["-e", "const b=Buffer.alloc(1024*1024,'a');const fs=require('fs');for(let i=0;i<50;i++)fs.writeSync(1,b);process.exit(0)"],
            cwd: projectRoot, timeoutMs: 15_000,
        });
        expect(outcome).toEqual({ kind: "deferred", reason: "unavailable" });
    }, 20_000);

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
