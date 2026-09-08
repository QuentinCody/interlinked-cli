import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHookScript } from "../hooks-template.js";

interface HookResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

const roots: string[] = [];
const TERMINAL_REASON =
	"[interlinked] hook runtime failed before returning a valid decision";

function terminalStderr(client: "claude" | "codex", event: string, action: string): string {
	return `${TERMINAL_REASON} for ${client}:${event} — ${action}. Run 'interlinked doctor' before retrying.\n`;
}

function faultBeforeDecision(script: string): string {
	const marker = "    const config = {";
	const faulted = script.replace(
		marker,
		'    throw new Error("forced terminal fallback");\n' + marker,
	);
	if (faulted === script) throw new Error("fatal-fallback injection marker drifted");
	return faulted;
}

function faultAfterStagedDecision(script: string): string {
	const marker =
		'                writeProviderResponse("pre_block", { reason: guardDecision.reason || "Blocked by Interlinked guard" });';
	const faulted = script.replace(
		marker,
		marker + '\n                throw new Error("forced after staged decision");',
	);
	if (faulted === script) throw new Error("staged-response injection marker drifted");
	return faulted;
}

function runFaultedHook(
	client: "claude" | "codex",
	event: "PreToolUse" | "PermissionRequest" | "PostToolUse",
	mutate = faultBeforeDecision,
): HookResult {
	const root = mkdtempSync(join(tmpdir(), "il-hook-terminal-"));
	roots.push(root);
	const state = join(root, ".interlinked");
	mkdirSync(state, { recursive: true });
	writeFileSync(
		join(state, "config.local.json"),
		JSON.stringify({ sync_mode: "local", agent_name: "terminal-fallback-test" }),
	);
	const scriptPath = join(root, "hook.mjs");
	writeFileSync(scriptPath, mutate(buildHookScript("terminal-fallback-test")));
	const result = spawnSync(process.execPath, [scriptPath], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			INTERLINKED_CLIENT: client,
			INTERLINKED_HOME: state,
			INTERLINKED_DATA_DIR: state,
		},
		input: JSON.stringify({
			hook_event_name: event,
			session_id: `terminal-${client}-${event}`,
			cwd: root,
			tool_name: "Bash",
			tool_input: { command: "rm -rf /" },
			...(event === "PostToolUse" ? { tool_response: { exit_code: 0 } } : {}),
		}),
		timeout: 10_000,
	});
	if (result.error) throw result.error;
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("generated hook terminal fallback", () => {
	it.each(["claude", "codex"] as const)(
		"P: %s PreToolUse rejects with the exact native deny envelope",
		(client) => {
			const result = runFaultedHook(client, "PreToolUse");
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: TERMINAL_REASON,
				},
			});
			expect(result.stderr).toBe(
				terminalStderr(client, "PreToolUse", "the gate request was denied"),
			);
		},
	);

	it.each(["claude", "codex"] as const)(
		"P: %s PermissionRequest rejects with the exact permission deny envelope",
		(client) => {
			const result = runFaultedHook(client, "PermissionRequest");
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "deny", message: TERMINAL_REASON },
				},
			});
			expect(result.stderr).toBe(
				terminalStderr(client, "PermissionRequest", "the gate request was denied"),
			);
		},
	);

	it.each(["claude", "codex"] as const)(
		"N: %s non-gating failures warn open without claiming a block",
		(client) => {
			const result = runFaultedHook(client, "PostToolUse");
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				terminalStderr(client, "PostToolUse", "this non-gating hook was skipped"),
			);
		},
	);

	it("N: a staged decision is discarded before the terminal response is written", () => {
		const result = runFaultedHook(
			"claude",
			"PreToolUse",
			faultAfterStagedDecision,
		);
		expect(result.status).toBe(0);
		const parsed: unknown = JSON.parse(result.stdout);
		expect(parsed).toHaveProperty("hookSpecificOutput.permissionDecisionReason", TERMINAL_REASON);
		expect(result.stdout).not.toMatch(/recursive|rm -rf|BLOCKED/i);
		expect(result.stdout.match(/hookSpecificOutput/g)).toHaveLength(1);
	});
});
