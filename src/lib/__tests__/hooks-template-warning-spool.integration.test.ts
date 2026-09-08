import { isJsonObject } from "../json-types.js";
import { parseWire } from "../value-validation.js";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUDGET_MODE } from "../../harness/rules/modes.js";
import { buildHookScript } from "../hooks-template.js";

interface HookRun {
	status: number | null;
	stdout: string;
	stderr: string;
}

interface Fixture {
	root: string;
	interlinkedDir: string;
	scriptPath: string;
	socketPath: string;
}

const roots: string[] = [];
const servers: Server[] = [];

function fixture(postTimeoutMs = BUDGET_MODE.post_timeout_ms): Fixture {
	// Keep the Unix socket path below macOS's 104-byte sockaddr_un limit.
	const root = mkdtempSync(join(tmpdir(), "il-"));
	roots.push(root);
	const interlinkedDir = join(root, ".interlinked");
	mkdirSync(interlinkedDir, { recursive: true });
	writeFileSync(
		join(interlinkedDir, "config.local.json"),
		JSON.stringify({ sync_mode: "local", agent_name: "warning-spool-test" }),
	);
	const scriptPath = join(root, "hook.mjs");
	writeFileSync(
		scriptPath,
		buildHookScript("warning-spool-test", { ...BUDGET_MODE, post_timeout_ms: postTimeoutMs }),
	);
	return {
		root,
		interlinkedDir,
		scriptPath,
		socketPath: join(interlinkedDir, "harness.sock"),
	};
}

async function listen(
	fx: Fixture,
	handle: (request: Record<string, unknown>, reply: (value: unknown) => void) => void,
): Promise<void> {
	const server = createServer((socket) => {
		let received = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			received += chunk;
			const newline = received.indexOf("\n");
			if (newline < 0) return;
			const request = parseWire(JSON.parse(received.slice(0, newline)), isJsonObject, "hook request object");
			handle(request, (value) => socket.end(`${JSON.stringify(value)}\n`));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(fx.socketPath, resolve);
	});
}

function runHook(fx: Fixture, payload: Record<string, unknown>): Promise<HookRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [fx.scriptPath], {
			cwd: fx.root,
			env: {
				...process.env,
				INTERLINKED_HOME: fx.interlinkedDir,
				INTERLINKED_DATA_DIR: fx.interlinkedDir,
				INTERLINKED_CLIENT: "claude",
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
		child.once("error", reject);
		child.once("close", (status) => resolve({ status, stdout, stderr }));
		child.stdin.end(JSON.stringify({ cwd: fx.root, ...payload }));
	});
}

function prePayload(sessionId: string): Record<string, unknown> {
	return {
		hook_event_name: "PreToolUse",
		session_id: sessionId,
		tool_name: "Bash",
		tool_input: { command: "echo ok" },
	};
}

function readyRecord(token: string, sessionId: string, warning: string, producedAt: string): string {
	return JSON.stringify({
		version: 1,
		token,
		session_id: sessionId,
		produced_at: producedAt,
		warnings: [warning],
	});
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("generated hook request-owned warning spool", () => {
	it("acknowledges a synchronous modern PostTool warning before the next PreTool", async () => {
		const fx = fixture();
		const warning = "[interlinked:typescript] direct warning";
		let deliveryToken = "";
		await listen(fx, (request, reply) => {
			if (request.hook_event !== "PostToolUse") {
				reply({ decision: "allow", warnings: [] });
				return;
			}
			deliveryToken = String(request.post_delivery_token ?? "");
			const spoolDir = join(fx.interlinkedDir, "quality-warning-spool");
			mkdirSync(spoolDir, { recursive: true });
			writeFileSync(
				join(spoolDir, `${deliveryToken}.active.json`),
				JSON.stringify({
					version: 1,
					token: deliveryToken,
					session_id: "modern-session",
					started_at: new Date().toISOString(),
					client_pid: request.post_delivery_pid,
				}),
			);
			writeFileSync(
				join(spoolDir, `${deliveryToken}.ready.json`),
				readyRecord(deliveryToken, "modern-session", warning, new Date().toISOString()),
			);
			// Simulate a rolling-upgrade old daemon writing the retired shared
			// file as well as returning the warning synchronously.
			writeFileSync(
				join(fx.interlinkedDir, "pending-quality-warnings.json"),
				JSON.stringify([warning]),
			);
			reply({ decision: "allow", warnings: [warning] });
		});

		const post = await runHook(fx, {
			hook_event_name: "PostToolUse",
			session_id: "modern-session",
			tool_name: "Write",
			tool_input: { file_path: join(fx.root, "a.ts"), content: "export const a = 1;" },
			tool_response: {},
		});
		expect(post.status, post.stderr).toBe(0);
		expect(deliveryToken).toMatch(/^[a-zA-Z0-9_-]{16,128}$/);
		expect(post.stdout).toContain("direct warning");
		expect(
			existsSync(join(fx.interlinkedDir, "quality-warning-spool", `${deliveryToken}.ready.json`)),
		).toBe(false);
		expect(
			existsSync(join(fx.interlinkedDir, "quality-warning-spool", `${deliveryToken}.active.json`)),
		).toBe(false);
		expect(existsSync(join(fx.interlinkedDir, "pending-quality-warnings.json"))).toBe(false);

		const pre = await runHook(fx, prePayload("modern-session"));
		expect(pre.status, pre.stderr).toBe(0);
		expect(pre.stderr).not.toContain("direct warning");
	});

	it("delivers a timed-out PostTool warning once on the next PreTool", async () => {
		const fx = fixture(50);
		const warning = "[interlinked:typescript] late warning";
		await listen(fx, (request, reply) => {
			if (request.hook_event !== "PostToolUse") {
				reply({ decision: "allow", warnings: [] });
				return;
			}
			const token = String(request.post_delivery_token ?? "");
			const spoolDir = join(fx.interlinkedDir, "quality-warning-spool");
			mkdirSync(spoolDir, { recursive: true });
			const activePath = join(spoolDir, `${token}.active.json`);
			writeFileSync(
				activePath,
				JSON.stringify({ version: 1, token, session_id: "late-session", started_at: new Date().toISOString() }),
			);
			setTimeout(() => {
				writeFileSync(
					join(spoolDir, `${token}.ready.json`),
					readyRecord(token, "late-session", warning, new Date().toISOString()),
				);
				unlinkSync(activePath);
				reply({ decision: "allow", warnings: [warning] });
			}, 100);
		});

		const post = await runHook(fx, {
			hook_event_name: "PostToolUse",
			session_id: "late-session",
			tool_name: "Bash",
			tool_input: { command: "echo ok" },
			tool_response: { exit_code: 0 },
		});
		expect(post.status, post.stderr).toBe(0);
		expect(post.stdout).toBe("");
		await new Promise((resolve) => setTimeout(resolve, 400));

		const firstPre = await runHook(fx, prePayload("late-session"));
		expect(firstPre.stderr).toContain("late warning");
		const secondPre = await runHook(fx, prePayload("late-session"));
		expect(secondPre.stderr).not.toContain("late warning");
	});

	it("claims mixed legacy and modern records exactly once across overlapping PreTool hooks", async () => {
		const fx = fixture();
		const warning = "[interlinked:typescript] one warning";
		const spoolDir = join(fx.interlinkedDir, "quality-warning-spool");
		mkdirSync(spoolDir, { recursive: true });
		writeFileSync(
			join(spoolDir, "overlap-token-001.ready.json"),
			readyRecord(
				"overlap-token-001",
				"overlap-session",
				warning,
				new Date(Date.now() - 1_000).toISOString(),
			),
		);
		writeFileSync(join(fx.interlinkedDir, "pending-quality-warnings.json"), JSON.stringify([warning]));
		await listen(fx, (_request, reply) => reply({ decision: "allow", warnings: [] }));

		const [first, second] = await Promise.all([
			runHook(fx, prePayload("overlap-session")),
			runHook(fx, prePayload("overlap-session")),
		]);
		const combined = first.stderr + second.stderr;
		expect(combined.match(/one warning/g)).toHaveLength(1);
		expect(existsSync(join(spoolDir, "overlap-token-001.ready.json"))).toBe(false);
		expect(existsSync(join(fx.interlinkedDir, "pending-quality-warnings.json"))).toBe(false);
	});

	it("does not force-unlink a live marker or speak for a clean request", async () => {
		const fx = fixture();
		const spoolDir = join(fx.interlinkedDir, "quality-warning-spool");
		mkdirSync(spoolDir, { recursive: true });
		const activePath = join(spoolDir, "live-marker-token.active.json");
		writeFileSync(
			activePath,
			JSON.stringify({
				version: 1,
				token: "live-marker-token",
				session_id: "live-session",
				started_at: new Date().toISOString(),
				client_pid: process.pid,
			}),
		);
		const legacyPath = join(fx.interlinkedDir, "pending-quality-warnings.json");
		writeFileSync(legacyPath, JSON.stringify(["[interlinked:test] in-flight warning"]));
		await listen(fx, (_request, reply) => reply({ decision: "allow", warnings: [] }));

		const pre = await runHook(fx, prePayload("live-session"));
		expect(pre.status, pre.stderr).toBe(0);
		expect(pre.stderr).toBe("");
		expect(existsSync(activePath)).toBe(true);
		expect(existsSync(legacyPath)).toBe(true);

		// Once the request completes, the request-owned record and rolling-upgrade
		// legacy copy are claimed together and spoken exactly once.
		unlinkSync(activePath);
		writeFileSync(
			join(spoolDir, "live-marker-token.ready.json"),
			readyRecord(
				"live-marker-token",
				"live-session",
				"[interlinked:test] in-flight warning",
				new Date(Date.now() - 1_000).toISOString(),
			),
		);
		const delivered = await runHook(fx, prePayload("live-session"));
		const cleanAgain = await runHook(fx, prePayload("live-session"));
		expect(delivered.stderr.match(/in-flight warning/g)).toHaveLength(1);
		expect(cleanAgain.stderr).not.toContain("in-flight warning");
	});

	it("discards a stale ready record silently instead of replaying it", async () => {
		const fx = fixture();
		const spoolDir = join(fx.interlinkedDir, "quality-warning-spool");
		mkdirSync(spoolDir, { recursive: true });
		const readyPath = join(spoolDir, "stale-token-0001.ready.json");
		writeFileSync(
			readyPath,
			readyRecord("stale-token-0001", "stale-session", "stale warning", "2020-01-01T00:00:00.000Z"),
		);
		await listen(fx, (_request, reply) => reply({ decision: "allow", warnings: [] }));

		const pre = await runHook(fx, prePayload("stale-session"));
		expect(pre.status, pre.stderr).toBe(0);
		expect(pre.stderr).toBe("");
		expect(existsSync(readyPath)).toBe(false);
	});
});
