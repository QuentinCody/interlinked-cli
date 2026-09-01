import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envCommand } from "./env.js";

const ENV_KEYS = [
	"INTERLINKED_SERVER_URL",
	"INTERLINKED_ACCESS_TOKEN",
	"INTERLINKED_TOKEN",
	"INTERLINKED_AGENT_NAME",
	"INTERLINKED_AGENT",
	"INTERLINKED_WORKSPACE_ID",
	"INTERLINKED_SYNC_MODE",
	"INTERLINKED_DATA_DIR",
	"INTERLINKED_HOME",
	"INTERLINKED_MCP_PREFIX",
	"INTERLINKED_CLIENTS",
];

let savedEnv: Record<string, string | undefined>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	savedEnv = {};
	for (const k of [...ENV_KEYS, "NO_COLOR", "CI"]) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	// Force plain (non-ANSI) output so string assertions are stable.
	process.env.NO_COLOR = "1";
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	logSpy.mockRestore();
});

// Strip ANSI escape codes for stable assertions.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function lastLog(): string {
	const calls = logSpy.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	return String(calls[calls.length - 1]?.[0]).replace(ANSI_RE, "");
}

describe("envCommand — json mode descriptions/examples", () => {
	it("emits exact description and example text for every var", async () => {
		await envCommand({ json: true });
		const parsed = JSON.parse(lastLog());
		const byName = Object.fromEntries(parsed.map((v: any) => [v.name, v]));

		expect(byName.INTERLINKED_ACCESS_TOKEN.description).toBe(
			"OAuth access token (overrides config.local.json)",
		);
		expect(byName.INTERLINKED_ACCESS_TOKEN.example).toBe("eyJ...");
		expect(byName.INTERLINKED_TOKEN.description).toBe("Alias for INTERLINKED_ACCESS_TOKEN");
		expect(byName.INTERLINKED_TOKEN.example).toBe("eyJ...");
		expect(byName.INTERLINKED_AGENT_NAME.description).toBe(
			"Agent name (overrides config.local.json)",
		);
		expect(byName.INTERLINKED_AGENT_NAME.example).toBe("my-agent");
		expect(byName.INTERLINKED_AGENT.description).toBe("Alias for INTERLINKED_AGENT_NAME");
		expect(byName.INTERLINKED_AGENT.example).toBe("my-agent");
		expect(byName.INTERLINKED_WORKSPACE_ID.description).toBe("Workspace UUID (ws_... format)");
		expect(byName.INTERLINKED_WORKSPACE_ID.example).toBe("ws_abc123def456789");
		expect(byName.INTERLINKED_SYNC_MODE.description).toBe(
			"Sync mode: realtime (default), local, manual",
		);
		expect(byName.INTERLINKED_SYNC_MODE.example).toBe("realtime");
		expect(byName.INTERLINKED_DATA_DIR.description).toBe(
			"Override data directory for activity logs and sessions",
		);
		expect(byName.INTERLINKED_DATA_DIR.example).toBe("/tmp/interlinked-data");
		expect(byName.INTERLINKED_HOME.description).toBe(
			"Override config directory (default: .interlinked/)",
		);
		expect(byName.INTERLINKED_HOME.example).toBe("/home/user/.interlinked");
		expect(byName.INTERLINKED_MCP_PREFIX.description).toBe(
			"MCP server name prefix for credential lookup",
		);
		expect(byName.INTERLINKED_MCP_PREFIX.example).toBe("Interlinked-local");
		expect(byName.INTERLINKED_CLIENTS.description).toBe(
			"Comma-separated list of clients for non-interactive bootstrap",
		);
		expect(byName.INTERLINKED_CLIENTS.example).toBe(
			"claude,copilot,gemini,codex,cursor,opencode,opencode2,pi",
		);
	});
});

describe("envCommand — normal mode structural literals", () => {
	it("prints a 40-char dash separator (not empty)", async () => {
		await envCommand({});
		const text = lastLog();
		expect(text).toContain("─".repeat(40));
	});

	it("does not start with an injected stray array element", async () => {
		await envCommand({});
		const text = lastLog();
		expect(text).not.toContain("Stryker was here");
		expect(text.startsWith("Interlinked CLI — Environment Variables")).toBe(true);
	});

	it("prints a real blank line before the closing hint (not a stray literal)", async () => {
		await envCommand({});
		const text = lastLog();
		const lines = text.split("\n");
		const hintIdx = lines.findIndex((l) => l.includes("Use these for CI/headless"));
		expect(hintIdx).toBeGreaterThan(0);
		expect(lines[hintIdx - 1]).toBe("");
		expect(text).not.toContain("Stryker was here!");
	});

	it("prints each variable's description under 'All Supported Variables'", async () => {
		await envCommand({});
		const text = lastLog();
		expect(text).toContain("MCP server name prefix for credential lookup");
		expect(text).toContain("Comma-separated list of clients for non-interactive bootstrap");
	});

	it("prints the description line under Active Overrides when a var is set", async () => {
		process.env.INTERLINKED_WORKSPACE_ID = "ws_test123";
		await envCommand({});
		const text = lastLog();
		expect(text).toContain("Active Overrides");
		expect(text).toContain("    Workspace UUID (ws_... format)");
	});
});
