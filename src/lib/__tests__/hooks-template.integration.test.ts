import { isJsonObject } from "../json-types.js";
import { parseWire } from "../value-validation.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHookScript } from "../hooks-template.js";

// These assertions are the byte-level invariants for the template:
// the generated .mjs must contain marker strings from every chunk and must
// start with the versioned shebang. If any marker disappears, the refactor
// (hook-template-chunks/*) has drifted and the generated hook will be broken.

describe("buildHookScript", () => {
	it("starts with the versioned shebang", () => {
		const out = buildHookScript("0.1.0");
		expect(out.startsWith("#!/usr/bin/env node\n// interlinked-hook-version: 0.1.0\n")).toBe(
			true,
		);
	});

	it("interpolates the version argument", () => {
		const out = buildHookScript("custom-9.9.9");
		expect(out).toContain("// interlinked-hook-version: custom-9.9.9");
	});

	it("embeds redaction chunk markers", () => {
		const out = buildHookScript("v");
		expect(out).toContain("SECRET_PATTERNS");
		expect(out).toContain("function redactSecrets");
		expect(out).toContain("function scrubPayload");
	});

	it("embeds guards-inline chunk markers", () => {
		const out = buildHookScript("v");
		expect(out).toContain("function inlineGuardCheck");
		expect(out).toContain("BLOCKED: Recursive force-delete");
	});

	it("embeds session-state chunk markers", () => {
		const out = buildHookScript("v");
		expect(out).toContain("function extractNewThinking");
		expect(out).toContain("function appendLocal");
		expect(out).toContain("function updateSessionState");
		expect(out).toContain("function captureCodeEdit");
		expect(out).toContain("function reconcileCommits");
		expect(out).toContain("async function batchSync");
	});

	it("embeds provider-responses chunk markers", () => {
		const out = buildHookScript("v");
		expect(out).toContain("function formatProviderResponse");
		expect(out).toContain("Provider-specific response formatting");
	});

	it("embeds event-normalizers chunk markers", () => {
		const out = buildHookScript("v");
		expect(out).toContain("function normalizeClaudeEvent");
		expect(out).toContain("function normalizeCopilotEvent");
		// --- Client Normalizers --- header is emitted verbatim from the chunk.
		expect(out).toContain("// --- Client Normalizers ---");
	});

	it("defers skip_paths resolution to the daemon", () => {
		const out = buildHookScript("v");
		// skip_paths is decided after the daemon observes the filesystem
		// ChangeSet; the generated hook must not carry a declared-path bypass.
		expect(out).not.toContain("function matchesSkipPath(");
		expect(out).not.toContain("SKIP_PATHS_CACHE");
		expect(out).not.toContain("[interlinked:skip] path matched skip_paths");
	});

	// test-contract: boundary — a declared path matching skip_paths must still reach daemon evaluation, while successful read-only events retain their documented fast path.
	it("sends skipped writer events to the daemon but fast-paths successful reads", async () => {
		// Keep the Unix socket path below macOS's sockaddr_un limit.
		const tempDir = mkdtempSync(join(tmpdir(), "il-"));
		const interlinkedDir = join(tempDir, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		writeFileSync(join(interlinkedDir, "config.json"), JSON.stringify({ skip_paths: ["dist/**"] }));
		writeFileSync(join(interlinkedDir, "config.local.json"), JSON.stringify({ sync_mode: "local" }));
		const socketPath = join(interlinkedDir, "harness.sock");
		const requests: Array<Record<string, unknown>> = [];
		const server = createServer((socket) => {
			let received = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				received += chunk;
				const newline = received.indexOf("\n");
				if (newline < 0) return;
				requests.push(parseWire(JSON.parse(received.slice(0, newline)), isJsonObject, "hook request object"));
				socket.end(JSON.stringify({ summary: "daemon observed", warnings: [] }) + "\n");
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		expect(existsSync(socketPath)).toBe(true);

		const scriptPath = join(tempDir, "hook.mjs");
		writeFileSync(scriptPath, buildHookScript("skip-paths-test"));
		const runHook = (toolName: string, toolInput: Record<string, unknown>) =>
			new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
				const child = spawn(process.execPath, [scriptPath], {
					cwd: tempDir,
					env: { ...process.env, INTERLINKED_HOME: interlinkedDir, INTERLINKED_DATA_DIR: interlinkedDir },
				});
				let stderr = "";
				child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
				child.on("error", reject);
				child.on("close", (status) => resolve({ status, stderr }));
				child.stdin.end(JSON.stringify({
					hook_event_name: "PostToolUse",
					session_id: `${toolName.toLowerCase()}-skip-path-test`,
					cwd: tempDir,
					tool_name: toolName,
					tool_input: toolInput,
					tool_response: {},
				}));
			});

		try {
			const writer = await runHook("Write", { file_path: join(tempDir, "dist/generated.ts"), content: "export const generated = true;" });
			expect(writer.status, writer.stderr).toBe(0);
			expect(requests, writer.stderr).toHaveLength(1);
			expect(requests[0]?.tool_name).toBe("Write");

			const read = await runHook("Read", { file_path: join(tempDir, "dist/generated.ts") });
			expect(read.status, read.stderr).toBe(0);
			expect(requests).toHaveLength(1);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("extracts file paths from apply_patch payloads for Codex/Copilot edits", () => {
		const out = buildHookScript("v");
		expect(out).toContain('"apply_patch"');
		expect(out).toContain("Move to:");
		expect(out).toContain("(?:Update|Add|Delete) File:");
	});

	it("ships a shared inline PostToolUse strong-typing fallback for Claude and Codex", () => {
		const out = buildHookScript("v");
		expect(out).toContain("inlinePostToolFallback");
		expect(out).toContain("INLINE_STRONG_TYPING_PATTERNS");
		expect(out).toContain("inline strong_typing clean");
		expect(out).toContain("[interlinked:strong_typing]");
	});

	it("inline strong_typing fallback exempts .test.* and .spec.* files (parity with daemon)", () => {
		// Daemon-side strong_typing skips test files at quality-checks.ts:223–225;
		// the inline hook fallback used to fire on them anyway. The generated
		// hook must short-circuit before scanning test files.
		const out = buildHookScript("v");
		expect(out).toContain("/\\.(?:test|spec)\\.(?:tsx?|jsx?|mjs|cjs)$/");
	});

	it("separates advisory PostToolUse warnings from blocking ones in the generated hook", () => {
		const out = buildHookScript("v");
		expect(out).toContain('const responseType = isBlockingPostDecision ? "post_block" : "post_warn";');
		expect(out).toContain('isBlockingPostDecision ? "block" : "warn"');
		expect(out).toContain('Advisory findings:');
	});

	it("keeps the local activity.jsonl write 100% faithful (no scrub) while every egress path scrubs", () => {
		const out = buildHookScript("v");
		// Two-tier model (raw local / redacted egress): the LOCAL write is
		// full-fidelity — appendLocal must NOT run scrubPayload on the record
		// before appendFileSync (raw capture for replay / trajectory / training).
		// If a scrubPayload(record) reappears, local PII/secrets get masked again
		// and the corpus loses fidelity.
		expect(out).not.toMatch(/scrubPayload\(record\)/);
		// ...but EGRESS must still redact: the realtime payload and the batchSync
		// event both run scrubPayload before POSTing. If either regresses, raw
		// PII/secrets would leave the machine.
		expect(out).toContain("scrubPayload(realtimePayload)");
		expect(out).toContain("scrubPayload(ev)");
	});

	it("bounds legacy realtime network work on the hook hot path", () => {
		const out = buildHookScript("v");
		expect(out).toContain("const REALTIME_POST_TIMEOUT_MS = 500");
		expect(out).toContain("const REALTIME_RETRY_TIMEOUT_MS = 250");
		expect(out).toContain("const REALTIME_RETRY_MAX_PER_HOOK = 3");
		expect(out).toContain("fetchWithTimeout(serverUrl + \"/api/hooks/activity\"");
		expect(out).toContain("REALTIME_RETRY_MAX_PER_HOOK");
		expect(out).not.toContain("setTimeout(() => controller.abort(), 3000)");
	});

	it("generated .mjs parses as valid JavaScript (end-to-end syntactic check)", () => {
		// Pipe the script into `node --check` with ESM input-type so a broken
		// chunk (extra `\\`, unterminated string, mis-escaped backtick)
		// surfaces here instead of blowing up on every user's machine when the
		// hook fires. The generated script is an ES module (top-level
		// `import` statements), so we must declare that explicitly when
		// feeding it via stdin.
		const script = buildHookScript("parse-check");
		const res = spawnSync(
			process.execPath,
			["--input-type=module", "--check", "-"],
			{ input: script, encoding: "utf-8" },
		);
		expect(res.status, `node --check rejected the hook script: ${res.stderr}`).toBe(0);
	});

	it("fails Claude WorktreeCreate without returning a replacement path", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-worktree-ban-"));
		const interlinkedDir = join(tempDir, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		writeFileSync(join(interlinkedDir, "config.local.json"), JSON.stringify({ sync_mode: "local" }));
		const scriptPath = join(tempDir, "hook.mjs");
		writeFileSync(scriptPath, buildHookScript("worktree-ban-test"));
		const res = spawnSync(process.execPath, [scriptPath], {
			input: JSON.stringify({
				hook_event_name: "WorktreeCreate",
				session_id: "worktree-ban",
				cwd: tempDir,
				name: "feature",
			}),
			encoding: "utf-8",
			cwd: tempDir,
			env: {
				...process.env,
				INTERLINKED_HOME: interlinkedDir,
				INTERLINKED_DATA_DIR: interlinkedDir,
				INTERLINKED_CLIENT: "claude",
			},
			timeout: 10_000,
		});

		expect(res.error, `spawn failed: ${res.error}`).toBeUndefined();
		expect(res.status).toBe(2);
		expect(res.stdout).toBe("");
		expect(res.stderr).toContain("Agent-created Git worktrees are disabled");
	});

	it("generated .mjs uses argv-form git invocations (no shell interpolation)", () => {
		// Security regression guard for Vuln 1: reconcileCommits must never
		// concatenate session_start_head or a commit hash into a shell string.
		// If these fragments disappear, the fix has regressed.
		const out = buildHookScript("v");
		expect(out).toContain("function isGitSha(v)");
		expect(out).toContain("/^[0-9a-fA-F]{7,40}$/");
		expect(out).toContain('["log", state.session_start_head + "..HEAD"');
		expect(out).toContain('["diff", hash + "~1", hash, "--name-only"]');
		expect(out).toContain('["diff", hash + "~1", hash, "--numstat"]');
		// The old shell form is gone.
		expect(out).not.toContain('execSync("git log " +');
		expect(out).not.toContain('execSync(\n                "git log " +');
	});

	it("always overwrites hookEvent with the normalized canonical name (Cursor regression)", () => {
		// Regression: previously the resolution was
		//   if (!hookEvent && event.hook_event) { hookEvent = event.hook_event; }
		// which kept Cursor's raw `beforeShellExecution` in `hookEvent`. The
		// downstream `isPreTool/isPostTool/isUserPrompt` matchers and the
		// harness server only recognise canonical names ("PreToolUse" etc.),
		// so destructive Cursor shell/MCP calls bypassed every guard.
		const out = buildHookScript("v");
		expect(out).toMatch(/if \(event\.hook_event\) \{\s*hookEvent = event\.hook_event;\s*\}/);
		expect(out).not.toMatch(/if \(!hookEvent && event\.hook_event\)/);
	});

	it("formatCursorResponse gates on the raw Cursor event name (per-event capabilities)", () => {
		// formatCursorResponse switches on the raw native event (postToolUse
		// supports additional_context, beforeShellExecution / beforeMCPExecution
		// support ask, etc.) — not the canonical PreToolUse alias. Without this
		// the response would either silently skip the gate or misuse fields the
		// runner doesn't accept.
		const out = buildHookScript("v");
		expect(out).toContain('native === "beforeShellExecution"');
		expect(out).toContain('native === "beforeMCPExecution"');
		expect(out).toContain('native === "beforeMcpToolExecution"');
		expect(out).toContain('native === "subagentStart"');
		expect(out).toContain('native === "postToolUse"');
		// And the wiring captures the raw event before normalization rewrites
		// hookEvent to "PreToolUse".
		expect(out).toContain("const cursorNativeEvent = hookEvent;");
	});

	it("formatCursorResponse uses snake_case response fields (per Cursor docs)", () => {
		// Cursor's documented response contract uses snake_case: user_message,
		// agent_message, additional_context, updated_input. The previous
		// camelCase form was silently ignored by Cursor — denials reached the
		// runner with empty messages. This test pins the field naming so a
		// future refactor can't regress it.
		const out = buildHookScript("v");
		expect(out).toContain("agent_message: data.reason");
		expect(out).toContain("user_message: data.reason");
		expect(out).toContain("additional_context: data.summary");
		expect(out).toContain("additional_context: data.reason");
	});

	it("inline guard receives the normalized tool_input (Cursor / Copilot regression)", () => {
		// Regression: the inline fallback used to read `rawInput.tool_input`
		// directly. Cursor's beforeShellExecution carries the command at the
		// top level (rawInput.command), and Copilot wraps args under toolArgs;
		// neither client sets rawInput.tool_input, so the inline guard saw
		// undefined and let destructive commands through whenever the harness
		// was unavailable. The fix passes harnessEvent.tool_input (the
		// post-normalization shape).
		const out = buildHookScript("v");
		expect(out).toContain(
			"inlineGuardCheck(hookEvent, harnessEvent.tool_name, harnessEvent.tool_input)",
		);
		expect(out).not.toContain(
			"inlineGuardCheck(hookEvent, harnessEvent.tool_name, rawInput.tool_input)",
		);
	});

	it("blocks Cursor beforeShellExecution rm -rf via the inline fallback (end-to-end)", () => {
		// Wires the full .mjs runtime against a Cursor-shaped stdin payload to
		// confirm: (1) the Cursor normalizer fires (cursor_version field
		// detection), (2) hookEvent gets resolved to canonical "PreToolUse",
		// (3) isPreTool === true, (4) the inline guard receives a usable
		// tool_input via harnessEvent, (5) the block decision flows through
		// formatCursorResponse and emits Cursor's permission:"deny" stdout.
		// If any of those four bug-paths regress, this test fails.
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-cursor-e2e-"));
		const interlinkedDir = join(tempDir, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		writeFileSync(
			join(interlinkedDir, "config.local.json"),
			JSON.stringify({ sync_mode: "local", agent_name: "cursor-test-agent" }),
		);
		// Pretend a harness is "alive" so tryHealHarness returns false (skips
		// the 1.5s retry spin) — we want the inline fallback to fire fast.
		writeFileSync(join(interlinkedDir, "harness.pid"), String(process.pid));
		writeFileSync(join(interlinkedDir, "harness.sock"), "");

		const scriptPath = join(tempDir, "hook.mjs");
		writeFileSync(scriptPath, buildHookScript("test"));

		const cursorPayload = {
			hook_event_name: "beforeShellExecution",
			session_id: "cursor-e2e-session",
			cwd: tempDir,
			command: "rm -rf /",
			cursor_version: "1.0.0",
			conversation_id: "conv-1",
			generation_id: "gen-1",
		};

		const res = spawnSync(process.execPath, [scriptPath], {
			input: JSON.stringify(cursorPayload),
			encoding: "utf-8",
			cwd: tempDir,
			env: {
				...process.env,
				INTERLINKED_HOME: interlinkedDir,
				INTERLINKED_DATA_DIR: interlinkedDir,
				INTERLINKED_CLIENT: "cursor",
			},
			timeout: 10_000,
		});

		expect(res.error, `spawn failed: ${res.error}`).toBeUndefined();
		const stdout = (res.stdout || "").trim();
		expect(stdout, `expected non-empty stdout; stderr=${res.stderr}`).not.toBe("");
		const parsed = JSON.parse(stdout);
		expect(parsed.permission).toBe("deny");
		// Cursor's response contract is snake_case (user_message /
		// agent_message). The legacy camelCase keys were silently ignored,
		// causing denial messages to reach Cursor empty.
		expect(String(parsed.agent_message || parsed.user_message || "")).toMatch(
			/BLOCKED|recursive|rm -rf/i,
		);
	});

	// THE OUTPUT RULE (2026-08-27): a hook with nothing to say writes ZERO
	// BYTES. Printing "{}" is not silence — Codex renders one
	// "PostToolUse hook (completed)" row per response, so an empty envelope on
	// every clean tool call flooded the conversation, multiplied by every
	// parallel command. These run the REAL generated hook and assert on its
	// actual bytes, because that is the thing the user sees.
	describe("clean hook output — zero bytes (must stay silent)", () => {
		function runGeneratedHook(payload: Record<string, unknown>, client: string) {
			const tempDir = mkdtempSync(join(tmpdir(), "interlinked-silent-"));
			const interlinkedDir = join(tempDir, ".interlinked");
			mkdirSync(interlinkedDir, { recursive: true });
			writeFileSync(
				join(interlinkedDir, "config.local.json"),
				JSON.stringify({ sync_mode: "local", agent_name: "silence-test" }),
			);
			// A pid file naming a live process + a non-socket file keeps the
			// heal/retry spin out of the test: the connect fails immediately.
			writeFileSync(join(interlinkedDir, "harness.pid"), String(process.pid));
			writeFileSync(join(interlinkedDir, "harness.sock"), "");
			const scriptPath = join(tempDir, "hook.mjs");
			writeFileSync(scriptPath, buildHookScript("test"));
			return spawnSync(process.execPath, [scriptPath], {
				input: JSON.stringify({ ...payload, cwd: tempDir }),
				encoding: "utf-8",
				cwd: tempDir,
				env: {
					...process.env,
					INTERLINKED_HOME: interlinkedDir,
					INTERLINKED_DATA_DIR: interlinkedDir,
					INTERLINKED_CLIENT: client,
				},
				timeout: 20_000,
			});
		}

		for (const client of ["claude", "codex"]) {
			it(`N: a read-only PostToolUse writes no stdout and no stderr (${client})`, () => {
				const res = runGeneratedHook(
					{
						hook_event_name: "PostToolUse",
						session_id: "silent-readonly",
						tool_name: "Read",
						tool_input: { file_path: "/etc/hosts" },
						tool_response: { ok: true },
					},
					client,
				);
				expect(res.error, `spawn failed: ${res.error}`).toBeUndefined();
				expect(res.stdout).toBe("");
				expect(res.stderr).toBe("");
			});

			it(`N: a PostToolUse with the harness unreachable writes no stdout (${client})`, () => {
				const res = runGeneratedHook(
					{
						hook_event_name: "PostToolUse",
						session_id: "silent-no-harness",
						tool_name: "Bash",
						tool_input: { command: "echo hi" },
						tool_response: { exit_code: 0 },
					},
					client,
				);
				expect(res.error, `spawn failed: ${res.error}`).toBeUndefined();
				expect(res.stdout).toBe("");
			});
		}

		/** Run the generated hook against a fake daemon that answers every
		 *  request with `reply`. Returns the hook's own stdout/stderr. */
		async function runAgainstDaemon(
			reply: Record<string, unknown>,
			buildPayload: (dir: string) => Record<string, unknown>,
			mutateScript?: (script: string) => string,
		): Promise<{ stdout: string; stderr: string; requests: Array<Record<string, unknown>> }> {
			// "il-" and nothing longer: the socket path must stay under macOS's
			// sockaddr_un limit (104 bytes). Over it, listen() still succeeds and
			// the socket file exists, but every connect fails — the hook then
			// heals, falls back inline, and a silence assertion passes VACUOUSLY.
			const tempDir = mkdtempSync(join(tmpdir(), "il-"));
			const interlinkedDir = join(tempDir, ".interlinked");
			mkdirSync(interlinkedDir, { recursive: true });
			writeFileSync(join(interlinkedDir, "config.json"), JSON.stringify({ skip_paths: ["dist/**"] }));
			writeFileSync(join(interlinkedDir, "config.local.json"), JSON.stringify({ sync_mode: "local" }));
			const socketPath = join(interlinkedDir, "harness.sock");
			// Track accepted sockets: server.close() waits on lingering
			// connections, which hangs teardown if they are not destroyed.
			const accepted: Array<{ destroy: () => void }> = [];
			const requests: Array<Record<string, unknown>> = [];
			const server = createServer((socket) => {
				accepted.push(socket);
				let received = "";
				socket.setEncoding("utf8");
				socket.on("data", (chunk) => {
					received += chunk;
					const newline = received.indexOf("\n");
					if (newline < 0) return;
					requests.push(parseWire(JSON.parse(received.slice(0, newline)), isJsonObject, "hook request object"));
					socket.end(`${JSON.stringify(reply)}\n`);
				});
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			expect(existsSync(socketPath), `socket missing at ${socketPath} (len ${socketPath.length})`).toBe(true);
			const scriptPath = join(tempDir, "hook.mjs");
			const baseScript = buildHookScript("daemon-test");
			const script = mutateScript ? mutateScript(baseScript) : baseScript;
			// A mutation that matches nothing would silently test the fixed code.
			if (mutateScript) expect(script).not.toBe(baseScript);
			writeFileSync(scriptPath, script);
			try {
				const res = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
					const child = spawn(process.execPath, [scriptPath], {
						cwd: tempDir,
						env: {
							...process.env,
							INTERLINKED_HOME: interlinkedDir,
							INTERLINKED_DATA_DIR: interlinkedDir,
						},
					});
					let stdout = "";
					let stderr = "";
					child.stdout.on("data", (chunk: Buffer) => {
						stdout += chunk.toString();
					});
					child.stderr.on("data", (chunk: Buffer) => {
						stderr += chunk.toString();
					});
					child.on("error", reject);
					child.on("close", () => resolve({ stdout, stderr }));
					child.stdin.end(JSON.stringify({ ...buildPayload(tempDir), cwd: tempDir }));
				});
				return { stdout: res.stdout, stderr: res.stderr, requests };
			} finally {
				for (const s of accepted) s.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		}

		const editPayload = (dir: string) => ({
			hook_event_name: "PostToolUse",
			session_id: "daemon-answer",
			tool_name: "Write",
			tool_input: { file_path: join(dir, "dist/generated.ts"), content: "export const generated = true;" },
			tool_response: {},
		});
		const permissionPayload = () => ({
			hook_event_name: "PermissionRequest",
			session_id: "permission-answer",
			tool_name: "Bash",
			tool_input: { command: "echo mutate" },
		});

		it("P: generated Claude PermissionRequest block emits the exact deny contract", async () => {
			const { stdout, stderr, requests } = await runAgainstDaemon(
				{ decision: "block", reason: "policy denied", warnings: [] },
				permissionPayload,
			);
			expect(requests.length, `stderr=${stderr}`).toBeGreaterThan(0);
			expect(JSON.parse(stdout.trim())).toEqual({
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "deny", message: "policy denied" },
				},
			});
			expect(stdout).not.toContain("permissionDecision");
		});

		it("N: generated Claude PermissionRequest ask abstains on stdout", async () => {
			const { stdout, stderr, requests } = await runAgainstDaemon(
				{ decision: "ask", reason: "confirm this call", warnings: [] },
				permissionPayload,
			);
			expect(requests.length).toBeGreaterThan(0);
			expect(stdout).toBe("");
			expect(stderr).toContain("confirm this call");
		});

		it("N: generated Claude PermissionRequest allow warnings stay off stdout", async () => {
			const { stdout, stderr, requests } = await runAgainstDaemon(
				{
					decision: "allow",
					warnings: ["advisory only"],
					additional_context: "permission context is stderr-only",
				},
				permissionPayload,
			);
			expect(requests.length).toBeGreaterThan(0);
			expect(stdout).toBe("");
			expect(stderr).toContain("advisory only");
			expect(stderr).toContain("permission context is stderr-only");
		});

		// The reviewer's finding: the response path tested `warnings.length > 0`
		// BEFORE `decision === "block"`, so this exact reply — a decision the
		// HarnessDecision type fully permits — was recorded as allow and its
		// stdout suppressed. A swallowed block is the failure this system
		// exists to prevent, so it gets a live pin against a real socket.
		it("P: a daemon block with an EMPTY warnings array still reaches the model", async () => {
			const { stdout, stderr, requests } = await runAgainstDaemon(
				{ decision: "block", reason: "Mutation evidence is unsafe", warnings: [] },
				editPayload,
			);
			// Prove the socket was actually used: a silent inline fallback would
			// otherwise satisfy a silence assertion without ever reaching here.
			expect(requests.length, `stderr=${stderr}`).toBeGreaterThan(0);
			expect(stdout.trim(), `stderr=${stderr}`).not.toBe("");
			const parsed = JSON.parse(stdout.trim());
			const spoken = String(parsed.reason ?? parsed.hookSpecificOutput?.additionalContext ?? "");
			expect(spoken).toContain("Mutation evidence is unsafe");
		});

		it("N: a clean result from a REAL answering daemon writes no stdout", async () => {
			const { stdout, stderr, requests } = await runAgainstDaemon(
				{ decision: "allow", summary: "[interlinked] all clean (12ms)", warnings: [] },
				editPayload,
			);
			// Without this the test would pass vacuously: an inline fallback that
			// never reaches the socket also prints nothing.
			expect(requests.length, `stdout=[${stdout}] stderr=[${stderr}]`).toBeGreaterThan(0);
			expect(stdout).toBe("");
		});

		// Proof the ordering fix is load-bearing: restore the pre-fix condition
		// (warning count first) and the very same block is swallowed — recorded
		// as clean, stdout empty. If this ever stops failing-when-reverted, the
		// pin above has stopped testing anything.
		it("KILL: with the pre-fix ordering the same block is silently swallowed", async () => {
			const { stdout, requests } = await runAgainstDaemon(
				{ decision: "block", reason: "Mutation evidence is unsafe", warnings: [] },
				editPayload,
				(script) =>
					script.replace(
						"if (isBlockingPostDecision || warnings.length > 0) {",
						"if (warnings.length > 0) {",
					),
			);
			expect(requests.length).toBeGreaterThan(0);
			expect(stdout).toBe("");
		});

		it("P: a daemon WARNING from a real socket still reaches the model", async () => {
			const { stdout } = await runAgainstDaemon(
				{ decision: "allow", warnings: ["[interlinked:cyclomatic] fn too complex"] },
				editPayload,
			);
			expect(stdout.trim()).not.toBe("");
			expect(stdout).toContain("cyclomatic");
		});

		// A pin that passes against the broken code is worthless. This runs the
		// generated hook with the PRE-FIX emission restored and asserts it
		// produces exactly the noise the rule forbids — so the two silence
		// tests above are proven to distinguish, not merely to pass.
		it("KILL: restoring the pre-fix emission produces the '{}' row the rule forbids", () => {
			const fixed = buildHookScript("test");
			const NEW = 'writeProviderResponse("post_success", {});';
			const OLD = 'console.log(JSON.stringify(formatProviderResponse("post_success", {})));';
			expect(fixed).toContain(NEW);
			const tempDir = mkdtempSync(join(tmpdir(), "interlinked-kill-"));
			const interlinkedDir = join(tempDir, ".interlinked");
			mkdirSync(interlinkedDir, { recursive: true });
			writeFileSync(
				join(interlinkedDir, "config.local.json"),
				JSON.stringify({ sync_mode: "local", agent_name: "kill-test" }),
			);
			writeFileSync(join(interlinkedDir, "harness.pid"), String(process.pid));
			writeFileSync(join(interlinkedDir, "harness.sock"), "");
			const scriptPath = join(tempDir, "hook.mjs");
			writeFileSync(scriptPath, fixed.replace(NEW, OLD));
			const res = spawnSync(process.execPath, [scriptPath], {
				input: JSON.stringify({
					hook_event_name: "PostToolUse",
					session_id: "kill",
					tool_name: "Read",
					tool_input: { file_path: "/etc/hosts" },
					tool_response: { ok: true },
					cwd: tempDir,
				}),
				encoding: "utf-8",
				cwd: tempDir,
				env: {
					...process.env,
					INTERLINKED_HOME: interlinkedDir,
					INTERLINKED_DATA_DIR: interlinkedDir,
					INTERLINKED_CLIENT: "codex",
				},
				timeout: 20_000,
			});
			expect(res.stdout.trim()).toBe("{}");
		});

		it("P: a PreToolUse block still writes its reason (silence must not swallow a block)", () => {
			const res = runGeneratedHook(
				{
					hook_event_name: "PreToolUse",
					session_id: "block-must-speak",
					tool_name: "Bash",
					tool_input: { command: "rm -rf /" },
				},
				"claude",
			);
			expect(res.error, `spawn failed: ${res.error}`).toBeUndefined();
			expect(res.stdout.trim()).not.toBe("");
			const parsed = JSON.parse(res.stdout.trim());
			const reason = String(parsed.hookSpecificOutput?.permissionDecisionReason ?? parsed.reason ?? "");
			expect(reason).toMatch(/BLOCKED/i);
		});

		it("P: generated-hook inline PermissionRequest block uses decision.behavior, not permissionDecision", () => {
			const res = runGeneratedHook(
				{
					hook_event_name: "PermissionRequest",
					session_id: "permission-inline-block",
					tool_name: "Bash",
					tool_input: { command: "rm -rf /" },
				},
				"claude",
			);
			expect(res.error, `spawn failed: ${res.error}`).toBeUndefined();
			expect(JSON.parse(res.stdout.trim())).toEqual({
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: {
						behavior: "deny",
						message: expect.stringMatching(/BLOCKED/i),
					},
				},
			});
			expect(res.stdout).not.toContain("permissionDecision");
		});

		it.each(["opencode", "pi"])(
			"P: the %s managed-bridge fallback detects its provider and blocks a destructive tool call",
			(client) => {
				const res = runGeneratedHook(
					{
						hook_event_name: "PreToolUse",
						session_id: `${client}-bridge-block`,
						tool_name: "Bash",
						tool_input: { command: "git worktree add ../feature feature" },
					},
					client,
				);
				expect(res.error, `spawn failed: ${res.error}`).toBeUndefined();
				const parsed = JSON.parse(res.stdout.trim());
				expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
				expect(parsed.hookSpecificOutput?.permissionDecisionReason).toMatch(
					/worktrees are disabled/i,
				);
			},
		);
	});

	it("embeds PII redaction scoped to prompt + thinking", () => {
		const out = buildHookScript("v");
		expect(out).toContain("function redactPii");
		expect(out).toContain("[REDACTED:ssn]");
		expect(out).toContain("[REDACTED:email]");
		// PII masking must be scoped to natural-language fields, never tool I/O.
		expect(out).toContain('const PII_FIELDS = ["prompt", "thinking"]');
	});

	it("captures full thinking locally (no 4000-char cap) but bounds the server copy", () => {
		const out = buildHookScript("v");
		// The local capture path must no longer reference the retired cap constant.
		expect(out).not.toContain("THINKING_MAX_LEN");
		// The server-bound realtime payload stays bounded so full reasoning
		// traces do not leave the machine ("store locally for now").
		expect(out).toContain("truncate(event.thinking, 4000)");
	});

	it("stores raw prompt + thinking faithfully in activity.jsonl (local unredacted) + full untruncated thinking", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-pii-e2e-"));
		const interlinkedDir = join(tempDir, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		writeFileSync(
			join(interlinkedDir, "config.local.json"),
			JSON.stringify({ sync_mode: "local", agent_name: "pii-test-agent" }),
		);
		// Pretend a harness is "alive" so the hook doesn't spin on retry — we
		// only care about the local write path here (mirrors the Cursor e2e).
		writeFileSync(join(interlinkedDir, "harness.pid"), String(process.pid));
		writeFileSync(join(interlinkedDir, "harness.sock"), "");

		// A transcript whose assistant thinking block exceeds the old 4000 cap
		// and carries PII — proves (a) no truncation, (b) the local write is RAW
		// (PII intact; redaction is egress-only, never applied to local capture).
		const longThinking =
			"reasoning step ".repeat(400) +
			" my ssn is 521-44-8190 and email jane.real@acme.com end";
		const transcriptPath = join(tempDir, "transcript.jsonl");
		writeFileSync(
			transcriptPath,
			`${JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "thinking", thinking: longThinking }] },
			})}\n`,
		);

		const scriptPath = join(tempDir, "hook.mjs");
		writeFileSync(scriptPath, buildHookScript("test"));

		const payload = {
			hook_event_name: "UserPromptSubmit",
			session_id: "pii-e2e-session",
			cwd: tempDir,
			transcript_path: transcriptPath,
			prompt: "reach me at 521-44-8190 or jane.real@acme.com",
		};

		const res = spawnSync(process.execPath, [scriptPath], {
			input: JSON.stringify(payload),
			encoding: "utf-8",
			cwd: tempDir,
			env: {
				...process.env,
				INTERLINKED_HOME: interlinkedDir,
				INTERLINKED_DATA_DIR: interlinkedDir,
				INTERLINKED_CLIENT: "claude",
			},
			timeout: 10_000,
		});
		expect(res.error, `spawn failed: ${res.error}`).toBeUndefined();

		const activityPath = join(interlinkedDir, "activity.jsonl");
		expect(existsSync(activityPath), `no activity.jsonl; stderr=${res.stderr}`).toBe(true);
		const records = readFileSync(activityPath, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));

		const withPrompt = records.find((r) => typeof r.prompt === "string");
		expect(withPrompt, `no prompt record; stderr=${res.stderr}; n=${records.length}`).toBeDefined();
		// Local is 100% faithful: the prompt's PII is stored RAW, not redacted.
		expect(withPrompt.prompt).toContain("521-44-8190");
		expect(withPrompt.prompt).toContain("jane.real@acme.com");
		expect(withPrompt.prompt).not.toContain("[REDACTED");

		const withThinking = records.find((r) => typeof r.thinking === "string");
		expect(withThinking, `no thinking record; stderr=${res.stderr}; n=${records.length}`).toBeDefined();
		// Full-fidelity: longer than the retired 4000-char cap, no truncation marker.
		expect(withThinking.thinking.length).toBeGreaterThan(4000);
		expect(withThinking.thinking).not.toContain("... [truncated]");
		// PII stored RAW inside the thinking trace too (egress-only redaction).
		expect(withThinking.thinking).toContain("521-44-8190");
		expect(withThinking.thinking).toContain("jane.real@acme.com");
		expect(withThinking.thinking).not.toContain("[REDACTED");
	});

	it("emits one unified activity schema_version for both record families", () => {
		const out = buildHookScript("v");
		// Single source of truth for the log-format version, used by BOTH writers:
		// appendLocal (activity events) + appendGuardDecision (guard telemetry).
		expect(out).toContain("const ACTIVITY_SCHEMA_VERSION = 5");
		expect(out).toContain("schema_version: ACTIVITY_SCHEMA_VERSION");
		// No stray hard-coded family versions remain (was activity=4 / guard=3).
		expect(out).not.toContain("schema_version: 3,");
		expect(out).not.toContain("schema_version: 4,");
		// Guard exclusion from collection.jsonl is keyed on record TYPE, not version.
		expect(out).toContain('eventType.startsWith("guard_")');
	});
});
