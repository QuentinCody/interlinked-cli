import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluateUnifiedContext } from "./harness/evaluator-unified.js";
import { type SessionDaemonHandle, startSessionDaemon } from "./harness/session-daemon.js";
import type { DaemonPaths } from "./harness/session-paths.js";
import type { TsgoRunner } from "./harness/tsgo-runner.js";
import type { HarnessDecision, HarnessEvent } from "./harness/types.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";
import { discoverSocket, isCodeEditEvent, recoveryAttemptNotice, runHookEntry } from "./hook-entry.js";

let tmp = "";
let daemon: SessionDaemonHandle | null = null;
let legacyServer: Server | null = null;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-he-"));
	mkdirSync(join(tmp, ".interlinked"));
});
afterEach(async () => {
	if (daemon) {
		await daemon.stop();
		daemon = null;
	}
	if (legacyServer) {
		await new Promise<void>((resolve) => legacyServer?.close(() => resolve()));
		legacyServer = null;
	}
	rmSync(tmp, { recursive: true, force: true });
});

function makePaths(id: string): DaemonPaths {
	return {
		socket: join(tmp, ".interlinked", `harness-${id}.sock`),
		pid: join(tmp, ".interlinked", `harness-${id}.pid`),
		log: join(tmp, ".interlinked", "logs", `daemon-${id}.log`),
	};
}

function makeTsgo(): TsgoRunner {
	return {
		available: () => true,
		checkFile: vi.fn().mockResolvedValue({ diagnostics: [], cached: false, elapsed_ms: 1 }),
		simulateEdit: vi.fn().mockResolvedValue({ new_diagnostics: [], elapsed_ms: 1 }),
		invalidate: vi.fn(),
		stats: () => ({ cache_size: 0, available: true }),
	};
}

function makeEvaluatorContext(): EvaluateUnifiedContext {
	return {
		rules: { version: 1, enabled: false } as unknown as EvaluateUnifiedContext["rules"],
		session: undefined,
		reservations: {} as EvaluateUnifiedContext["reservations"],
		cohort: {} as EvaluateUnifiedContext["cohort"],
	};
}

function startLegacyHarnessServer(
	socketPath: string,
	decision: HarnessDecision,
	received: HarnessEvent[],
): Promise<void> {
	return startLegacyHarnessHandler(socketPath, (event, reply) => {
		received.push(event);
		reply(decision);
	});
}

function startLegacyHarnessHandler(
	socketPath: string,
	handle: (event: HarnessEvent, reply: (decision: HarnessDecision) => void) => void,
): Promise<void> {
	legacyServer = createServer((socket: Socket) => {
		let buffer = "";
		socket.on("error", () => {
			// A deliberately timed-out hook destroys its client socket before the
			// simulated daemon publishes its late result.
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf-8");
			const idx = buffer.indexOf("\n");
			if (idx === -1) return;
			const event = JSON.parse(buffer.slice(0, idx)) as HarnessEvent;
			handle(event, (decision) => {
				if (!socket.destroyed) socket.end(`${JSON.stringify(decision)}\n`);
			});
		});
	});
	return new Promise((resolve, reject) => {
		legacyServer?.once("error", reject);
		legacyServer?.listen(socketPath, () => resolve());
	});
}

describe("isCodeEditEvent (drives the extended coverage timeout)", () => {
	function ev(kind: string, toolName?: string): UnifiedHookEvent {
		const action = toolName ? { kind, tool_name: toolName } : { kind };
		return { phase: "pre-tool", action } as unknown as UnifiedHookEvent;
	}

	it("is true for the normalized write-shaped tools and file operations", () => {
		// Unified events carry lowercase_snake tool names (the adapter normalizes
		// Write/MultiEdit/NotebookEdit → write/multi_edit/notebook_edit).
		for (const t of ["write", "edit", "multi_edit", "apply_patch", "notebook_edit"]) {
			expect(isCodeEditEvent(ev("tool_call", t))).toBe(true);
		}
		expect(isCodeEditEvent(ev("file_operation"))).toBe(true);
		// Defensive case-insensitivity for any stray casing.
		expect(isCodeEditEvent(ev("tool_call", "WRITE"))).toBe(true);
	});

	it("is true for camelCase tool names a runner preserves un-normalized (Codex)", () => {
		// Codex does NOT normalize — it sends `MultiEdit` / `NotebookEdit` verbatim.
		// The lowercase + underscore-strip must still map these into the edit set so
		// they get the long coverage timeout, not the short fallback that returns
		// before the per-edit overlay's verdict (finding 2026-06).
		for (const t of ["MultiEdit", "NotebookEdit", "Write", "Edit"]) {
			expect(isCodeEditEvent(ev("tool_call", t))).toBe(true);
		}
	});

	it("is false for non-edit tool calls and shell commands", () => {
		for (const t of ["bash", "read", "grep", "glob"]) {
			expect(isCodeEditEvent(ev("tool_call", t))).toBe(false);
		}
		expect(isCodeEditEvent(ev("shell_command"))).toBe(false);
	});
});

describe("discoverSocket", () => {
	it("returns null when no .interlinked dir exists", () => {
		const empty = mkdtempSync(join(tmpdir(), "interlinked-empty-"));
		try {
			expect(discoverSocket(empty, "any")).toBeNull();
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("prefers per-session sockets", () => {
		writeFileSync(join(tmp, ".interlinked", "harness-abc.sock"), "");
		writeFileSync(join(tmp, ".interlinked", "harness-default.sock"), "");
		writeFileSync(join(tmp, ".interlinked", "harness.sock"), "");
		const path = discoverSocket(tmp, "abc");
		expect(path?.endsWith("harness-abc.sock")).toBe(true);
	});

	it("uses the default framed socket before the legacy raw socket", () => {
		writeFileSync(join(tmp, ".interlinked", "harness-default.sock"), "");
		writeFileSync(join(tmp, ".interlinked", "harness.sock"), "");
		const path = discoverSocket(tmp, "no-match");
		expect(path?.endsWith("harness-default.sock")).toBe(true);
	});

	it("falls back to legacy socket", () => {
		writeFileSync(join(tmp, ".interlinked", "harness.sock"), "");
		const path = discoverSocket(tmp, "no-match");
		expect(path?.endsWith("harness.sock")).toBe(true);
	});

	it("returns null when no socket files exist", () => {
		expect(discoverSocket(tmp, "any")).toBeNull();
	});
});

describe("runHookEntry — adapter resolution", () => {
	it("returns a helpful stderr when no runner is detected", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {},
			env: {},
		});
		expect(result.exit_code).toBe(0);
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("no runner detected");
	});

	it("resolves an explicit runner id", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "s",
				cwd: tmp,
				tool_name: "Read",
				tool_input: {},
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
		});
		// No daemon running → cold fallback to allow.
		expect(result.exit_code).toBe(0);
		expect(result.fell_back).toBe(true);
	});
});

describe("runHookEntry — end-to-end with real daemon", () => {
	it("round-trips a PreToolUse event through the daemon", async () => {
		const paths = makePaths("he1");
		daemon = await startSessionDaemon({
			paths,
			session_id: "he1",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "he1",
				cwd: tmp,
				tool_name: "Read",
				tool_input: { file_path: "/a" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: paths.socket,
		});
		expect(result.fell_back).toBe(false);
		expect(result.exit_code).toBe(0);
	});

	it("uses raw JSON for legacy harness.sock and surfaces the real PreToolUse warning", async () => {
		const socketPath = join(tmp, ".interlinked", "harness.sock");
		const received: HarnessEvent[] = [];
		await startLegacyHarnessServer(
			socketPath,
			{ decision: "allow", warnings: ["[interlinked:test] visible warning"] },
			received,
		);

		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "legacy",
				cwd: tmp,
				tool_name: "Edit",
				tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath,
		});

		expect(result.fell_back).toBe(false);
		expect(result.exit_code).toBe(0);
		// hookEventName is now mandatory in every hookSpecificOutput envelope —
		// Claude Code's validator rejects responses without it. The adapter
		// echoes the runner's native event name (PreToolUse here).
		expect(JSON.parse(result.stdout ?? "{}")).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: "[interlinked:test] visible warning",
			},
		});
		expect(received[0]).toMatchObject({
			hook_event: "PreToolUse",
			tool_name: "Edit",
			session_id: "legacy",
		});
		expect("id" in (received[0] ?? {})).toBe(false);
		expect("method" in (received[0] ?? {})).toBe(false);
	});

	it("forwards a PostTool delivery token and acknowledges the synchronous ready record", async () => {
		const socketPath = join(tmp, ".interlinked", "harness.sock");
		const spoolDir = join(tmp, ".interlinked", "quality-warning-spool");
		mkdirSync(spoolDir);
		let deliveryToken = "";
		let deliveryPid: number | undefined;
		await startLegacyHarnessHandler(socketPath, (event, reply) => {
			if (event.hook_event !== "PostToolUse") {
				reply({ decision: "allow", warnings: [] });
				return;
			}
			deliveryToken = event.post_delivery_token ?? "";
			deliveryPid = event.post_delivery_pid;
			writeFileSync(
				join(spoolDir, `${deliveryToken}.active.json`),
				JSON.stringify({
					version: 1,
					token: deliveryToken,
					session_id: "modern-post",
					started_at: new Date().toISOString(),
					client_pid: deliveryPid,
				}),
			);
			writeFileSync(
				join(spoolDir, `${deliveryToken}.ready.json`),
				JSON.stringify({
					version: 1,
					token: deliveryToken,
					session_id: "modern-post",
					produced_at: new Date().toISOString(),
					warnings: ["[interlinked:test] direct warning"],
				}),
			);
			writeFileSync(
				join(tmp, ".interlinked", "pending-quality-warnings.json"),
				JSON.stringify(["[interlinked:test] direct warning"]),
			);
			reply({ decision: "allow", warnings: ["[interlinked:test] direct warning"] });
		});

		const post = await runHookEntry({
			nativeEventName: "PostToolUse",
			nativeJson: {
				session_id: "modern-post",
				cwd: tmp,
				tool_name: "Write",
				tool_input: { file_path: "src/a.ts", content: "export const a = 1;" },
				tool_response: {},
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath,
		});

		expect(deliveryToken).toMatch(/^[a-zA-Z0-9_-]{16,128}$/);
		expect(deliveryPid).toBe(process.pid);
		expect(post.stdout).toContain("direct warning");
		expect(existsSync(join(spoolDir, `${deliveryToken}.ready.json`))).toBe(false);
		expect(existsSync(join(spoolDir, `${deliveryToken}.active.json`))).toBe(false);
		expect(existsSync(join(tmp, ".interlinked", "pending-quality-warnings.json"))).toBe(false);

		const pre = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "modern-post",
				cwd: tmp,
				tool_name: "Read",
				tool_input: { file_path: "src/a.ts" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath,
		});
		expect(pre.stdout ?? "").not.toContain("direct warning");
	});

	it("delivers a timed-out PostTool warning exactly once through the modern PreTool runtime", async () => {
		const socketPath = join(tmp, ".interlinked", "harness.sock");
		const spoolDir = join(tmp, ".interlinked", "quality-warning-spool");
		mkdirSync(spoolDir);
		let captureLateRequest!: (request: {
			token: string;
			reply: (decision: HarnessDecision) => void;
		}) => void;
		const lateRequest = new Promise<{ token: string; reply: (decision: HarnessDecision) => void }>((resolve) => {
			captureLateRequest = resolve;
		});
		await startLegacyHarnessHandler(socketPath, (event, reply) => {
			if (event.hook_event !== "PostToolUse") {
				reply({ decision: "allow", warnings: [] });
				return;
			}
			captureLateRequest({ token: event.post_delivery_token ?? "", reply });
		});

		const post = await runHookEntry({
			nativeEventName: "PostToolUse",
			nativeJson: {
				session_id: "late-modern",
				cwd: tmp,
				tool_name: "Bash",
				tool_input: { command: "echo ok" },
				tool_response: { exit_code: 0 },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath,
			timeout_ms: 5,
		});
		expect(post.fell_back).toBe(true);
		expect(post.stdout ?? "").not.toContain("late warning");
		const late = await lateRequest;
		expect(late.token).not.toBe("");
		writeFileSync(
			join(spoolDir, `${late.token}.ready.json`),
			JSON.stringify({
				version: 1,
				token: late.token,
				session_id: "late-modern",
				produced_at: new Date().toISOString(),
				warnings: ["[interlinked:test] late warning"],
			}),
		);
		late.reply({ decision: "allow", warnings: ["[interlinked:test] late warning"] });

		const preOptions = {
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "late-modern",
				cwd: tmp,
				tool_name: "Read",
				tool_input: { file_path: "src/a.ts" },
			},
			env: {},
			runner: "claude-code" as const,
			cwd: tmp,
			socketPath,
		};
		const first = await vi.waitFor(
			async () => {
				const candidate = await runHookEntry(preOptions);
				expect(candidate.stdout ?? "").toContain("late warning");
				return candidate;
			},
			{ timeout: 1_000, interval: 10 },
		);
		const second = await runHookEntry(preOptions);
		expect(first.stdout ?? "").toContain("late warning");
		expect(second.stdout ?? "").not.toContain("late warning");
	});

	it("drains a completed late warning even when the daemon socket has disappeared", async () => {
		const spoolDir = join(tmp, ".interlinked", "quality-warning-spool");
		mkdirSync(spoolDir);
		writeFileSync(
			join(spoolDir, "daemon-gone-token.ready.json"),
			JSON.stringify({
				version: 1,
				token: "daemon-gone-token",
				session_id: "daemon-gone",
				produced_at: new Date(Date.now() - 1_000).toISOString(),
				warnings: ["[interlinked:test] survived daemon exit"],
			}),
		);
		const options = {
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "daemon-gone",
				cwd: tmp,
				tool_name: "Read",
				tool_input: { file_path: "src/a.ts" },
			},
			env: { INTERLINKED_NO_SELF_HEAL: "1" },
			runner: "claude-code" as const,
			cwd: tmp,
		};

		const first = await runHookEntry(options);
		const second = await runHookEntry(options);
		expect(first.fell_back).toBe(true);
		expect(first.stdout).toContain("survived daemon exit");
		expect(second.stdout ?? "").not.toContain("survived daemon exit");
	});

	it("honors INTERLINKED_HOOK_PROTOCOL=framed even when the socket is named harness.sock", async () => {
		const paths: DaemonPaths = {
			socket: join(tmp, ".interlinked", "harness.sock"),
			pid: join(tmp, ".interlinked", "harness-framed.pid"),
			log: join(tmp, ".interlinked", "logs", "daemon-framed.log"),
		};
		daemon = await startSessionDaemon({
			paths,
			session_id: "forced-framed",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});

		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "forced-framed",
				cwd: tmp,
				tool_name: "Read",
				tool_input: { file_path: "/a" },
			},
			env: { INTERLINKED_HOOK_PROTOCOL: "framed" },
			runner: "claude-code",
			cwd: tmp,
			socketPath: paths.socket,
		});

		expect(result.fell_back).toBe(false);
		expect(result.exit_code).toBe(0);
	});

	it("honors INTERLINKED_HOOK_PROTOCOL=raw for a harness-*.sock path", async () => {
		const socketPath = join(tmp, ".interlinked", "harness-raw.sock");
		const received: HarnessEvent[] = [];
		await startLegacyHarnessServer(
			socketPath,
			{ decision: "allow", warnings: ["forced raw"] },
			received,
		);

		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "forced-raw",
				cwd: tmp,
				tool_name: "Edit",
				tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
			},
			env: { INTERLINKED_HOOK_PROTOCOL: "raw" },
			runner: "claude-code",
			cwd: tmp,
			socketPath,
		});

		expect(result.fell_back).toBe(false);
		expect(received[0]?.hook_event).toBe("PreToolUse");
	});
});

describe("runHookEntry — cold fallback on daemon absence", () => {
	it("allows a benign tool call when the socket is missing", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "none",
				cwd: tmp,
				tool_name: "Edit",
				tool_input: { file_path: "/x", old_string: "a", new_string: "b" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: join(tmp, "nope.sock"),
		});
		expect(result.fell_back).toBe(true);
		// Cold fallback allows without putting transport failures in
		// model-visible PreToolUse additionalContext.
		expect(result.exit_code).toBe(0);
		expect(result.stdout).toBeUndefined();
		expect(result.stderr).toContain("evaluator skipped");
	});

	it("blocks a destructive bash command when the socket is missing", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "none",
				cwd: tmp,
				tool_name: "Bash",
				tool_input: { command: "rm -rf /" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: join(tmp, "nope.sock"),
		});
		expect(result.fell_back).toBe(true);
		// The cold path runs the shared destructive-command guard, so `rm -rf /`
		// is blocked even with the daemon unreachable — the fail-closed floor.
		expect(result.stderr).toContain("destructive-command fail-closed gate engaged");
		expect(result.stdout).toBeTruthy();
	});

	it("blocks a destructive shell_command (Cursor) when the socket is missing", async () => {
		const result = await runHookEntry({
			nativeEventName: "beforeShellExecution",
			nativeJson: {
				session_id: "none",
				cwd: tmp,
				command: "rm -rf /",
			},
			env: {},
			runner: "cursor",
			cwd: tmp,
			socketPath: join(tmp, "nope.sock"),
		});
		expect(result.fell_back).toBe(true);
		// Cursor's beforeShellExecution produces a shell_command action — the cold
		// fallback must still engage the destructive-command guard on it.
		expect(result.stderr).toContain("destructive-command fail-closed gate engaged");
		expect(result.stdout).toBeTruthy();
	});

	it("allows a benign shell_command (Cursor) when the socket is missing", async () => {
		const result = await runHookEntry({
			nativeEventName: "beforeShellExecution",
			nativeJson: {
				session_id: "none",
				cwd: tmp,
				command: "ls",
			},
			env: {},
			runner: "cursor",
			cwd: tmp,
			socketPath: join(tmp, "nope.sock"),
		});
		expect(result.fell_back).toBe(true);
		expect(result.exit_code).toBe(0);
		// Cursor's adapter emits {"permission":"allow"} on stdout for gated
		// events (beforeShellExecution), unlike Claude Code which returns undefined.
		expect(result.stdout).toContain("allow");
		expect(result.stderr).toContain("evaluator skipped");
	});

	it("blocks an over-cap code write when the socket is missing (line-cap fail-closed inline)", async () => {
		// 851 lines, over the 800 default cap (tmp has no baseline). The daemon is
		// unreachable, so this exercises the INLINE cold-fallback line-cap gate — the
		// robustness fix so an over-cap write can't slip through on a daemon blip.
		const bigContent = "export const x = 1;\n".repeat(850);
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "none",
				cwd: tmp,
				tool_name: "Write",
				tool_input: { file_path: join(tmp, "src/big.ts"), content: bigContent },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: join(tmp, "nope.sock"),
		});
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("large-file cap fail-closed gate engaged");
		expect(result.stdout).toBeTruthy(); // a block decision is emitted on stdout
	});

	it("allows an under-cap code write in the cold fallback (no false block)", async () => {
		const smallContent = "export const x = 1;\n".repeat(10);
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "none",
				cwd: tmp,
				tool_name: "Write",
				tool_input: { file_path: join(tmp, "src/small.ts"), content: smallContent },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: join(tmp, "nope.sock"),
		});
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("evaluator skipped"); // benign allow path
		expect(result.stderr).toContain("function-tokens:not-measured");
		expect(result.stderr).toContain("requires the running harness daemon");
		expect(result.stderr).not.toContain("large-file cap");
	});
});

describe("recoveryAttemptNotice — one clause per self-heal disposition", () => {
	it("returns the empty string when no self-heal attempt was made", () => {
		expect(recoveryAttemptNotice(null)).toBe("");
	});

	it("reports a spawn that was attempted but not yet verified", () => {
		expect(
			recoveryAttemptNotice({
				result: "spawned",
				disposition: "launch-attempted",
				launchAttempted: true,
			}),
		).toBe("; daemon launch attempted but not yet verified");
	});

	it("reports a spawn that was attempted but failed", () => {
		expect(
			recoveryAttemptNotice({
				result: "skipped",
				disposition: "spawn-failed",
				launchAttempted: true,
			}),
		).toBe("; daemon launch was attempted but the spawn failed");
	});

	it("reports no launch when another hook already holds the startup lock", () => {
		expect(
			recoveryAttemptNotice({
				result: "locked",
				disposition: "startup-lock-held",
				launchAttempted: false,
			}),
		).toBe("; no launch by this hook (startup lock held)");
	});

	it("reports no launch when the supervisor backoff ladder is active", () => {
		expect(
			recoveryAttemptNotice({
				result: "backoff",
				disposition: "retry-backoff",
				launchAttempted: false,
			}),
		).toBe("; no launch attempted (supervisor retry backoff active)");
	});

	it("reports no launch when self-heal was disabled by env var", () => {
		expect(
			recoveryAttemptNotice({
				result: "skipped",
				disposition: "self-heal-disabled",
				launchAttempted: false,
			}),
		).toBe("; no launch attempted (self-heal disabled)");
	});

	it("reports no launch when the guard was intentionally disabled", () => {
		expect(
			recoveryAttemptNotice({
				result: "skipped",
				disposition: "guard-disabled",
				launchAttempted: false,
			}),
		).toBe("; no launch attempted (guard intentionally disabled)");
	});

	it("reports no launch when no Interlinked project root was found", () => {
		expect(
			recoveryAttemptNotice({
				result: "skipped",
				disposition: "no-project",
				launchAttempted: false,
			}),
		).toBe("; no launch attempted (no Interlinked project found)");
	});
});
