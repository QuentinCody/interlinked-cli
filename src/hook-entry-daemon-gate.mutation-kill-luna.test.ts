import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnCalls: Array<{ command: string; args: string[]; options: unknown; unrefCalls: number }> = [];

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, args: string[], options: unknown) => {
			const call = { command, args, options, unrefCalls: 0 };
			spawnCalls.push(call);
			return Object.assign(new actual.ChildProcess(), { pid: process.pid, unref: () => { call.unrefCalls++; } });
		},
	};
});

import {
	attemptDaemonSelfHeal,
	coldDaemonUnreachableBlockReason,
	isHarnessRecoveryCommand,
} from "./hook-entry-daemon-gate.js";
import { DEFAULT_DAEMON_HEAP_MB } from "./harness/memory-ceiling.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";

function event(cwd: string): UnifiedHookEvent {
	return {
		schema_version: "1",
		event_id: "luna",
		session_id: "s1",
		ts: "2026-08-20T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: "pre-tool",
		action: { kind: "shell_command", command: "echo hi", cwd, tool_class: "read" },
		context: { cwd },
		raw: null,
	};
}

function shell(command: string): UnifiedHookEvent["action"] {
	return { kind: "shell_command", command, tool_class: "modify" };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "he-daemon-gate-luna-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	spawnCalls.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("daemon-gate mutation survivor hardening", () => {
	// test-contract: security — only the exact documented value "1" disables
	// self-heal; nearby values must continue to attempt recovery.
	it("uses self-heal for values other than exactly INTERLINKED_NO_SELF_HEAL=1", () => {
		for (const value of ["0", "", "true", "01"]) {
			const valueDir = join(dir, value || "empty");
			mkdirSync(join(valueDir, ".interlinked"), { recursive: true });
			const result = attemptDaemonSelfHeal(valueDir, { INTERLINKED_NO_SELF_HEAL: value }, {
				resolveServerPath: () => "/fake/server.js",
				now: () => 1_700_000_000_000 + value.length,
				spawnDaemon: () => process.pid,
			});
			expect(result).toBe("spawned");
		}
		expect(attemptDaemonSelfHeal(dir, { INTERLINKED_NO_SELF_HEAL: "1" })).toBe("skipped");
	});

	// test-contract: invariant — the gate bypasses only the exact recovery
	// command, while an ordinary command remains blocked for a stale daemon.
	it("allows recovery but blocks an ordinary command", () => {
		writeFileSync(join(dir, ".interlinked", "harness.pid"), "2147480000\n");
		expect(coldDaemonUnreachableBlockReason(event(dir), dir, {})).toContain("BLOCKED");
		const recovery = event(dir);
		recovery.action = shell("interlinked harness restart --verbose");
		expect(coldDaemonUnreachableBlockReason(recovery, dir, {})).toBeNull();
	});

	// test-contract: boundary — malformed, zero, and negative PID contents are
	// not daemon evidence and must retain the configured-repo diagnosis.
	it("rejects invalid and non-positive PID contents", () => {
		for (const content of ["garbage\n", "0\n", "-4\n"]) {
			writeFileSync(join(dir, ".interlinked", "harness.pid"), content);
			writeFileSync(join(dir, ".interlinked", "config.json"), "{}");
			const reason = coldDaemonUnreachableBlockReason(event(dir), dir, {});
			expect(reason).toContain("configured here, but no live daemon");
			expect(reason).not.toContain("harness pid present");
		}
	});

	// test-contract: invariant — a live session PID wins over an earlier stale
	// raw PID, preserving the alive-and-socket-present continuity path.
	it("prefers a live session PID over a stale raw PID", () => {
		writeFileSync(join(dir, ".interlinked", "harness.pid"), "2147480000\n");
		writeFileSync(join(dir, ".interlinked", "harness-session.pid"), `${process.pid}\n`);
		writeFileSync(join(dir, ".interlinked", "harness-session.sock"), "");
		expect(coldDaemonUnreachableBlockReason(event(dir), dir, {})).toBeNull();
	});

	// test-contract: boundary — daemon artifact regexes are anchored at both
	// ends, so prefixed and suffixed lookalikes cannot alter the gate decision.
	it("ignores prefixed and suffixed daemon artifact names", () => {
		writeFileSync(join(dir, ".interlinked", "config.json"), "{}");
		writeFileSync(join(dir, ".interlinked", "x-harness-live.pid"), `${process.pid}\n`);
		writeFileSync(join(dir, ".interlinked", "harness-live.pid.bak"), `${process.pid}\n`);
		writeFileSync(join(dir, ".interlinked", "x-harness-live.sock"), "");
		writeFileSync(join(dir, ".interlinked", "harness-live.sock.bak"), "");
		expect(coldDaemonUnreachableBlockReason(event(dir), dir, {})).toContain("BLOCKED");
	});

	// test-contract: invariant — an omitted explicit cwd falls back to the
	// event context cwd, rather than evaluating an unrelated process cwd.
	it("uses event.context.cwd when explicit cwd is undefined", () => {
		const root = mkdtempSync(join(tmpdir(), "he-context-root-"));
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(join(root, ".interlinked", "config.json"), "{}");
		expect(coldDaemonUnreachableBlockReason(event(root), undefined, {})).toContain("BLOCKED");
		rmSync(root, { recursive: true, force: true });
	});

	// test-contract: security — shell chaining is rejected even when the
	// metacharacter appears after an otherwise valid recovery invocation.
	it("rejects a newline chained onto a recovery command", () => {
		expect(isHarnessRecoveryCommand(shell("interlinked harness start\necho unsafe"))).toBe(false);
	});

	// test-contract: invariant — detached recovery uses the complete argv and
	// explicitly unrefs the child so the hook process can exit immediately.
	it("spawns the detached daemon with exact argv and one unref", () => {
		const result = attemptDaemonSelfHeal(dir, {}, {
			resolveServerPath: () => "/fake/harness/server.js",
			now: () => 1_700_000_000_000,
		});
		expect(result).toBe("spawned");
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]).toEqual({
			command: process.execPath,
			args: [
				`--max-old-space-size=${DEFAULT_DAEMON_HEAP_MB}`,
				"--expose-gc",
				"/fake/harness/server.js",
				"--cwd",
				dir,
				"--protocol",
				"dual",
				"--session-id",
				"default",
			],
			options: { detached: true, stdio: "ignore" },
			unrefCalls: 1,
		});
	});
});
