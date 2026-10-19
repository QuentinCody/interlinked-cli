import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEvent, makeSession } from "../__tests__/fixtures/evaluator.js";
import { appendCheckResults } from "../check-results-sink.js";
import { runCommandCheck } from "../quality-checks/tool-command-check.js";
import type { HarnessDecision, HarnessEvent, QualityCheckConfig } from "../types.js";
import { makeServerRules, makeServerRuntime } from "./__tests__/fixtures.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import { externalAndScheduledResults, readTscDeferred, runTscSchedulerBoundary, scheduleTypescript, tscSchedulerStorePath } from "./tsc-scheduler-phase.js";

vi.mock("../quality-checks/tool-command-check.js", () => ({ runCommandCheck: vi.fn(async () => []) }));
vi.mock("../check-results-sink.js", () => ({ appendCheckResults: vi.fn() }));

const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const COMMENT = " const a = 1;\n-// old comment\n+// new comment\n const b = 2;\n";
const IMPORT = ' import { a } from "./a.js";\n+import { b } from "./b.js";\n const x = a;\n';

/** `null` = no scheduler key at all (the default config). */
function fixture(scheduler: QualityCheckConfig["scheduler"] | null = { enabled: true }) {
	const cwd = mkdtempSync(join(tmpdir(), "tsc-scheduler-"));
	roots.push(cwd);
	const typescript = { enabled: true, command: "tsc --noEmit", severity: "error" as const, file_types: [".ts"], ...(scheduler ? { scheduler } : {}) };
	const ctx = makeServerRuntime({ cwd, rules: makeServerRules({ quality_checks: { typescript } }) });
	return { ctx, cwd, session: makeSession() };
}

function patchEvent(cwd: string, file: string, body: string, id = "call_1"): HarnessEvent {
	return makeEvent({ cwd, hook_event: "PostToolUse", agent_source: "codex", tool_name: "apply_patch", tool_use_id: id,
		timestamp: "2026-10-08T12:00:00Z", tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n${body}*** End Patch\n` } });
}

function acc(): PerFileCheckCtx {
	return { postStartMs: 0, allCheckResults: [], checksRan: [], postToolMetrics: [], markPhase: () => undefined, projectWideSweepFired: false, recurrenceCursor: 0 };
}

async function edit(ctx: ReturnType<typeof fixture>["ctx"], event: HarnessEvent, rel: string) {
	const a = acc();
	const decision: HarnessDecision = { decision: "allow" };
	const file = join(ctx.cwd, rel);
	const checks = scheduleTypescript(ctx, event, file, ctx.rules.quality_checks, a);
	const results = await externalAndScheduledResults(ctx, a, file, decision);
	return { checks, results, decision, acc: a };
}

describe("config off — the synchronous path is untouched", () => {
	it("N1: no scheduler key returns the same checks object and records nothing", async () => {
		const { ctx, cwd } = fixture(null);
		const r = await edit(ctx, patchEvent(cwd, "src/a.ts", COMMENT), "src/a.ts");
		expect(r.checks).toBe(ctx.rules.quality_checks);
		expect(r.decision).toEqual({ decision: "allow" });
		expect(r.results).toEqual([]);
		expect(existsSync(join(cwd, ".interlinked", "tsc-scheduler"))).toBe(false);
	});

	it("N2: scheduler.enabled=false behaves the same", async () => {
		const { ctx, cwd } = fixture({ enabled: false });
		const r = await edit(ctx, patchEvent(cwd, "src/a.ts", COMMENT), "src/a.ts");
		expect(r.checks).toBe(ctx.rules.quality_checks);
		expect(r.decision.scheduler).toBeUndefined();
	});

	it("N3: a dry-run event is never scheduled (no ledger write)", async () => {
		const { ctx, cwd } = fixture();
		const r = await edit(ctx, { ...patchEvent(cwd, "src/a.ts", COMMENT), dry_run: true }, "src/a.ts");
		expect(r.checks).toBe(ctx.rules.quality_checks);
		expect(existsSync(join(cwd, ".interlinked", "tsc-scheduler"))).toBe(false);
	});
});

describe("edit-time scheduling — positive (defers)", () => {
	it("P1: a comment-only patch defers tsc, says so, records p, and joins the deferred set", async () => {
		const { ctx, cwd } = fixture();
		const event = patchEvent(cwd, "src/a.ts", COMMENT);
		const r = await edit(ctx, event, "src/a.ts");
		expect(r.checks.typescript).toBeUndefined();
		expect(r.decision.warnings).toEqual([expect.stringMatching(/^\[interlinked:typescript\] deferred by scheduler \(p=0\.02\)/)]);
		expect(r.decision.scheduler).toMatchObject({ deferred: true, trigger: "edit", recall_point: 0.9 });
		expect(r.acc.allCheckResults).toEqual([expect.objectContaining({ name: "external_check_deferred", file: join(cwd, "src/a.ts") })]);
		expect(readTscDeferred(cwd, event).entries.map(e => e.path)).toEqual([join(cwd, "src/a.ts")]);
		expect(runCommandCheck).not.toHaveBeenCalled();
	});
});

describe("edit-time scheduling — negative (runs)", () => {
	it("N1: an import-touching patch is never deferred; tsc runs on the normal path", async () => {
		const { ctx, cwd } = fixture();
		const r = await edit(ctx, patchEvent(cwd, "src/a.ts", IMPORT), "src/a.ts");
		expect(r.checks).toBe(ctx.rules.quality_checks);
		expect(r.decision.scheduler).toMatchObject({ deferred: false, override: "import-touched" });
		expect(r.decision.warnings).toBeUndefined();
	});

	it("N2: a 'run' edit drains every deferred file in ONE tsc run with the edited file", async () => {
		const { ctx, cwd } = fixture();
		const first = patchEvent(cwd, "src/a.ts", COMMENT);
		await edit(ctx, first, "src/a.ts");
		const r = await edit(ctx, patchEvent(cwd, "src/b.ts", IMPORT, "call_2"), "src/b.ts");
		expect(r.checks.typescript).toBeUndefined();
		expect(runCommandCheck).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runCommandCheck).mock.calls[0]?.[0]).toMatchObject({ tscFilterFile: undefined, editedFiles: ["src/a.ts", "src/b.ts"] });
		expect(r.decision.scheduler).toMatchObject({ deferred: false, drained_files: 2 });
		expect(r.acc.checksRan).toEqual(["typescript"]);
		expect(readTscDeferred(cwd, first).entries).toEqual([]);
	});

	it("N3: an unavailable drain keeps the deferred set and surfaces the no-verdict result", async () => {
		const { ctx, cwd } = fixture();
		const first = patchEvent(cwd, "src/a.ts", COMMENT);
		await edit(ctx, first, "src/a.ts");
		vi.mocked(runCommandCheck).mockResolvedValueOnce([{ name: "external_check_deferred", severity: "warning", message: "busy", file: join(cwd, "src/a.ts") }]);
		const r = await edit(ctx, patchEvent(cwd, "src/b.ts", IMPORT, "call_2"), "src/b.ts");
		expect(r.results.map(x => x.name)).toEqual(["external_check_deferred"]);
		expect(r.acc.checksRan).toEqual([]);
		expect(readTscDeferred(cwd, first).entries.map(entry => entry.path)).toEqual([join(cwd, "src/a.ts"), join(cwd, "src/b.ts")]);
	});
});

describe("Stop / SessionEnd drain — mandatory, reported", () => {
	it("P1: Stop runs tsc on the deferred set, reports the drain, records the row, and empties the set", async () => {
		const { ctx, cwd, session } = fixture();
		const event = patchEvent(cwd, "src/a.ts", COMMENT);
		await edit(ctx, event, "src/a.ts");
		const stop = await runTscSchedulerBoundary(ctx, { ...event, hook_event: "Stop" }, session);
		expect(runCommandCheck).toHaveBeenCalledTimes(1);
		expect(stop?.decision).toBe("allow");
		expect(stop?.checks_ran).toEqual(["typescript"]);
		expect(stop?.scheduler).toEqual({ deferred: false, drained_files: 1, trigger: "stop" });
		expect(stop?.warnings).toEqual([expect.stringMatching(/scheduler drain at Stop: tsc checked 1 deferred file\(s\); no findings/)]);
		expect(appendCheckResults).toHaveBeenCalledWith(cwd, expect.objectContaining({ files_modified: [join(cwd, "src/a.ts")] }), stop);
		expect(readTscDeferred(cwd, event).entries).toEqual([]);
		expect(await runTscSchedulerBoundary(ctx, { ...event, hook_event: "Stop" }, session)).toBeNull();
	});

	it("P2: a type error found by the Stop drain blocks Stop with the error", async () => {
		const { ctx, cwd, session } = fixture();
		const event = patchEvent(cwd, "src/a.ts", COMMENT);
		await edit(ctx, event, "src/a.ts");
		vi.mocked(runCommandCheck).mockResolvedValueOnce([{ name: "typescript", severity: "error", file: join(cwd, "src/a.ts"),
			message: "typescript found newly observed issues in src/a.ts", detail: "src/a.ts(3): TS2304: Cannot find name 'x'." }]);
		const stop = await runTscSchedulerBoundary(ctx, { ...event, hook_event: "Stop" }, session);
		expect(stop?.decision).toBe("block");
		expect(stop?.reason).toContain("TS2304");
		expect(readTscDeferred(cwd, event).entries).toHaveLength(1);
		// A subsequent compiler run may classify the same diagnostic as pre-existing.
		vi.mocked(runCommandCheck).mockResolvedValueOnce([{ name: "typescript", severity: "warning", file: join(cwd, "src/a.ts"),
			message: "pre-existing", detail: "src/a.ts(3): TS2304: Cannot find name 'x'." }]);
		const restarted = makeServerRuntime({ cwd, rules: ctx.rules });
		expect((await runTscSchedulerBoundary(restarted, { ...event, hook_event: "Stop" }, makeSession()))?.decision).toBe("block");
		expect((await runTscSchedulerBoundary(restarted, { ...event, hook_event: "Stop" }, makeSession()))?.decision).toBe("allow");
		expect(readTscDeferred(cwd, event).entries).toEqual([]);
	});

	it("P3: an unavailable Stop drain blocks as NOT CHECKED and keeps the set", async () => {
		const { ctx, cwd, session } = fixture();
		const event = patchEvent(cwd, "src/a.ts", COMMENT);
		await edit(ctx, event, "src/a.ts");
		vi.mocked(runCommandCheck).mockResolvedValueOnce(null);
		const stop = await runTscSchedulerBoundary(ctx, { ...event, hook_event: "Stop" }, session);
		expect(stop?.decision).toBe("block");
		expect(stop?.reason).toMatch(/NOT CHECKED: 1 scheduler-deferred file/);
		expect(readTscDeferred(cwd, event).entries).toHaveLength(1);
	});

	it("P4: SessionEnd drains too, and never blocks (context instead)", async () => {
		const { ctx, cwd, session } = fixture();
		const event = patchEvent(cwd, "src/a.ts", COMMENT);
		await edit(ctx, event, "src/a.ts");
		vi.mocked(runCommandCheck).mockResolvedValueOnce(null);
		const end = await runTscSchedulerBoundary(ctx, { ...event, hook_event: "SessionEnd" }, session);
		expect(end?.decision).toBe("allow");
		expect(end?.scheduler?.trigger).toBe("session_end");
		expect(end?.additional_context).toMatch(/NOT CHECKED/);
	});

	it("N1: other events, other sessions and dry runs never drain", async () => {
		const { ctx, cwd, session } = fixture();
		const event = patchEvent(cwd, "src/a.ts", COMMENT);
		await edit(ctx, event, "src/a.ts");
		expect(await runTscSchedulerBoundary(ctx, { ...event, hook_event: "PostToolBatch" }, session)).toBeNull();
		expect(await runTscSchedulerBoundary(ctx, { ...event, hook_event: "Stop", session_id: "other" }, session)).toBeNull();
		expect(await runTscSchedulerBoundary(ctx, { ...event, hook_event: "Stop", dry_run: true }, session)).toBeNull();
		expect(runCommandCheck).not.toHaveBeenCalled();
	});

	it("N2: a corrupt deferred set is reported, never read as empty", async () => {
		const { ctx, cwd, session } = fixture();
		const event = patchEvent(cwd, "src/a.ts", COMMENT);
		await edit(ctx, event, "src/a.ts");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(tscSchedulerStorePath(cwd, event), "{not json");
		const stop = await runTscSchedulerBoundary(ctx, { ...event, hook_event: "Stop" }, session);
		expect(stop?.decision).toBe("block");
		expect(stop?.reason).toMatch(/deferred set is unreadable/);
		const restarted = makeServerRuntime({ cwd, rules: ctx.rules });
		expect((await runTscSchedulerBoundary(restarted, { ...event, hook_event: "Stop" }, makeSession()))?.decision).toBe("block");
		expect(runCommandCheck).not.toHaveBeenCalled();
	});

	it("drains before commit and at the child actor's SubagentStop", async () => {
		const { ctx, cwd, session } = fixture();
		const event = { ...patchEvent(cwd, "src/a.ts", COMMENT), subagent_id: "child" };
		await edit(ctx, event, "src/a.ts");
		const commit = await runTscSchedulerBoundary(ctx, { ...event, hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m fix" } }, session);
		expect(commit?.scheduler?.trigger).toBe("commit");
		await edit(ctx, event, "src/a.ts");
		expect((await runTscSchedulerBoundary(ctx, { ...event, hook_event: "SubagentStop" }, session))?.checks_ran).toEqual(["typescript"]);
	});

	it("does not claim compiler execution for an inapplicable project", async () => {
		const { ctx, cwd, session } = fixture();
		const event = patchEvent(cwd, "src/a.ts", COMMENT);
		await edit(ctx, event, "src/a.ts");
		vi.mocked(runCommandCheck).mockResolvedValueOnce([{ name: "external_check_not_applicable", severity: "warning", message: "No tsconfig", file: join(cwd, "src/a.ts") }]);
		const stop = await runTscSchedulerBoundary(ctx, { ...event, hook_event: "Stop" }, session);
		expect(stop?.checks_ran).toBeUndefined();
		expect(stop?.warnings?.join("\n")).toContain("no compiler execution; not applicable");
	});
});
