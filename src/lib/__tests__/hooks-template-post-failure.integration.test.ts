import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHookScript } from "../hooks-template.js";
import { isJsonObject, type JsonObject } from "../json-types.js";

// Claude Code 2.1.325 delivers a failed Bash call ONLY as PostToolUseFailure:
// no tool_response, an `error` text whose first line is `Exit code N`. The
// generated hook must record it as a failure with that exit code, in both the
// activity ledger and the tests ledger.

function readRows(path: string): JsonObject[] {
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.map((line) => {
			const parsed: unknown = JSON.parse(line);
			if (!isJsonObject(parsed)) throw new Error("ledger row must be a JSON object");
			return parsed;
		});
}

describe("generated Claude PostToolUseFailure hook", () => {
	let tempDir = "";
	let interlinkedDir = "";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "interlinked-post-failure-"));
		interlinkedDir = join(tempDir, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		writeFileSync(
			join(interlinkedDir, "config.local.json"),
			JSON.stringify({ sync_mode: "local", agent_name: "failure-observer" }),
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("records outcome error, the exit code and stderr, and a failing tests row", () => {
		const scriptPath = join(tempDir, "hook.mjs");
		writeFileSync(scriptPath, buildHookScript("post-failure-test"));
		const errorText = "Exit code 3\nFAIL src/a.test.ts > adds\nAssertionError: expected 2 to be 3";

		const result = spawnSync(process.execPath, [scriptPath], {
			input: JSON.stringify({
				cwd: tempDir,
				hook_event_name: "PostToolUseFailure",
				session_id: "failure-session",
				tool_name: "Bash",
				tool_input: { command: "npx vitest run src/a.test.ts" },
				tool_use_id: "toolu_failure_1",
				error: errorText,
				is_interrupt: false,
				duration_ms: 1234,
			}),
			encoding: "utf-8",
			cwd: tempDir,
			env: {
				...process.env,
				INTERLINKED_HOME: interlinkedDir,
				INTERLINKED_DATA_DIR: interlinkedDir,
				INTERLINKED_CLIENT: "claude",
				INTERLINKED_NO_SELF_HEAL: "1",
			},
			timeout: 30_000,
		});

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const activity = readRows(join(interlinkedDir, "activity.jsonl"));
		expect(activity).toContainEqual(
			expect.objectContaining({
				hook: "PostToolUseFailure",
				tool_use_id: "toolu_failure_1",
				tool_outcome: "error",
				exit_code: 3,
				stderr: errorText,
				duration_ms: 1234,
			}),
		);
		const tests = readRows(join(interlinkedDir, "tests.jsonl"));
		expect(tests).toEqual([
			expect.objectContaining({
				kind: "vitest",
				outcome: "fail",
				exit_code: 3,
				duration_ms: 1234,
				stderr_tail: errorText,
			}),
		]);
	});
});
