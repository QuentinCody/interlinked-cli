import { parseWire, wireArray, wireBoolean, wireNullable, wireObject, wireString } from "../lib/value-validation.js";
// ===========================================
// Behavioral tests for `interlinked env`
// ===========================================
// envCommand is a self-contained command handler: it reads process.env,
// formats via ../lib/formatter.js + ../lib/output.js, and writes to
// console.log. No fs / network / subprocess / time. We mock the formatter
// boundary to identity functions so asserted output strings are stable
// regardless of NO_COLOR/CI/TTY, drive process.env deterministically, spy
// console.log, and exercise every output mode + branch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the formatter so color/structure helpers are deterministic identities.
// output.ts is left real (pure switch over the render fns) so we test the
// genuine json/short/normal/full routing.
vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		green: (s: string) => `GREEN(${s})`,
		cyan: (s: string) => `CYAN(${s})`,
	},
	header: (s: string) => `HEADER(${s})`,
	kvLine: (k: string, v: string) => `KV(${k}=${v})`,
}));

import { envCommand } from "./env.js";

// Every INTERLINKED_* var envCommand documents — cleared before each test so
// the "no overrides" branches are reachable and set-value tests are isolated.
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
] as const;

let logSpy: ReturnType<typeof vi.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	vi.restoreAllMocks();
});

function lastLog(): string {
	return parseWire(logSpy.mock.calls.at(-1)?.[0], wireString, "test JSON value");
}

describe("envCommand — JSON mode", () => {
	it("emits one entry per supported var with is_set/value reflecting process.env", async () => {
		process.env.INTERLINKED_SERVER_URL = "http://localhost:8787";
		process.env.INTERLINKED_TOKEN = "secret-token";

		await envCommand({ json: true });

		expect(logSpy).toHaveBeenCalledTimes(1);
		const parsed = parseWire(JSON.parse(lastLog()), wireArray(wireObject({ "name": wireString, "description": wireString, "example": wireString, "is_set": wireBoolean, "value": wireNullable(wireString) })), "test JSON value");

		// All 11 documented vars present, descriptions + examples carried through.
		expect(parsed).toHaveLength(ENV_KEYS.length);
		expect(parsed.map((e) => e.name)).toEqual([...ENV_KEYS]);

		const url = parsed.find((e) => e.name === "INTERLINKED_SERVER_URL");
		expect(url).toMatchObject({
			description: "Server URL (overrides config.json)",
			example: "http://localhost:8787",
			is_set: true,
			value: "http://localhost:8787",
		});

		// Set-but-via-alias branch: is_set true + value set.
		const token = parsed.find((e) => e.name === "INTERLINKED_TOKEN");
		expect(token).toMatchObject({ is_set: true, value: "secret-token" });

		// Unset branch: is_set false, value coerced to null (|| null).
		const unset = parsed.find((e) => e.name === "INTERLINKED_HOME");
		expect(unset).toMatchObject({ is_set: false, value: null });
	});

	it("reports every var unset as is_set:false / value:null when env is empty", async () => {
		await envCommand({ json: true });
		const parsed = parseWire(JSON.parse(lastLog()), wireArray(wireObject({ is_set: wireBoolean, value: wireNullable(wireString) })), "environment report");
		expect(parsed.every((e) => e.is_set === false && e.value === null)).toBe(true);
	});
});

describe("envCommand — short mode", () => {
	it("returns the no-vars sentinel when nothing is set (setVars.length === 0)", async () => {
		await envCommand({ short: true });
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(lastLog()).toBe("No Interlinked env vars set.");
	});

	it("joins set vars as NAME=value pairs when some are set", async () => {
		process.env.INTERLINKED_AGENT_NAME = "my-agent";
		process.env.INTERLINKED_SYNC_MODE = "local";

		await envCommand({ short: true });

		// Preserves declaration order; only set vars appear; comma-joined.
		expect(lastLog()).toBe(
			"INTERLINKED_AGENT_NAME=my-agent, INTERLINKED_SYNC_MODE=local",
		);
	});
});

describe("envCommand — normal mode", () => {
	it("shows 'no overrides active' when nothing is set, plus the full catalog", async () => {
		await envCommand({});
		const out = lastLog();

		expect(out).toContain("Interlinked CLI — Environment Variables");
		// Else branch of the active-overrides conditional.
		expect(out).toContain("No environment overrides active.");
		expect(out).not.toContain("HEADER(Active Overrides)");

		// Catalog still rendered for every var, all marked not set.
		expect(out).toContain("HEADER(All Supported Variables)");
		expect(out).toContain("CYAN(INTERLINKED_SERVER_URL) not set");
		expect(out).toContain("Example: http://localhost:8787");
		// SET marker (green) must not appear for any var.
		expect(out).not.toContain("GREEN(SET)");
		expect(out).toContain(
			"Use these for CI/headless environments where interactive setup isn't possible.",
		);
	});

	it("masks TOKEN/ACCESS values and shows plain values for others in Active Overrides", async () => {
		process.env.INTERLINKED_ACCESS_TOKEN = "abcdefghIJKLMNOP"; // ACCESS + TOKEN -> masked
		process.env.INTERLINKED_TOKEN = "tok_1234567890"; // TOKEN -> masked
		process.env.INTERLINKED_SERVER_URL = "http://localhost:8787"; // plain

		await envCommand({});
		const out = lastLog();

		// Active-overrides header present (setVars.length > 0 branch).
		expect(out).toContain("HEADER(Active Overrides)");

		// Masking ternary (true side): first 8 chars + "..." wrapped in green via kvLine.
		expect(out).toContain("KV(INTERLINKED_ACCESS_TOKEN=GREEN(abcdefgh...))");
		expect(out).toContain("KV(INTERLINKED_TOKEN=GREEN(tok_1234...))");

		// Masking ternary (false side): full value, no truncation.
		expect(out).toContain(
			"KV(INTERLINKED_SERVER_URL=GREEN(http://localhost:8787))",
		);

		// And the catalog marks set vars with the green SET status.
		expect(out).toContain("CYAN(INTERLINKED_SERVER_URL) GREEN(SET)");
		expect(out).toContain("CYAN(INTERLINKED_HOME) not set");
	});
});

describe("envCommand — full mode", () => {
	it("falls back to the normal renderer (no dedicated full renderer)", async () => {
		process.env.INTERLINKED_SYNC_MODE = "realtime";

		await envCommand({ full: true });
		const out = lastLog();

		// Identical surface to normal mode: headers + catalog present.
		expect(out).toContain("Interlinked CLI — Environment Variables");
		expect(out).toContain("HEADER(Active Overrides)");
		expect(out).toContain("KV(INTERLINKED_SYNC_MODE=GREEN(realtime))");
		expect(out).toContain("HEADER(All Supported Variables)");
	});
});
