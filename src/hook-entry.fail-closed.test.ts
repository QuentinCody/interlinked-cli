// End-to-end cold-recovery behavior through runHookEntry. Daemon absence is a
// degraded mode, not a repository-wide mutex: benign work continues while the
// deterministic inline gates still refuse dangerous operations.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHookEntry } from "./hook-entry.js";

describe("runHookEntry recovers without deadlocking when the daemon crashed", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "he-e2e-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		// Dead PID + no socket file = a crashed daemon → recovery is attempted.
		writeFileSync(join(dir, ".interlinked", "harness.pid"), "2147480000\n");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("allows benign work and accurately reports that no server artifact was available", async () => {
		const res = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "s1",
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				cwd: dir,
			},
			env: {},
			runner: "claude-code",
			cwd: dir,
		});
		expect(res.exit_code).toBe(0);
		expect(res.stdout).toBeUndefined();
		expect(res.stderr).toContain("evaluator skipped");
		expect(res.stderr).toContain("no launch attempted");
		expect(res.stderr).toContain("daemon server artifact missing");
		expect(res.stderr).not.toContain("bringing it back");
	});

	it("still blocks a deterministic destructive operation inline", async () => {
		const res = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "s1",
				tool_name: "Bash",
				tool_input: { command: "rm -rf /" },
				cwd: dir,
			},
			env: {},
			runner: "claude-code",
			cwd: dir,
		});
		expect(res.stdout).toContain('"permissionDecision":"deny"');
		expect(res.stderr).toContain("destructive-command fail-closed gate engaged");
	});

	it("treats a non-object native payload as NOT dry-run rather than throwing", async () => {
		// The "windsurf" additional-client adapter copies the raw runner payload
		// onto `event.raw` unmodified (normalizeNativeHookEvent's isJsonObject
		// guard only shapes the parsed clone it derives fields from). A
		// malformed/non-object payload exercises isDryRunEvent's defensive
		// `typeof raw !== "object"` branch on the cold-fallback path, where it
		// must degrade to "not a dry run" instead of throwing. An explicit
		// unreachable socketPath forces the cold path deterministically,
		// independent of this project's own daemon (which would otherwise
		// answer via cwd-based socket discovery here).
		const res = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: "not-an-object-payload",
			env: {},
			runner: "windsurf",
			cwd: dir,
			socketPath: join(dir, ".interlinked", "does-not-exist.sock"),
		});
		expect(res.exit_code).toBe(0);
		expect(res.stderr).toContain("evaluator skipped");
	});

	it("allows the same call once the escape hatch is set", async () => {
		const res = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "s1",
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				cwd: dir,
			},
			env: { INTERLINKED_ALLOW_NO_DAEMON: "1" },
			runner: "claude-code",
			cwd: dir,
		});
		expect(res.exit_code).toBe(0);
	});

	it("does not call the retired blanket daemon-outage block from production", () => {
		const source = readFileSync(join(process.cwd(), "src", "hook-entry.ts"), "utf-8");
		expect(source).not.toContain("coldDaemonUnreachableBlockReasonFresh(");
	});
});
