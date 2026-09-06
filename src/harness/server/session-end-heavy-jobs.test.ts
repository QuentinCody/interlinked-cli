import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResourcePlan } from "../resource-governor.js";
import type { HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";
import type { SessionEndJobDeps } from "./session-end-batch.js";
import { heavyJobReportPath, runSessionEndHeavyJobs } from "./session-end-heavy-jobs.js";

type SpawnFn = NonNullable<SessionEndJobDeps["spawn"]>;

const plan: ResourcePlan = {
	maxJobs: 4,
	background: true,
	commandPrefix: "taskpolicy -b ",
	defer: false,
	reason: "quiet",
};

function makeCtx(cwd: string, log: (message: string) => void = () => {}): ServerRuntime {
	// SAFETY: the heavy-jobs runner reads only ctx.cwd and ctx.log; a minimal
	// structural stub is sufficient for these tests.
	return { cwd, log } as unknown as ServerRuntime;
}

function endEvent(): HarnessEvent {
	return {
		hook_event: "SessionEnd",
		session_id: "sess-heavy",
		agent_source: "claude",
		tool_input: {},
		cwd: "/repo",
		timestamp: "t",
	};
}

function fakeChild() {
	return { on() {}, unref() {} };
}

let cwd: string;
let calls: Array<{ file: string; args: string[] }>;
let spawn: SpawnFn;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "heavy-jobs-"));
	mkdirSync(join(cwd, "src"), { recursive: true });
	calls = [];
	// SAFETY: the runner only calls spawn(file, args, opts) and reads .on/.unref
	// off the child; this fake matches that surface.
	spawn = ((file: string, args: string[]) => {
		calls.push({ file, args });
		return fakeChild();
	}) as unknown as SpawnFn;
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	delete process.env.INTERLINKED_DISABLE_SESSION_END_JOBS;
});

describe("runSessionEndHeavyJobs", () => {
	it("spawns nothing when there are no fuzz targets and no bench/ dir", () => {
		runSessionEndHeavyJobs(makeCtx(cwd), endEvent(), plan, { spawn });
		expect(calls).toHaveLength(0);
	});

	it("spawns a governed fuzz-smoke run with elevated numRuns when targets exist", () => {
		writeFileSync(join(cwd, "src", "a.test.ts"), `import fc from "fast-check";\nfc.assert(fc.property());\n`);
		runSessionEndHeavyJobs(makeCtx(cwd), endEvent(), plan, { spawn });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.file).toBe("taskpolicy");
		const argv = calls[0]?.args.join(" ") ?? "";
		expect(argv).toContain("npx vitest run");
		expect(argv).toContain("--reporter=json");
		expect(argv).toContain(heavyJobReportPath(cwd, "fuzz", "sess-heavy"));
	});

	it("spawns a bench snapshot when a bench/ dir exists", () => {
		mkdirSync(join(cwd, "bench"), { recursive: true });
		runSessionEndHeavyJobs(makeCtx(cwd), endEvent(), plan, { spawn });
		expect(calls).toHaveLength(1);
		const argv = calls[0]?.args.join(" ") ?? "";
		expect(argv).toContain("vitest bench --run bench/");
	});

	it("does not spawn when the governor defers", () => {
		writeFileSync(join(cwd, "src", "a.test.ts"), `import fc from "fast-check";\n`);
		runSessionEndHeavyJobs(makeCtx(cwd), endEvent(), { ...plan, defer: true }, { spawn });
		expect(calls).toHaveLength(0);
	});

	it("does not spawn when opted out via env", () => {
		process.env.INTERLINKED_DISABLE_SESSION_END_JOBS = "1";
		writeFileSync(join(cwd, "src", "a.test.ts"), `import fc from "fast-check";\n`);
		runSessionEndHeavyJobs(makeCtx(cwd), endEvent(), plan, { spawn });
		expect(calls).toHaveLength(0);
	});

	it("still spawns the job when the report directory cannot be created", () => {
		writeFileSync(join(cwd, "src", "a.test.ts"), `import fc from "fast-check";\n`);
		// `.interlinked` is a FILE here, so mkdirSync of `<cwd>/.interlinked/fuzz-reports`
		// throws — the runner must treat the report dir as best-effort and spawn anyway
		// (vitest creates the file itself via --outputFile).
		writeFileSync(join(cwd, ".interlinked"), "not a directory");
		runSessionEndHeavyJobs(makeCtx(cwd), endEvent(), plan, { spawn });
		expect(calls[0]?.args.join(" ")).toContain(
			`--outputFile=${heavyJobReportPath(cwd, "fuzz", "sess-heavy")}`,
		);
		expect(statSync(join(cwd, ".interlinked")).isDirectory()).toBe(false);
	});

	it("logs a skip line when the spawned child emits an error event", () => {
		writeFileSync(join(cwd, "src", "a.test.ts"), `import fc from "fast-check";\n`);
		const logs: string[] = [];
		const errorHandlers: Array<(e: Error) => void> = [];
		// SAFETY: the runner only calls spawn(file, args, opts) and reads .on/.unref
		// off the child; this fake matches that surface and captures the error handler.
		const capturingSpawn = ((file: string, args: string[]) => {
			calls.push({ file, args });
			return {
				on(event: string, cb: (e: Error) => void) {
					if (event === "error") errorHandlers.push(cb);
				},
				unref() {},
			};
		}) as unknown as SpawnFn;

		runSessionEndHeavyJobs(makeCtx(cwd, (m) => logs.push(m)), endEvent(), plan, {
			spawn: capturingSpawn,
		});
		errorHandlers[0]?.(new Error("spawn npx ENOENT"));

		expect(logs).toContain("[session-end:heavy] fuzz-smoke spawn failed (skipped): spawn npx ENOENT");
	});

	it("never throws when spawn fails", () => {
		writeFileSync(join(cwd, "src", "a.test.ts"), `import fc from "fast-check";\n`);
		// SAFETY: a spawn that throws synchronously, to exercise the never-throw path.
		const boom = (() => {
			throw new Error("ENOENT");
		}) as unknown as SpawnFn;
		expect(() => runSessionEndHeavyJobs(makeCtx(cwd), endEvent(), plan, { spawn: boom })).not.toThrow();
	});
});
