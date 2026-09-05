// ===========================================
// tool-check-loop.ts — dependency_audit no-verdict edges
// ===========================================
// Two branches `runDependencyAudit`/`classifyAuditProcessOutcome` reach only
// through the dependency_audit named handler: an audit command that resolves
// with no usable command token, and a subprocess that was signal-killed
// (rather than timing out or simply failing to start). `runToolCheckLoop` is
// the module's only export exercised here — only the two collaborators the
// dependency_audit branch calls (`resolveDependencyAuditCommandAsync`,
// `runProcessAsync`, and the cross-process heavy-work lease) are mocked;
// `deferredExternalCheck`'s real formatting is what the assertions check.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent, QualityCheckConfig } from "../types.js";
import { runToolCheckLoop, type ToolCheckLoopContext } from "./tool-check-loop.js";

vi.mock("../check-engine/spawn-async.js", () => ({
	runProcessAsync: vi.fn(),
}));

vi.mock("../project-heavy-process-lock.js", () => ({
	tryAcquireProjectHeavyProcessLease: vi.fn(),
}));

vi.mock("./dependency-audit.js", () => ({
	resolveDependencyAuditCommandAsync: vi.fn(),
}));

import { runProcessAsync } from "../check-engine/spawn-async.js";
import { tryAcquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { resolveDependencyAuditCommandAsync } from "./dependency-audit.js";

const mockRunProcessAsync = vi.mocked(runProcessAsync);
const mockTryHeavyProcess = vi.mocked(tryAcquireProjectHeavyProcessLease);
const mockReleaseHeavyProcess = vi.fn();
const mockResolveDependencyAuditCommand = vi.mocked(resolveDependencyAuditCommandAsync);
let sandboxRoot: string;

function cfg(over: Partial<QualityCheckConfig> = {}): QualityCheckConfig {
	return {
		enabled: true,
		file_types: [".json"],
		timeout_ms: 1000,
		severity: "warning",
		...over,
	};
}

const baseEvent: HarnessEvent = {
	hook_event: "PostToolUse",
	session_id: "s1",
	agent_source: "claude",
	tool_name: "Write",
	timestamp: "2026-06-01T00:00:00Z",
};

/** A real temporary project keeps project-root discovery and evidence writes isolated. */
function auditCtx(over: Partial<ToolCheckLoopContext> = {}): ToolCheckLoopContext {
	return {
		event: { ...baseEvent, tool_input: { file_path: "package.json", content: "{}" } },
		checks: { dependency_audit: cfg() },
		cwd: sandboxRoot,
		filePath: "package.json",
		absForTestCheck: join(sandboxRoot, "package.json"),
		testCheckBaseName: "package",
		getSharedContent: () => "{}",
		getAfterRefs: () => [],
		tscFilterFile: undefined,
		baseline: undefined,
		outToolMetrics: undefined,
		editedFileInRepo: undefined,
		onCheckBoundary: undefined,
		...over,
	};
}

function processResult(over: Partial<Awaited<ReturnType<typeof runProcessAsync>>> = {}) {
	return {
		stdout: "",
		stderr: "",
		code: 0,
		timedOut: false,
		killed: false,
		...over,
	};
}

beforeEach(() => {
	sandboxRoot = mkdtempSync(join(tmpdir(), "tool-check-capture-"));
	writeFileSync(join(sandboxRoot, "package.json"), "{}");
	mockReleaseHeavyProcess.mockReset();
	mockTryHeavyProcess.mockReset().mockReturnValue(mockReleaseHeavyProcess);
	mockResolveDependencyAuditCommand.mockReset();
	mockRunProcessAsync.mockReset().mockResolvedValue(processResult());
});
afterEach(() => rmSync(sandboxRoot, { recursive: true, force: true }));

describe("runToolCheckLoop — dependency_audit no-verdict edges", () => {
	it("records disabled checks separately from completed checks", async () => {
		await runToolCheckLoop(auditCtx({ checks: { dependency_audit: cfg({ enabled: false }) } }));
		const record = JSON.parse(readFileSync(join(sandboxRoot, ".interlinked", "check-executions.jsonl"), "utf8"));
		expect(record.execution).toEqual([{ id: "dependency_audit", status: "disabled", elapsed_ms: 0, finding_count: 0 }]);
	});
	it("defers with 'audit command was unavailable' when the resolver names no command token", async () => {
		// Resolution succeeded (a parser was picked) but produced an empty
		// argv, so there is nothing to hand to the subprocess runner. If this
		// guard were inverted (running whatever `cmd[0]` is instead of
		// deferring), the subprocess mock below would be invoked with
		// `undefined` as the command and the message would read the
		// unrelated "runner was unavailable" text instead.
		mockResolveDependencyAuditCommand.mockResolvedValue({ cmd: [], parser: "npm-audit" });
		const out = await runToolCheckLoop(auditCtx());
		expect(out[0]?.detail).toBe("No check verdict was produced: audit command was unavailable");
		expect(mockRunProcessAsync).not.toHaveBeenCalled();
	});

	it("defers with 'dependency audit was interrupted' when the subprocess was signal-killed", async () => {
		// `killed: true` with no timeout is the interrupted case, distinct
		// from a timeout (`timedOut: true`) and from a runner that never
		// started (`code === null` with `killed: false`) — each produces a
		// different deferral message from the same function.
		mockResolveDependencyAuditCommand.mockResolvedValue({
			cmd: ["npm", "audit", "--json"],
			parser: "npm-audit",
		});
		mockRunProcessAsync.mockResolvedValue(
			processResult({ killed: true, code: null, timedOut: false }),
		);
		const out = await runToolCheckLoop(auditCtx());
		expect(out[0]?.detail).toBe(
			"No check verdict was produced: dependency audit was interrupted",
		);
	});
});
