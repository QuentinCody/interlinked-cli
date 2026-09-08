import { outputObject, flatHookSettings, outputString } from "./test-output.js";
// Grok 2026-08-28 issue 6: an installed hook command whose baked binary path
// has disappeared (npm run clean, unbuilt clone, moved checkout) must FAIL
// CLOSED, not silently exit 0 — the old shape turned every hook into a no-op
// while the install still reported success. Proven by executing the ACTUAL
// generated command through sh, not by string inspection alone.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "./claude-code.js";
import { createCodexAdapter } from "./codex.js";
import { createCopilotCliAdapter } from "./copilot-cli.js";
import { createCursorAdapter } from "./cursor.js";
import { createGeminiCliAdapter } from "./gemini-cli.js";
import { buildDetachedHookCommand, buildHookCommand } from "./hook-command.js";
import type { RunnerAdapter } from "./types.js";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hook-cmd-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function runSh(
	command: string,
	stdin = "",
	opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { code: number; stderr: string; stdout?: string } {
	for (let attempt = 1; attempt <= 4; attempt++) {
		const result = spawnSync("sh", ["-c", command], {
			env: opts.env ?? hookSubprocessEnv(),
			...(opts.cwd ? { cwd: opts.cwd } : {}),
			input: stdin,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10_000,
		});
		if (!result.error && result.status !== null) {
			return {
				code: result.status,
				stderr: result.stderr,
				...(result.stdout ? { stdout: result.stdout } : {}),
			};
		}
		const errorCode =
			result.error && "code" in result.error && typeof result.error.code === "string"
				? result.error.code
				: null;
		if (errorCode === "EAGAIN" && attempt < 4) {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
			continue;
		}
		throw new Error(
			[
				`hook test subprocess did not complete (attempt ${attempt}/4)`,
				`error=${result.error?.message ?? "none"}`,
				`status=${String(result.status)}`,
				`signal=${String(result.signal)}`,
				`stderr=${JSON.stringify(result.stderr)}`,
			].join("; "),
		);
	}
	throw new Error("hook test subprocess retry loop exhausted");
}

function expectNativeBlock(
	result: ReturnType<typeof runSh>,
	runner: RunnerAdapter["id"],
	event: string,
): void {
	expect(result.stderr).toContain("blocking mutating or unclassified tool calls");
	if ((runner === "claude-code" || runner === "codex") && event === "PermissionRequest") {
		expect(result.code).toBe(0);
		const parsed = outputObject(JSON.parse(result.stdout ?? ""));
		expect(parsed.hookSpecificOutput).toMatchObject({
			hookEventName: "PermissionRequest",
			decision: { behavior: "deny" },
		});
		return;
	}
	if (runner === "codex") {
		expect(result.code).toBe(0);
		const parsed = outputObject(JSON.parse(result.stdout ?? ""));
		expect(outputObject(parsed.hookSpecificOutput).hookEventName).toBe(event);
		expect(outputObject(parsed.hookSpecificOutput).permissionDecision).toBe("deny");
		return;
	}
	if (runner === "copilot-cli") {
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout ?? "")).toMatchObject({ permissionDecision: "deny" });
		return;
	}
	expect(result.code).toBe(2);
}

function hookSubprocessEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	delete env.NODE_PATH;
	env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
	return env;
}

function prepareCanonicalCliCheckout(root: string): string {
	mkdirSync(join(root, "scripts"), { recursive: true });
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "interlinked-cli",
			scripts: { build: "node scripts/build-atomic-cli.mjs" },
		}),
	);
	writeFileSync(join(root, "scripts", "build-atomic-cli.mjs"), "// canonical build entry\n");
	return join(root, "dist", "hook-entry.js");
}

describe("buildHookCommand — missing runtime degrades reads and fails closed on writes", () => {
	const repair = "interlinked install-hooks --refresh --preserve-mode";
	const claudePayload = (command: string, toolName = "Bash"): string =>
		JSON.stringify({ tool_name: toolName, tool_input: { command } });

	it("P1: a MISSING binary on Claude PreToolUse exits 2 with the reason on stderr", () => {
		// Claude documents exit 2 as the emergency block path. Codex and Copilot
		// require stdout JSON instead; the rendered-fragment matrix below pins
		// those provider-specific contracts.
		const cmd = buildHookCommand(join(dir, "does-not-exist.js"), "claude-code", "PreToolUse", "fail_closed");
		const r = runSh(cmd);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("hook binary missing");
		expect(r.stderr).toContain("blocking mutating or unclassified tool calls");
		expect(r.stderr).toContain("allowing known read-only tools in degraded mode");
		// Doctor, never plain enable (2026-08-28 P1: enable rewrites mode/policy).
		// The repair steer names the SAFE command; a plain enable rewrites mode.
		expect(r.stderr).toContain("interlinked install-hooks --refresh --preserve-mode");
		expect(r.stderr).toContain("never plain 'interlinked enable'");
		expect(r.stderr).toMatch(
			/If the 'interlinked' command is unavailable, reinstall the CLI or rebuild this checkout/,
		);
		expect(r.stderr).not.toContain("Repair with 'interlinked enable'");
	});

	it("P2: a MISSING binary on PostToolUse exits 1 — loud, and honestly NON-blocking", () => {
		const r = runSh(buildHookCommand(join(dir, "does-not-exist.js"), "claude-code", "PostToolUse", "warn_open"));
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("hook skipped");
		expect(r.stderr).not.toContain("blocking");
	});

	it.each([
		{
			runner: "claude-code",
			event: "PreToolUse",
			payload: claudePayload(repair),
		},
		{
			runner: "codex",
			event: "PreToolUse",
			payload: claudePayload(repair),
		},
		{
			runner: "copilot-cli",
			event: "preToolUse",
			payload: JSON.stringify({ toolName: "shell", toolArgs: JSON.stringify({ command: repair }) }),
		},
		{
			runner: "gemini-cli",
			event: "BeforeTool",
			payload: JSON.stringify({ tool_name: "run_shell_command", arguments: { command: repair } }),
		},
		{
			runner: "cursor",
			event: "beforeShellExecution",
			payload: JSON.stringify({ command: repair }),
		},
	])("P3: $runner can run the exact repair through its native shell payload", ({ runner, event, payload }) => {
		const cmd = buildHookCommand(
			join(dir, "does-not-exist.js"),
			runner,
			event,
			"fail_closed",
		);
		const r = runSh(cmd, payload);
		expect(r).toEqual({ code: 0, stderr: "" });
	});

	it.each([
		"interlinked harness status --json",
		"node dist/index.js harness start",
		"npx tsx src/index.ts harness restart --protocol dual --session-id default",
		"interlinked doctor",
		"interlinked disable --reason daemon-memory-repair",
		"interlinked install-hooks --preserve-mode --refresh",
	])("P4: a missing runtime cannot lock out the exact operator command: %s", (command) => {
		const cmd = buildHookCommand(
			join(dir, "does-not-exist.js"),
			"claude-code",
			"PreToolUse",
			"fail_closed",
		);
		expect(runSh(cmd, claudePayload(command))).toEqual({ code: 0, stderr: "" });
	});

	it.each(["npm run build", "node scripts/build-atomic-cli.mjs"])(
		"P5: the same positively identified CLI checkout can run its exact build recovery: %s",
		(command) => {
			const binaryPath = prepareCanonicalCliCheckout(dir);
			const cmd = buildHookCommand(binaryPath, "claude-code", "PreToolUse", "fail_closed");
			expect(runSh(cmd, claudePayload(command), { cwd: dir })).toEqual({ code: 0, stderr: "" });
		},
	);

	it("P6: Codex's exec_command spelling can build the same canonical CLI checkout", () => {
		const binaryPath = prepareCanonicalCliCheckout(dir);
		const cmd = buildHookCommand(
			binaryPath,
			"codex",
			"PreToolUse",
			"fail_closed",
		);
		const payload = JSON.stringify({
			tool_name: "exec_command",
			tool_input: { command: "npm run build" },
		});
		expect(runSh(cmd, payload, { cwd: dir })).toEqual({ code: 0, stderr: "" });
	});

	it.each(["npm run build", "node scripts/build-atomic-cli.mjs"])(
		"N: an arbitrary installed repo cannot use the exact build spelling as a bypass: %s",
		(command) => {
			const foreignRoot = join(dir, "customer-app");
			mkdirSync(join(foreignRoot, "scripts"), { recursive: true });
			mkdirSync(join(foreignRoot, "dist"), { recursive: true });
			writeFileSync(
				join(foreignRoot, "package.json"),
				JSON.stringify({
					name: "customer-app",
					scripts: { build: "node scripts/build-atomic-cli.mjs" },
				}),
			);
			writeFileSync(join(foreignRoot, "scripts", "build-atomic-cli.mjs"), "// look-alike\n");
			const binaryPath = join(foreignRoot, "dist", "hook-entry.js");
			const cmd = buildHookCommand(binaryPath, "claude-code", "PreToolUse", "fail_closed");
			const result = runSh(cmd, claudePayload(command), { cwd: foreignRoot });
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("hook binary missing");
		},
	);

	it("N: the package name without the canonical build declaration cannot authorize a build", () => {
		const binaryPath = prepareCanonicalCliCheckout(dir);
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "interlinked-cli", scripts: { build: "tsx scripts/build.ts" } }),
		);
		const cmd = buildHookCommand(binaryPath, "claude-code", "PreToolUse", "fail_closed");
		expect(runSh(cmd, claudePayload("npm run build"), { cwd: dir }).code).toBe(2);
	});

	it("N: canonical metadata cannot authorize a hook binary rooted in another checkout", () => {
		prepareCanonicalCliCheckout(dir);
		const foreignBinary = join(dir, "other", "dist", "hook-entry.js");
		const cmd = buildHookCommand(foreignBinary, "claude-code", "PreToolUse", "fail_closed");
		expect(runSh(cmd, claudePayload("npm run build"), { cwd: dir }).code).toBe(2);
	});

	it.each([
		`${repair} --dry-run`,
		`echo ready && ${repair}`,
		`${repair}; echo escaped`,
		`${repair} | cat`,
		"/usr/local/bin/interlinked install-hooks --refresh --preserve-mode",
		"node /Users/example/interlinked-cli/dist/index.js harness restart",
		"interlinked harness status --short",
		"interlinked doctor --fix",
		"interlinked disable --uninstall",
		"interlinked disable --keep-config",
		"node dist/index.js harness status && echo escaped",
	])("N: a near-miss or compound repair command still blocks: %s", (nearMiss) => {
		const cmd = buildHookCommand(
			join(dir, "does-not-exist.js"),
			"claude-code",
			"PreToolUse",
			"fail_closed",
		);
		const r = runSh(cmd, claudePayload(nearMiss));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("hook binary missing");
	});

	it("N: the repair text in a non-shell tool payload still blocks", () => {
		const cmd = buildHookCommand(
			join(dir, "does-not-exist.js"),
			"claude-code",
			"PreToolUse",
			"fail_closed",
		);
		expect(runSh(cmd, claudePayload(repair, "Edit")).code).toBe(2);
	});

	it("N: a malformed payload still fails closed", () => {
		const cmd = buildHookCommand(
			join(dir, "does-not-exist.js"),
			"claude-code",
			"PreToolUse",
			"fail_closed",
		);
		expect(runSh(cmd, "{not-json").code).toBe(2);
	});

	it("P6: a known native read tool proceeds with an explicit degraded warning", () => {
		const cmd = buildHookCommand(
			join(dir, "does-not-exist.js"),
			"claude-code",
			"PreToolUse",
			"fail_closed",
		);
		const r = runSh(cmd, claudePayload("", "Read"));
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("allowing known read-only tools in degraded mode");
	});

	it.each(["Edit", "Write", "apply_patch", "unknown_new_tool"])(
		"N: a missing runtime still blocks mutating or unclassified tool %s",
		(toolName) => {
			const cmd = buildHookCommand(
				join(dir, "does-not-exist.js"),
				"claude-code",
				"PreToolUse",
				"fail_closed",
			);
			expect(runSh(cmd, claudePayload("", toolName)).code).toBe(2);
		},
	);

	it("N: warn-open events stay exit 1 even when their payload contains the repair command", () => {
		const cmd = buildHookCommand(
			join(dir, "does-not-exist.js"),
			"claude-code",
			"PostToolUse",
			"warn_open",
		);
		expect(runSh(cmd, claudePayload(repair)).code).toBe(1);
	});
});

describe("buildHookCommand — negative (present binary still runs)", () => {
	it("N1: an existing binary is executed with the runner/event args", () => {
		const bin = join(dir, "hook.js");
		// The stub proves node actually ran it with the expected args.
		writeFileSync(
			bin,
			"if (process.argv.includes('--runner') && process.argv.includes('PreToolUse')) process.exit(0); process.exit(3);\n",
		);
		const r = runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"));
		expect(r.code).toBe(0);
	});

	it("N2: quoting survives a space in the path", () => {
		const spaced = join(dir, "with space");
		rmSync(spaced, { recursive: true, force: true });
		const cmd = buildHookCommand(join(spaced, "hook.js"), "claude-code", "PreToolUse", "fail_closed");
		// Missing file under a spaced path must still be the fail-closed branch,
		// not a shell parse error swallowed by the harness.
		const r = runSh(cmd);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("hook binary missing");
	});

	it("N3: the detached (SessionEnd) variant is unchanged — silent skip stays acceptable there", () => {
		const cmd = buildDetachedHookCommand(join(dir, "gone.js"), "claude-code", "SessionEnd");
		expect(runSh(cmd).code).toBe(0);
	});
});

describe("buildHookCommand — present runtime integrity", () => {
	const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "pwd" } });
	const repairPayload = JSON.stringify({
		tool_name: "Bash",
		tool_input: { command: "interlinked install-hooks --refresh --preserve-mode" },
	});

	it("P: a healthy non-empty runtime can allow a gate event", () => {
		const bin = join(dir, "healthy.js");
		writeFileSync(bin, "process.exit(0);\n");
		expect(runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"), payload).code).toBe(0);
	});

	it("P: accepted runtime stdout is forwarded after the status is known", () => {
		const bin = join(dir, "allow-with-output.js");
		writeFileSync(bin, 'process.stdout.write(JSON.stringify({ allow: true })); process.exit(0);\n');
		const result = runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"), payload);
		expect(result).toEqual({ code: 0, stderr: "", stdout: '{"allow":true}' });
	});

	it("P: an ordinary payload starts only the runtime Node process, not the repair parser", () => {
		const bin = join(dir, "one-node-runtime.js");
		const nodeWrapper = join(dir, "node");
		const calls = join(dir, "node-calls");
		writeFileSync(bin, "process.exit(0);\n");
		writeFileSync(
			nodeWrapper,
			'#!/bin/sh\nprintf "call\\n" >> "$NODE_CALL_LOG"\nexec "$REAL_NODE" "$@"\n',
		);
		chmodSync(nodeWrapper, 0o755);
		const env: NodeJS.ProcessEnv = {
			NODE_CALL_LOG: calls,
			PATH: `${dir}:${process.env.PATH ?? ""}`,
			REAL_NODE: process.execPath,
		};
		expect(
			runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"), payload, { env }).code,
		).toBe(0);
		expect(readFileSync(calls, "utf8")).toBe("call\n");
	});

	it("P: an intentional runtime block remains exit 2 with its stderr", () => {
		const bin = join(dir, "block.js");
		writeFileSync(bin, 'process.stderr.write("policy block\\n"); process.exit(2);\n');
		const r = runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"), payload);
		expect(r.code).toBe(2);
		expect(r.stderr).toBe("policy block\n");
	});

	it("P: the exact shell repair bypasses a present runtime block before invoking it", () => {
		const bin = join(dir, "blocking-runtime.js");
		const invoked = join(dir, "runtime-was-invoked");
		writeFileSync(
			bin,
			`require("node:fs").writeFileSync(${JSON.stringify(invoked)}, "yes"); process.exit(2);\n`,
		);
		const r = runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"), repairPayload);
		expect(r).toEqual({ code: 0, stderr: "" });
		expect(existsSync(invoked)).toBe(false);
	});

	it.each(["npm run build", "node scripts/build-atomic-cli.mjs"])(
		"P: the exact build recovery '%s' bypasses a present runtime block before invoking it",
		(command) => {
			const bin = prepareCanonicalCliCheckout(dir);
			const invoked = join(dir, "build-runtime-was-invoked");
			writeFileSync(
				bin,
				`require("node:fs").writeFileSync(${JSON.stringify(invoked)}, "yes"); process.exit(2);\n`,
			);
			const buildPayload = JSON.stringify({
				tool_name: "Bash",
				tool_input: { command },
			});
			const result = runSh(
				buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"),
				buildPayload,
				{ cwd: dir },
			);
			expect(result).toEqual({ code: 0, stderr: "" });
			expect(existsSync(invoked)).toBe(false);
		},
	);

	it("P: exact checkout status bypasses a stale runtime block before invoking it", () => {
		const bin = join(dir, "blocking-stale-runtime.js");
		const invoked = join(dir, "stale-runtime-was-invoked");
		writeFileSync(
			bin,
			`require("node:fs").writeFileSync(${JSON.stringify(invoked)}, "yes"); process.exit(2);\n`,
		);
		const statusPayload = JSON.stringify({
			tool_name: "Bash",
			tool_input: { command: "node dist/index.js harness status" },
		});
		const result = runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"), statusPayload);
		expect(result).toEqual({ code: 0, stderr: "" });
		expect(existsSync(invoked)).toBe(false);
	});

	it("N: a near-miss repair still reaches and obeys a present runtime block", () => {
		const bin = join(dir, "blocking-near-miss.js");
		const invoked = join(dir, "near-miss-runtime-was-invoked");
		writeFileSync(
			bin,
			`require("node:fs").writeFileSync(${JSON.stringify(invoked)}, "yes"); process.exit(2);\n`,
		);
		const nearMiss = JSON.stringify({
			tool_name: "Bash",
			tool_input: { command: "interlinked install-hooks --refresh --preserve-mode --dry-run" },
		});
		expect(runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"), nearMiss).code).toBe(2);
		expect(existsSync(invoked)).toBe(true);
	});

	it("N: repair text in a non-shell payload still reaches and obeys a present runtime block", () => {
		const bin = join(dir, "blocking-non-shell.js");
		const invoked = join(dir, "non-shell-runtime-was-invoked");
		writeFileSync(
			bin,
			`require("node:fs").writeFileSync(${JSON.stringify(invoked)}, "yes"); process.exit(2);\n`,
		);
		const nonShell = JSON.stringify({
			tool_name: "Edit",
			tool_input: { command: "interlinked install-hooks --refresh --preserve-mode" },
		});
		expect(runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"), nonShell).code).toBe(2);
		expect(existsSync(invoked)).toBe(true);
	});

	it("N: a zero-byte runtime is missing for gate purposes and exits 2", () => {
		const bin = join(dir, "empty.js");
		writeFileSync(bin, "");
		const r = runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"), payload);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("hook binary missing or empty");
	});

	it("N: a syntax-error runtime cannot fail open on a gate event", () => {
		const bin = join(dir, "corrupt.js");
		writeFileSync(bin, "const = broken;\n");
		const r = runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"), payload);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("hook runtime failed");
	});

	it.each([
		{ runner: "codex" as const, event: "PreToolUse" },
		{ runner: "codex" as const, event: "PermissionRequest" },
		{ runner: "copilot-cli" as const, event: "preToolUse" },
	])("N: a corrupt runtime emits $runner's native deny for $event", ({ runner, event }) => {
		const bin = join(dir, `${runner}-${event}-corrupt.js`);
		writeFileSync(bin, "const = broken;\n");
		const result = runSh(buildHookCommand(bin, runner, event, "fail_closed"), payload);
		expect(result.stderr).toContain("hook runtime failed");
		expectNativeBlock(result, runner, event);
	});

	it.each([
		{
			runner: "codex" as const,
			event: "PreToolUse",
			payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo changed" } }),
		},
		{
			runner: "copilot-cli" as const,
			event: "preToolUse",
			payload: JSON.stringify({ toolName: "shell", toolArgs: { command: "echo changed" } }),
		},
	])("N: failed $runner runtime stdout is discarded before the one native deny envelope", ({ runner, event, payload }) => {
		const bin = join(dir, `${runner}-partial-output.js`);
		writeFileSync(bin, 'process.stdout.write(JSON.stringify({ allow: true })); process.exit(1);\n');
		const result = runSh(buildHookCommand(bin, runner, event, "fail_closed"), payload);
		expectNativeBlock(result, runner, event);
		expect(() => JSON.parse(result.stdout ?? "")).not.toThrow();
		expect(result.stdout).not.toContain('"allow":true');
	});

	it("N: an unexpected runtime exit cannot fail open on a gate event", () => {
		const bin = join(dir, "unexpected.js");
		writeFileSync(bin, "process.exit(7);\n");
		const r = runSh(buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"), payload);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("hook runtime failed");
	});

	it("N: the exact recovery command remains available through a corrupt runtime", () => {
		const bin = join(dir, "corrupt-repair.js");
		writeFileSync(bin, "const = broken;\n");
		const r = runSh(
			buildHookCommand(bin, "claude-code", "PreToolUse", "fail_closed"),
			repairPayload,
		);
		expect(r.code).toBe(0);
	});

	it("N: a corrupt warn-open runtime stays nonblocking with exit 1", () => {
		const bin = join(dir, "corrupt-post.js");
		writeFileSync(bin, "const = broken;\n");
		const r = runSh(buildHookCommand(bin, "claude-code", "PostToolUse", "warn_open"), payload);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("hook runtime failed");
	});

	it("N: even a runtime exit 2 is normalized to nonblocking 1 on a warn-open event", () => {
		const bin = join(dir, "post-exit-two.js");
		writeFileSync(bin, "process.exit(2);\n");
		const r = runSh(buildHookCommand(bin, "claude-code", "PostToolUse", "warn_open"), payload);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("hook runtime failed");
	});
});

// Review 2026-08-28 P0: a global PascalCase event set left Copilot's
// `preToolUse`, Gemini's `BeforeTool`, and Cursor's `beforeShellExecution`
// NON-blocking on a missing binary. This drives every adapter's REAL rendered
// settings fragment: extract the command each provider would actually install
// for its native pre-tool gate and execute it with the binary absent. Blocking
// is asserted through each provider's real contract (Codex/Copilot JSON,
// stderr+exit 2 elsewhere), not a fictitious uniform exit-code rule.
describe("every adapter's rendered pre-tool command applies the degraded fallback", () => {
	function commandsByEvent(adapter: RunnerAdapter, binaryPath: string): Map<string, string> {
		const fragment = adapter.renderSettingsFragment(binaryPath, "project");
		const out = new Map<string, string>();
		// A Set both erases the tuple literal type (no cast needed) and makes the
		// event-name membership check O(1).
		const nativeEvents = new Set<string>(adapter.nativeEventNames);
		const walk = (value: unknown, eventHint: string | null): void => {
			if (Array.isArray(value)) {
				for (const v of value) walk(v, eventHint);
				return;
			}
			if (typeof value !== "object" || value === null) return;
			for (const [k, v] of Object.entries(value)) {
				// Copilot's fragment names the shell string `bash`, the rest `command`.
				if ((k === "command" || k === "bash") && typeof v === "string" && eventHint)
					out.set(eventHint, v);
				// Fragment shapes differ per provider; the event name is always the
				// key whose subtree holds the command.
				else walk(v, nativeEvents.has(k) ? k : eventHint);
			}
		};
		walk(fragment.fragment, null);
		return out;
	}

	const CASES: Array<{ adapter: RunnerAdapter; preTool: string; nonGate: string }> = [
		{ adapter: createClaudeCodeAdapter(), preTool: "PreToolUse", nonGate: "Stop" },
		{ adapter: createCodexAdapter(), preTool: "PreToolUse", nonGate: "Stop" },
		{ adapter: createCopilotCliAdapter(), preTool: "preToolUse", nonGate: "sessionStart" },
		{ adapter: createGeminiCliAdapter(), preTool: "BeforeTool", nonGate: "AfterTool" },
		{ adapter: createCursorAdapter(), preTool: "beforeShellExecution", nonGate: "stop" },
	];

	const DEGRADED_CASES: Array<{
		adapter: RunnerAdapter;
		readEvent: string;
		readPayload: string;
		guardEvent: string;
		mutatingPayload: string;
		unknownPayload: string;
	}> = [
		{
			adapter: createClaudeCodeAdapter(),
			readEvent: "PreToolUse",
			readPayload: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/repo/a.ts" } }),
			guardEvent: "PreToolUse",
			mutatingPayload: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } }),
			unknownPayload: JSON.stringify({ tool_name: "future_writer", tool_input: {} }),
		},
		{
			adapter: createCodexAdapter(),
			readEvent: "PreToolUse",
			readPayload: JSON.stringify({ tool_name: "Grep", tool_input: { pattern: "needle" } }),
			guardEvent: "PreToolUse",
			mutatingPayload: JSON.stringify({ tool_name: "apply_patch", tool_input: { patch: "x" } }),
			unknownPayload: JSON.stringify({ tool_name: "future_writer", tool_input: {} }),
		},
		{
			adapter: createCursorAdapter(),
			readEvent: "beforeReadFile",
			readPayload: JSON.stringify({ path: "/repo/a.ts" }),
			guardEvent: "preToolUse",
			mutatingPayload: JSON.stringify({ tool_name: "write_file", tool_input: { path: "/repo/a.ts" } }),
			unknownPayload: JSON.stringify({ tool_name: "future_writer", tool_input: {} }),
		},
	];

	// Review 2026-08-28 (Grok round, finding 5): one representative event per
	// provider missed a conflicting Cursor gate definition once already. This
	// property covers EVERY Cursor fragment entry: `failClosed: true` ⇔ the
	// installed command exits 2 on a missing binary; entries without it must
	// never claim a block.
	it("property: every Cursor fragment entry's exit code matches its own failClosed flag", () => {
		const cursor = createCursorAdapter();
		const missing = join(dir, "gone.js");
		const fragment = flatHookSettings(cursor.renderSettingsFragment(missing, "project").fragment);
		const entries = Object.entries(fragment.hooks);
		expect(entries.length).toBeGreaterThan(10); // the property must not pass vacuously
		const gatedEvents: string[] = [];
		for (const [event, [entry]] of entries) {
			if (!entry) throw new Error(`no entry for ${event}`);
			const code = runSh(outputString(entry.command)).code;
			if (entry.failClosed === true) {
				gatedEvents.push(event);
				expect({ event, code }).toEqual({ event, code: 2 });
			} else {
				// EXACTLY 1 (final-round P1): exit 0 would restore the silent
				// success the fallback work exists to remove; Cursor has no
				// detached variant, so every non-gate must be the loud exit 1.
				expect({ event, code }).toEqual({ event, code: 1 });
			}
		}
		// The exact gated SET, not a count (final-round P1): swapping
		// subagentStart for sessionStart would preserve the count and pass.
		expect(gatedEvents.sort()).toEqual(
			[
				"beforeMCPExecution",
				"beforeMcpToolExecution",
				"beforeReadFile",
				"beforeShellExecution",
				"preToolUse",
				"subagentStart",
			].sort(),
		);
	});

	for (const { adapter, preTool, nonGate } of CASES) {
		it(`P: ${adapter.id} '${preTool}' emits its native block with a missing binary`, () => {
			const missing = join(dir, "gone.js");
			const commands = commandsByEvent(adapter, missing);
			const cmd = commands.get(preTool);
			if (!cmd) throw new Error(`${adapter.id} fragment has no command for ${preTool}`);
			const result = runSh(cmd);
			expect(result.stderr).toContain("hook binary missing");
			expectNativeBlock(result, adapter.id, preTool);
		});

		it(`N: ${adapter.id} '${nonGate}' does NOT claim a block (exit 0 detached or 1)`, () => {
			const missing = join(dir, "gone.js");
			const cmd = commandsByEvent(adapter, missing).get(nonGate);
			if (!cmd) throw new Error(`${adapter.id} fragment has no command for ${nonGate}`);
			expect([0, 1]).toContain(runSh(cmd).code);
		});
	}

	for (const testCase of DEGRADED_CASES) {
		it(`P: ${testCase.adapter.id} allows its real native read-only shape when the binary is missing`, () => {
			const missing = join(dir, "gone.js");
			const cmd = commandsByEvent(testCase.adapter, missing).get(testCase.readEvent);
			if (!cmd) throw new Error(`${testCase.adapter.id} fragment has no command for ${testCase.readEvent}`);
			const result = runSh(cmd, testCase.readPayload);
			expect(result.code).toBe(0);
			expect(result.stderr).toContain("known read-only tools in degraded mode");
		});

		it(`N: ${testCase.adapter.id} still blocks mutating and unknown native tools`, () => {
			const missing = join(dir, "gone.js");
			const cmd = commandsByEvent(testCase.adapter, missing).get(testCase.guardEvent);
			if (!cmd) throw new Error(`${testCase.adapter.id} fragment has no command for ${testCase.guardEvent}`);
			const mutating = runSh(cmd, testCase.mutatingPayload);
			const unknown = runSh(cmd, testCase.unknownPayload);
			expect(mutating.stderr).toContain("hook binary missing");
			expect(unknown.stderr).toContain("hook binary missing");
			expectNativeBlock(mutating, testCase.adapter.id, testCase.guardEvent);
			expectNativeBlock(unknown, testCase.adapter.id, testCase.guardEvent);
		});
	}

	it.each([
		{
			adapter: createCopilotCliAdapter(),
			event: "preToolUse",
			payload: JSON.stringify({ toolName: "read_file", toolArgs: JSON.stringify({ path: "/repo/a.ts" }) }),
		},
		{
			adapter: createGeminiCliAdapter(),
			event: "BeforeTool",
			payload: JSON.stringify({ tool_name: "read_file", tool_input: { path: "/repo/a.ts" } }),
		},
		{
			adapter: createCursorAdapter(),
			event: "preToolUse",
			payload: JSON.stringify({ tool_name: "read_file", tool_input: { path: "/repo/a.ts" } }),
		},
	])("N: $adapter.id cannot treat a generic read-like name as provider-owned", ({ adapter, event, payload }) => {
		const cmd = commandsByEvent(adapter, join(dir, "gone.js")).get(event);
		if (!cmd) throw new Error(`${adapter.id} fragment has no ${event} command`);
		const result = runSh(cmd, payload);
		expect(result.stderr).toContain("hook binary missing");
		expectNativeBlock(result, adapter.id, event);
	});

	it.each(["R-e-a-d", "mcp__filesystem__Read"])(
		"N: a look-alike/custom Claude tool name is not the reserved Read builtin: %s",
		(toolName) => {
			const adapter = createClaudeCodeAdapter();
			const cmd = commandsByEvent(adapter, join(dir, "gone.js")).get("PreToolUse");
			if (!cmd) throw new Error("Claude fragment has no PreToolUse command");
			const result = runSh(cmd, JSON.stringify({ tool_name: toolName, tool_input: {} }));
			expect(result.stderr).toContain("hook binary missing");
			expectNativeBlock(
				result,
				adapter.id,
				"PreToolUse",
			);
		},
	);

	it("N: conflicting Claude tool-name fields cannot manufacture a read allowance", () => {
		const adapter = createClaudeCodeAdapter();
		const cmd = commandsByEvent(adapter, join(dir, "gone.js")).get("PreToolUse");
		if (!cmd) throw new Error("Claude fragment has no PreToolUse command");
		const result = runSh(cmd, JSON.stringify({ tool_name: "Read", toolName: "Write", tool_input: {} }));
		expect(result.stderr).toContain("hook binary missing");
		expectNativeBlock(
			result,
			adapter.id,
			"PreToolUse",
		);
	});

	it("N: Cursor shell commands remain unclassified and fail closed even when the text looks read-only", () => {
		const cursor = createCursorAdapter();
		const cmd = commandsByEvent(cursor, join(dir, "gone.js")).get("beforeShellExecution");
		if (!cmd) throw new Error("Cursor fragment has no beforeShellExecution command");
		expect(runSh(cmd, JSON.stringify({ command: "cat README.md" })).code).toBe(2);
	});

	it("N: Codex PermissionRequest stays fail-closed even when the requested tool is read-like", () => {
		const codex = createCodexAdapter();
		const cmd = commandsByEvent(codex, join(dir, "gone.js")).get("PermissionRequest");
		if (!cmd) throw new Error("Codex fragment has no PermissionRequest command");
		const result = runSh(cmd, JSON.stringify({ tool_name: "Read", tool_input: { path: "/repo/a.ts" } }));
		expect(result.stderr).toContain("hook binary missing");
		expectNativeBlock(
			result,
			codex.id,
			"PermissionRequest",
		);
	});

	it.each(["missing", "corrupt"])(
		"N: Claude PermissionRequest stays fail-closed when the runtime is %s",
		(runtimeState) => {
			const claude = createClaudeCodeAdapter();
			const binary = join(dir, `claude-permission-${runtimeState}.js`);
			if (runtimeState === "corrupt") writeFileSync(binary, "const = broken;\n");
			const cmd = commandsByEvent(claude, binary).get("PermissionRequest");
			if (!cmd) throw new Error("Claude fragment has no PermissionRequest command");
			const result = runSh(
				cmd,
				JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo mutate" } }),
			);
			expectNativeBlock(result, claude.id, "PermissionRequest");
			expect(result.stderr).toContain(runtimeState === "missing" ? "binary missing" : "runtime failed");
		},
	);

	it.each([
		{ adapter: createClaudeCodeAdapter(), event: "WorktreeCreate" },
		{ adapter: createCursorAdapter(), event: "subagentStart" },
	])("N: $adapter.id '$event' cannot masquerade as a read-only tool gate", ({ adapter, event }) => {
		const cmd = commandsByEvent(adapter, join(dir, "gone.js")).get(event);
		if (!cmd) throw new Error(`${adapter.id} fragment has no ${event} command`);
		expect(runSh(cmd, JSON.stringify({ tool_name: "Read", tool_input: {} })).code).toBe(2);
	});
});
