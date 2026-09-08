import { makeServerRuntime } from "./__tests__/fixtures.js";
import { buildTestIndex } from "../__tests__/fixtures/trigram.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileContentCache } from "../grep-accelerator.js";
import { createFreshSession } from "../session-state-mutators.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import {
	classifyObservedOutcome,
	pushWarnings,
	trackTestRun,
	trackVerificationOutcome,
	updateTrigramDirtyLayer,
} from "./post-tool-pipeline-tracking.js";
import type { ServerRuntime } from "./runtime-context.js";

/**
 * Wave-33 survivor kills for `post-tool-pipeline-tracking.ts` (manifest-direct
 * inventory; 38 survivors targeted, several private helpers reached only
 * through their exported callers per the module's own comment that "no
 * module-private state — each depends only on its arguments + imports").
 */

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "ptpt-"));
	tempDirs.push(dir);
	return dir;
}

function baseEvent(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-08-22T00:00:00.000Z",
		...over,
	};
}

function bashPost(command: string, over: Partial<HarnessEvent> = {}): HarnessEvent {
	return baseEvent({ tool_name: "Bash", tool_input: { command }, ...over });
}

function freshSession(event: HarnessEvent): SessionTrajectory {
	return createFreshSession(event, "s");
}

function makeCtx(over: NonNullable<Parameters<typeof makeServerRuntime>[0]> = {}): ServerRuntime {
	return makeServerRuntime({
		cwd: "/repo",
		trigramIndex: null,
		fileContentCache: new FileContentCache(),
		log: vi.fn(),
		...over,
	});
}

function writeEvent(relPath: string): HarnessEvent {
	return baseEvent({ tool_name: "Write", tool_input: { file_path: relPath } });
}

describe("pushWarnings — survivor kills", () => {
	// test-contract: invariant — dc785fa15fb1a2a0, `msgs.length === 0` forced
	// false: an empty call must leave decision.warnings untouched, not
	// create an empty array.
	it("dc785fa1: zero messages must leave decision.warnings untouched", () => {
		const decision: HarnessDecision = { decision: "allow" };
		pushWarnings(decision);
		expect(decision.warnings).toBeUndefined();
	});
});

describe("updateTrigramDirtyLayer — survivor kills", () => {
	// test-contract: invariant — ca21cae56ed51dd3, `!ctx.trigramIndex` forced
	// false: a null index must short-circuit with zero log calls, not fall
	// through to the per-path update loop.
	it("ca21cae5: null trigramIndex must skip with no log call", () => {
		const log = vi.fn();
		const ctx = makeCtx({ trigramIndex: null, log });
		updateTrigramDirtyLayer(ctx, writeEvent("missing.ts"));
		expect(log).not.toHaveBeenCalled();
	});

	// test-contract: invariant — ff9579c0f1ff0f4d, optional chaining dropped
	// on `event.tool_input?.file_path`: absent tool_input must not throw
	// resolving dirty-update paths.
	it("ff9579c0: absent tool_input must not throw resolving dirty-update paths", () => {
		const ctx = makeCtx({ trigramIndex: Object.assign(buildTestIndex({}), { updateFile: vi.fn() }) });
		const event = baseEvent({ tool_name: "Write" });
		expect(() => updateTrigramDirtyLayer(ctx, event)).not.toThrow();
	});

	// test-contract: invariant — 1322139e21953695, fallback `""` replaced
	// with a truthy placeholder: a write tool with no file_path must not
	// dirty-update anything.
	it("1322139e: a write tool with no file_path must not dirty-update anything", () => {
		const updateFile = vi.fn();
		const ctx = makeCtx({ trigramIndex: Object.assign(buildTestIndex({}), { updateFile }) });
		const event = baseEvent({ tool_name: "Write", tool_input: {} });
		updateTrigramDirtyLayer(ctx, event);
		expect(updateFile).not.toHaveBeenCalled();
	});

	// test-contract: invariant — 69d4d53dd31e9ed4, `observed.length > 0`
	// forced false: an observed change_set path must be dirty-updated (real
	// content cached) even when the tool isn't a write tool.
	it("69d4d53d: an observed change_set path is dirty-updated on its own", () => {
		const cwd = makeTempCwd();
		writeFileSync(join(cwd, "file.ts"), "export const x = 1;\n");
		const cache = new FileContentCache();
		const ctx = makeCtx({ cwd, trigramIndex: Object.assign(buildTestIndex({}), { updateFile: vi.fn() }), fileContentCache: cache });
		const event = baseEvent({
			tool_name: "Bash",
			change_set: {
				source: "filesystem-observation",
				complete: true,
				before_captured_at: "t0",
				after_captured_at: "t1",
				files: [{ path: "file.ts", kind: "modified", before_sha256: null, after_sha256: null }],
			},
		});
		updateTrigramDirtyLayer(ctx, event);
		expect(cache.get("file.ts")).toBe("export const x = 1;\n");
	});

	// test-contract: invariant — eb1bba8674fef2de, delete-message template
	// literal replaced with ``: a missing edited file must log the delete
	// message AND actually invalidate any stale cache entry for it.
	it("eb1bba86: a missing edited file logs the delete message and invalidates the cache", () => {
		const cwd = makeTempCwd();
		const log = vi.fn();
		const cache = new FileContentCache();
		cache.set("gone.ts", "stale content");
		const ctx = makeCtx({ cwd, trigramIndex: Object.assign(buildTestIndex({}), { updateFile: vi.fn() }), fileContentCache: cache, log });
		updateTrigramDirtyLayer(ctx, writeEvent("gone.ts"));
		expect(log).toHaveBeenCalledWith("Trigram index dirty delete: gone.ts");
		expect(cache.get("gone.ts")).toBeNull();
	});

	// test-contract: invariant — 5c738a5143fdee60, update-message template
	// literal replaced with ``: an existing edited file must log the update
	// message AND actually cache its real content.
	it("5c738a51: an existing edited file logs the update message and caches its content", () => {
		const cwd = makeTempCwd();
		writeFileSync(join(cwd, "present.ts"), "export const x = 1;\n");
		const log = vi.fn();
		const cache = new FileContentCache();
		const ctx = makeCtx({ cwd, trigramIndex: Object.assign(buildTestIndex({}), { updateFile: vi.fn() }), fileContentCache: cache, log });
		updateTrigramDirtyLayer(ctx, writeEvent("present.ts"));
		expect(log).toHaveBeenCalledWith("Trigram index dirty update: present.ts");
		expect(cache.get("present.ts")).toBe("export const x = 1;\n");
	});
});

describe("trackTestRun — survivor kills (observedOutput / isEvidenceStarved)", () => {
	// test-contract: invariant — 056924df9e137314, join separator `"\n"`
	// replaced with ``: stdout+stderr must join WITH a newline so a trailing
	// summary line still parses as a fresh line.
	it("056924df: stdout+stderr are joined with a newline so a trailing summary parses", () => {
		const event = bashPost("npx vitest run src/a.test.ts", {
			stdout: "foo",
			stderr: "Tests  7 passed (7)\n",
		});
		const session = freshSession(event);
		const warning = trackTestRun(event, session, "/repo");
		expect(warning).toBeNull();
		expect(session.test_runs.get("/repo/src/a.test.ts")?.status).toBe("pass");
	});

	// test-contract: invariant — 96cfcd638eb35288, `typeof tool_response ===
	// "string"` forced true: a non-string tool_response must count as no
	// output (starved), not as present.
	it("96cfcd63: a non-string tool_response must count as no output (starved)", () => {
		const event = bashPost("npx vitest run src/a.test.ts", {
			tool_response: 42,
		});
		const session = freshSession(event);
		const warning = trackTestRun(event, session, "/repo");
		expect(warning).toContain("no outcome evidence");
		expect(session.test_runs.size).toBe(0);
	});

	// test-contract: invariant — 0108308ce8c38ac9 / c353b14a373f9e45 /
	// 4a92957afcd61ec8, three collapses of the same typeof guard to
	// always-false: a genuine string tool_response must be read and scored.
	it("0108308c: a string tool_response carrying the runner summary is read", () => {
		const event = bashPost("npx vitest run src/a.test.ts", {
			tool_response: "Tests  7 passed (7)\n",
		});
		const session = freshSession(event);
		const warning = trackTestRun(event, session, "/repo");
		expect(warning).toBeNull();
		expect(session.test_runs.get("/repo/src/a.test.ts")?.status).toBe("pass");
	});

	// test-contract: invariant — 93b07a2fc99a7bb1, `observedOutput(event)
	// === undefined` forced true: output that IS present but unparseable
	// must not be reported as evidence-starved.
	it("93b07a2f: present-but-unparseable output is not reported as starved", () => {
		const event = bashPost("npx vitest run src/a.test.ts", { stdout: "some unrelated output" });
		const session = freshSession(event);
		const warning = trackTestRun(event, session, "/repo");
		expect(warning).toBeNull();
		expect(session.test_runs.size).toBe(0);
	});
});

describe("trackVerificationOutcome — survivor kills (isWholeSuiteTestCommand / regex)", () => {
	// test-contract: invariant — 1933d997090773d6, `target !== null` forced
	// false: a resolved per-file vitest run must NOT be recorded as a
	// whole-suite test-suite check.
	it("1933d997: a per-file vitest run is not recorded as a test-suite check", () => {
		const event = bashPost("npx vitest run src/a.test", { tool_outcome: "success" });
		const session = freshSession(event);
		trackVerificationOutcome(event, session);
		expect(session.observed_checks?.get("test-suite")).toBeUndefined();
	});

	// test-contract: invariant — 762b30248b975617, per-file test-arg regex's
	// `^` start-of-string alternative dropped: a token at the very start of
	// the command must still be recognized as per-file, not whole-suite.
	it("762b3024: a leading (start-of-string) test-file token is still per-file", () => {
		const event = bashPost("a.test.js ava", { tool_outcome: "success" });
		const session = freshSession(event);
		trackVerificationOutcome(event, session);
		expect(session.observed_checks?.get("test-suite")).toBeUndefined();
	});

	// test-contract: invariant — 4d51312f1f49a3fa, per-file test-arg regex's
	// `\s` swapped to `\S`: a runner with NO whitespace/start-anchored
	// per-file token (broken by `=`) must fall back to whole-suite.
	it("4d51312f: an unrecognized per-file token shape falls back to whole-suite", () => {
		const event = bashPost("mocha=a.test.ts", { tool_outcome: "success" });
		const session = freshSession(event);
		trackVerificationOutcome(event, session);
		expect(session.observed_checks?.get("test-suite")?.status).toBe("green");
	});
});

describe("trackVerificationOutcome — survivor kills (guard + detail truncation)", () => {

	// test-contract: invariant — b31d63e2b9643d71, `prev?.green_at !==
	// undefined` forced false: a red-after-green observation must carry the
	// prior green_at forward, not drop it.
	it("b31d63e2: a red-after-green observation preserves the prior green_at", () => {
		const event = bashPost("npx tsc --noEmit", { tool_outcome: "success" });
		const session = freshSession(event);
		trackVerificationOutcome(event, session);
		trackVerificationOutcome(bashPost("npx tsc --noEmit", { tool_outcome: "error" }), session);
		const entry = session.observed_checks?.get("typecheck");
		expect(entry?.status).toBe("red");
		expect(entry?.green_at).toBeDefined();
	});

	// test-contract: invariant — 65f8d04c38777f7f, `cmd.length > 80` forced
	// true: a short command's detail must be stored in full, never
	// truncated.
	it("65f8d04c: a short command's detail is stored untruncated", () => {
		const cmd = "npx tsc --noEmit";
		const event = bashPost(cmd, { tool_outcome: "success" });
		const session = freshSession(event);
		trackVerificationOutcome(event, session);
		expect(session.observed_checks?.get("typecheck")?.detail).toBe(cmd);
	});

	// test-contract: invariant — 8e0208526682e471, `cmd.length > 80` forced
	// false: a long command's detail must be truncated, never stored in
	// full.
	it("8e020852: a long command's detail is truncated", () => {
		const cmd = `npx tsc --noEmit --project ${"x".repeat(70)}`;
		const event = bashPost(cmd, { tool_outcome: "success" });
		const session = freshSession(event);
		trackVerificationOutcome(event, session);
		const detail = session.observed_checks?.get("typecheck")?.detail;
		expect(detail).toBe(`${cmd.slice(0, 77)}...`);
		expect(detail?.length).toBeLessThan(cmd.length);
	});

	// test-contract: invariant — 03c4be443a9b45e8 / 7028d61c55c9c6aa, `>`
	// flipped to `>=` / `<=`: at the exact 80-char boundary only strict `>`
	// leaves the detail untruncated.
	it("03c4be44: an exactly-80-char command's detail stays untruncated", () => {
		const cmd = "npx tsc --noEmit ".padEnd(80, "x");
		expect(cmd.length).toBe(80);
		const event = bashPost(cmd, { tool_outcome: "success" });
		const session = freshSession(event);
		trackVerificationOutcome(event, session);
		expect(session.observed_checks?.get("typecheck")?.detail).toBe(cmd);
	});
});

describe("classifyObservedOutcome — survivor kills", () => {
	// test-contract: invariant — d5e3de6bb4f203c0 / 6f8596f845c0a24d, the
	// "interrupted" check forced false / its literal blanked: an interrupted
	// run is "neither" even with a nonzero exit_code present.
	it("d5e3de6b: an interrupted run is neither, even with a nonzero exit_code", () => {
		const event = baseEvent({ tool_outcome: "interrupted", exit_code: 1 });
		expect(classifyObservedOutcome(event)).toBe("neither");
	});

	// test-contract: invariant — 12b9972befc736eb / de9052a6897c380a, the
	// error_message body-scan forced false via its condition or its
	// `"string"` literal: a bare error_message must body-scan to red.
	it("12b9972b: a bare error_message body-scans to red", () => {
		const event = baseEvent({ error_message: "boom" });
		expect(classifyObservedOutcome(event)).toBe("red");
	});
});
