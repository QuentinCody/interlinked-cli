import { parseWire, wireRecord, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// interlinked context — behavioral tests
// ===========================================
// Exercises every branch of contextCommand: the not-configured early
// return, all four output modes (json / short / normal / full), the
// token-source ternary, hook stale / not-installed / current states,
// env-var override detection (incl. each alias), client detection,
// agent-handle truncation, expired-token rendering, and the
// readFileSync catch path inside detectInstalledHookVersion.
//
// Module boundaries (../lib/* + node:fs) are mocked via vi.mock with
// deterministic returns. The real ../lib/output.js dispatcher is kept
// (it's pure mode→console.log routing) so assertions hit genuine output
// strings. ../lib/formatter.js is stubbed to identity-ish helpers so the
// asserted text is ANSI-free and stable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- mocks for module boundaries ------------------------------------------

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
vi.mock("node:fs", () => ({
	existsSync: (...a: unknown[]) => mockExistsSync(...a),
	readFileSync: (...a: unknown[]) => mockReadFileSync(...a),
}));

const mockResolveAuthToken = vi.fn();
vi.mock("../lib/auth.js", () => ({
	resolveAuthToken: (...a: unknown[]) => mockResolveAuthToken(...a),
}));

const mockGetActiveServerKey = vi.fn();
const mockGetConfigDir = vi.fn();
const mockGetDataDir = vi.fn();
const mockIsConfigured = vi.fn();
const mockReadLocalConfig = vi.fn();
const mockReadSharedConfig = vi.fn();
const mockResolveConfig = vi.fn();
vi.mock("../lib/config.js", () => ({
	getActiveServerKey: (...a: unknown[]) => mockGetActiveServerKey(...a),
	getConfigDir: (...a: unknown[]) => mockGetConfigDir(...a),
	getDataDir: (...a: unknown[]) => mockGetDataDir(...a),
	isConfigured: (...a: unknown[]) => mockIsConfigured(...a),
	readLocalConfig: (...a: unknown[]) => mockReadLocalConfig(...a),
	readSharedConfig: (...a: unknown[]) => mockReadSharedConfig(...a),
	resolveConfig: (...a: unknown[]) => mockResolveConfig(...a),
}));

// Identity-ish formatter so asserted strings are deterministic & ANSI-free.
vi.mock("../lib/formatter.js", () => {
	const id = (s: string) => s;
	return {
		c: {
			bold: id,
			dim: id,
			cyan: id,
			green: id,
			yellow: id,
			red: id,
		},
		header: (t: string) => `## ${t}`,
		kvLine: (k: string, v: string) => `${k}: ${v}`,
	};
});

const mockGetHookScriptPath = vi.fn();
vi.mock("../lib/hooks.js", () => ({
	getHookScriptPath: (...a: unknown[]) => mockGetHookScriptPath(...a),
	HOOK_SCRIPT_VERSION: "9.9.9",
}));

const mockDetectClients = vi.fn();
vi.mock("../lib/settings.js", () => ({
	detectClients: (...a: unknown[]) => mockDetectClients(...a),
}));

// Real output dispatcher (pure mode → console routing). NOT mocked.
import { contextCommand } from "./context.js";

// ---- shared fixtures / spies ----------------------------------------------

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
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
];
let savedEnv: Record<string, string | undefined>;

function baseConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		server_url: "https://example.com",
		workspace_id: "ws-123",
		default_workspace_key: "wkey",
		agent_name: "agent-x",
		agent_handle: undefined,
		token_expires_at: undefined,
		default_project: "proj",
		sync_mode: "realtime",
		...over,
	};
}

/** Wire all mocks to a "happy path" populated state; tests override per-case. */
function primePopulated(cfg: Record<string, unknown> = baseConfig()): void {
	mockIsConfigured.mockReturnValue(true);
	mockResolveConfig.mockReturnValue(cfg);
	mockReadSharedConfig.mockReturnValue({});
	mockReadLocalConfig.mockReturnValue({});
	mockGetActiveServerKey.mockReturnValue("default");
	mockDetectClients.mockReturnValue([
		{ name: "claude", settingsPath: "/x", exists: true },
		{ name: "codex", settingsPath: "/y", exists: false },
	]);
	mockResolveAuthToken.mockReturnValue("tok-abc");
	mockGetConfigDir.mockReturnValue("/cfg");
	mockGetDataDir.mockReturnValue("/data");
	mockGetHookScriptPath.mockReturnValue("/hook.mjs");
	// hook installed, version current (matches HOOK_SCRIPT_VERSION mock)
	mockExistsSync.mockReturnValue(true);
	mockReadFileSync.mockReturnValue("// interlinked-hook-version: 9.9.9\n");
}

/** First console.log call argument parsed as JSON. */
function loggedJson(): Record<string, unknown> {
	return JSON.parse(String(logSpy.mock.calls[0]?.[0]));
}

/** Concatenated console.log output (joined by newline). */
function loggedText(): string {
	return logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("Unexpected process.exit"); });
	process.exitCode = 0;
	// Snapshot + clear env so override-detection branches are deterministic.
	savedEnv = {};
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	exitSpy.mockRestore();
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	process.exitCode = 0;
});

// ===========================================
// Not configured — early return branch
// ===========================================

describe("contextCommand: not configured", () => {
	it("emits outputError and returns without touching config (normal mode)", async () => {
		mockIsConfigured.mockReturnValue(false);

		await contextCommand({});

		expect(mockIsConfigured).toHaveBeenCalledOnce();
		expect(errSpy).toHaveBeenCalledWith("Error: Not configured. Run: interlinked enable");
		expect(process.exitCode).toBe(1);
		// Early return: never reached resolveConfig / console.log.
		expect(mockResolveConfig).not.toHaveBeenCalled();
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("emits structured error in json mode", async () => {
		mockIsConfigured.mockReturnValue(false);

		await contextCommand({ json: true });

		const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
		expect(parsed.error).toBe("Not configured. Run: interlinked enable");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// JSON mode — full data object branch
// ===========================================

describe("contextCommand: json mode", () => {
	it("serializes the complete data object with all derived fields", async () => {
		primePopulated(
			baseConfig({
				server_url: "https://prod.example.com",
				agent_handle: "abcdefghijklmnopqrstuvwxyz",
				token_expires_at: "2099-01-01T00:00:00Z",
			}),
		);

		await contextCommand({ json: true });

		const out = loggedJson();
		expect(out.server_url).toBe("https://prod.example.com");
		expect(out.is_local).toBe(false);
		expect(out.workspace_id).toBe("ws-123");
		expect(out.workspace_key).toBe("wkey");
		expect(out.project_key).toBe("proj");
		expect(out.agent_name).toBe("agent-x");
		// agent_handle truncated to first 12 chars + "..."
		expect(out.agent_handle).toBe("abcdefghijkl...");
		expect(out.sync_mode).toBe("realtime");
		expect(out.active_server).toBe("default");
		expect(out.auth).toEqual({
			has_token: true,
			token_source: "Claude Code credentials",
			expires_at: "2099-01-01T00:00:00Z",
		});
		expect(out.hooks).toEqual({
			installed_version: "9.9.9",
			current_version: "9.9.9",
			// A sentinel with no `+mode-` suffix has no baked mode to report.
			// `stale` now compares the sentinel's VERSION part, so a bare
			// `9.9.9` still reads as current instead of the old comparison that
			// marked every mode-suffixed install stale.
			installed_mode: null,
			stale: false,
		});
		expect(out).toHaveProperty(["clients","detected"], ["claude"]);
		expect(out).toHaveProperty(["clients","all"], [
			{ name: "claude", installed: true },
			{ name: "codex", installed: false },
		]);
		expect(out.paths).toEqual({ config_dir: "/cfg", data_dir: "/data" });
		expect(out.env_overrides).toEqual([]);
	});

	it("nulls optional fields when config values are falsy (?? / || branches)", async () => {
		primePopulated(
			baseConfig({
				workspace_id: undefined,
				default_workspace_key: undefined,
				agent_name: undefined,
				agent_handle: undefined,
				default_project: undefined,
				token_expires_at: undefined,
			}),
		);

		await contextCommand({ json: true });

		const out = loggedJson();
		expect(out.workspace_id).toBeNull();
		// `|| "main"` fallbacks
		expect(out.workspace_key).toBe("main");
		expect(out.project_key).toBe("main");
		expect(out.agent_name).toBeNull();
		expect(out.agent_handle).toBeNull();
		expect((parseWire(out.auth, wireRecord(wireUnknown), "test JSON value")).expires_at).toBeNull();
		expect(out).toHaveProperty(["hooks","installed_version"], "9.9.9");
	});
});

// ===========================================
// Auth token-source ternary — all three arms
// ===========================================

describe("contextCommand: token_source ternary", () => {
	it("'config.local.json' when config.access_token present", async () => {
		primePopulated(baseConfig({ access_token: "cfg-token" }));
		mockResolveAuthToken.mockReturnValue("anything");

		await contextCommand({ json: true });
		const auth = parseWire(loggedJson().auth, wireRecord(wireUnknown), "test JSON value");
		expect(auth.token_source).toBe("config.local.json");
		expect(auth.has_token).toBe(true);
	});

	it("'Claude Code credentials' when no config token but resolveAuthToken returns one", async () => {
		primePopulated(baseConfig()); // no access_token on config
		mockResolveAuthToken.mockReturnValue("cc-token");

		await contextCommand({ json: true });
		const auth = parseWire(loggedJson().auth, wireRecord(wireUnknown), "test JSON value");
		expect(auth.token_source).toBe("Claude Code credentials");
	});

	it("'none' when no token anywhere", async () => {
		primePopulated(baseConfig());
		mockResolveAuthToken.mockReturnValue(null);

		await contextCommand({ json: true });
		const auth = parseWire(loggedJson().auth, wireRecord(wireUnknown), "test JSON value");
		expect(auth.token_source).toBe("none");
		expect(auth.has_token).toBe(false);
	});
});

// ===========================================
// is_local detection — localhost / 127.0.0.1 / production
// ===========================================

describe("contextCommand: is_local detection", () => {
	it.each([
		["http://localhost:8787", true],
		["http://127.0.0.1:8787", true],
		["https://prod.example.com", false],
	] as const)("%s -> is_local=%s", async (url, expected) => {
		primePopulated(baseConfig({ server_url: url }));
		await contextCommand({ json: true });
		expect(loggedJson().is_local).toBe(expected);
	});
});

// ===========================================
// Hook version detection branches
// ===========================================

describe("contextCommand: hook version (json reflects detect result)", () => {
	it("null when hook file does not exist", async () => {
		primePopulated();
		mockExistsSync.mockReturnValue(false);

		await contextCommand({ json: true });
		const hooks = parseWire(loggedJson().hooks, wireRecord(wireUnknown), "test JSON value");
		expect(hooks.installed_version).toBeNull();
		// stale is false when installed is null (short-circuit on `!== null`)
		expect(hooks.stale).toBe(false);
		// readFileSync never reached when file absent
		expect(mockReadFileSync).not.toHaveBeenCalled();
	});

	it("'unknown' when sentinel not found in file content", async () => {
		primePopulated();
		mockReadFileSync.mockReturnValue("no sentinel here");

		await contextCommand({ json: true });
		const hooks = parseWire(loggedJson().hooks, wireRecord(wireUnknown), "test JSON value");
		expect(hooks.installed_version).toBe("unknown");
		// "unknown" !== "9.9.9" -> stale true
		expect(hooks.stale).toBe(true);
	});

	it("captures full sentinel including +mode suffix", async () => {
		primePopulated();
		mockReadFileSync.mockReturnValue("// interlinked-hook-version: 0.1.0+mode-budget\n");

		await contextCommand({ json: true });
		const hooks = parseWire(loggedJson().hooks, wireRecord(wireUnknown), "test JSON value");
		expect(hooks.installed_version).toBe("0.1.0+mode-budget");
		expect(hooks.stale).toBe(true);
	});

	it("null when readFileSync throws (catch path)", async () => {
		primePopulated();
		mockReadFileSync.mockImplementation(() => {
			throw new Error("EACCES");
		});

		await contextCommand({ json: true });
		const hooks = parseWire(loggedJson().hooks, wireRecord(wireUnknown), "test JSON value");
		expect(hooks.installed_version).toBeNull();
		expect(hooks.stale).toBe(false);
	});

	it("stale=false when installed matches current", async () => {
		primePopulated();
		mockReadFileSync.mockReturnValue("interlinked-hook-version: 9.9.9");

		await contextCommand({ json: true });
		const hooks = parseWire(loggedJson().hooks, wireRecord(wireUnknown), "test JSON value");
		expect(hooks.stale).toBe(false);
	});
});

// ===========================================
// Env-var override detection — each branch + alias
// ===========================================

describe("contextCommand: env_overrides", () => {
	it("collects all override keys (primary names)", async () => {
		primePopulated();
		process.env.INTERLINKED_SERVER_URL = "x";
		process.env.INTERLINKED_ACCESS_TOKEN = "x";
		process.env.INTERLINKED_AGENT_NAME = "x";
		process.env.INTERLINKED_WORKSPACE_ID = "x";
		process.env.INTERLINKED_SYNC_MODE = "x";
		process.env.INTERLINKED_DATA_DIR = "x";
		process.env.INTERLINKED_HOME = "x";

		await contextCommand({ json: true });
		expect(loggedJson().env_overrides).toEqual([
			"INTERLINKED_SERVER_URL",
			"INTERLINKED_ACCESS_TOKEN",
			"INTERLINKED_AGENT_NAME",
			"INTERLINKED_WORKSPACE_ID",
			"INTERLINKED_SYNC_MODE",
			"INTERLINKED_DATA_DIR",
			"INTERLINKED_HOME",
		]);
	});

	it("recognizes alias env vars (|| right-hand operands)", async () => {
		primePopulated();
		// Only the alias forms set — exercises the || fallback in each check.
		process.env.INTERLINKED_TOKEN = "x";
		process.env.INTERLINKED_AGENT = "x";

		await contextCommand({ json: true });
		expect(loggedJson().env_overrides).toEqual([
			"INTERLINKED_ACCESS_TOKEN",
			"INTERLINKED_AGENT_NAME",
		]);
	});

	it("empty when no env vars set", async () => {
		primePopulated();
		await contextCommand({ json: true });
		expect(loggedJson().env_overrides).toEqual([]);
	});
});

// ===========================================
// Short mode — pipe-joined summary
// ===========================================

describe("contextCommand: short mode", () => {
	it("joins server / agent / auth:ok / sync, no hooks:STALE when current", async () => {
		primePopulated(baseConfig({ server_url: "https://s", agent_name: "ag" }));
		mockResolveAuthToken.mockReturnValue("tok");

		await contextCommand({ short: true });

		expect(logSpy).toHaveBeenCalledOnce();
		expect(logSpy.mock.calls[0]?.[0]).toBe("https://s | ag | auth:ok | sync:realtime");
	});

	it("uses no-agent + auth:none fallbacks and appends hooks:STALE when stale", async () => {
		primePopulated(baseConfig({ agent_name: undefined }));
		mockResolveAuthToken.mockReturnValue(null);
		mockReadFileSync.mockReturnValue("interlinked-hook-version: 1.0.0"); // != 9.9.9 -> stale

		await contextCommand({ short: true });

		expect(logSpy.mock.calls[0]?.[0]).toBe(
			"https://example.com | no-agent | auth:none | sync:realtime | hooks:STALE",
		);
	});
});

// ===========================================
// Normal mode — rendered sections
// ===========================================

describe("contextCommand: normal mode", () => {
	it("renders all sections with production server + authenticated + current hook", async () => {
		primePopulated(baseConfig({ server_url: "https://prod" }));
		mockResolveAuthToken.mockReturnValue("tok");

		await contextCommand({});

		const text = loggedText();
		expect(text).toContain("Interlinked CLI — Effective Context");
		expect(text).toContain("## Server");
		expect(text).toContain("URL: https://prod");
		expect(text).toContain("Type: production");
		expect(text).toContain("Active server key: default");
		expect(text).toContain("## Identity");
		expect(text).toContain("Agent name: agent-x");
		expect(text).toContain("Workspace ID: ws-123");
		expect(text).toContain("Workspace key: wkey");
		expect(text).toContain("Project key: proj");
		expect(text).toContain("## Authentication");
		expect(text).toContain("Status: authenticated");
		expect(text).toContain("Token source: Claude Code credentials");
		expect(text).toContain("## Hooks");
		expect(text).toContain("Installed version: 9.9.9 (current)");
		expect(text).toContain("## Clients");
		expect(text).toContain("claude: detected");
		expect(text).toContain("codex: not found");
		expect(text).toContain("## Sync");
		expect(text).toContain("Mode: realtime");
		expect(text).toContain("Config dir: /cfg");
		expect(text).toContain("Data dir: /data");
		// No env overrides set -> section omitted
		expect(text).not.toContain("## Environment Overrides");
	});

	it("renders local type, not-set fallbacks, agent-handle line, not-authenticated", async () => {
		primePopulated(
			baseConfig({
				server_url: "http://localhost:1234",
				agent_name: undefined,
				agent_handle: "handle1234567890abcdef",
				workspace_id: undefined,
				default_workspace_key: undefined,
				default_project: undefined,
			}),
		);
		mockResolveAuthToken.mockReturnValue(null);

		await contextCommand({});

		const text = loggedText();
		expect(text).toContain("Type: local");
		expect(text).toContain(
			"Agent name: not set (run: interlinked attach --agent <name>)",
		);
		// agent_handle truncated to 20 chars + "..." in normal mode
		expect(text).toContain("Agent handle: handle1234567890abcd...");
		expect(text).toContain("Workspace ID: not set");
		expect(text).toContain("Workspace key: main");
		expect(text).toContain("Project key: main");
		expect(text).toContain("Status: not authenticated");
		expect(text).toContain("Token source: none");
	});

	it("renders 'not installed' hook line when no hook file", async () => {
		primePopulated(baseConfig());
		mockExistsSync.mockReturnValue(false);

		await contextCommand({});

		const text = loggedText();
		expect(text).toContain("Status: not installed (run: interlinked enable)");
		expect(text).not.toContain("Installed version:");
	});

	it("renders stale hook upgrade hint when installed != current", async () => {
		primePopulated(baseConfig());
		mockReadFileSync.mockReturnValue("interlinked-hook-version: 1.0.0");

		await contextCommand({});

		const text = loggedText();
		expect(text).toContain(
			"Installed version: 1.0.0 → 9.9.9 available (run: interlinked enable)",
		);
	});

	it("renders Environment Overrides section when env vars present", async () => {
		primePopulated(baseConfig());
		process.env.INTERLINKED_SERVER_URL = "x";
		process.env.INTERLINKED_HOME = "x";

		await contextCommand({});

		const text = loggedText();
		expect(text).toContain("## Environment Overrides");
		expect(text).toContain("INTERLINKED_SERVER_URL");
		expect(text).toContain("INTERLINKED_HOME");
	});

	it("renders non-expired token expiry as-is", async () => {
		primePopulated(baseConfig({ token_expires_at: "2099-12-31T00:00:00Z" }));
		mockResolveAuthToken.mockReturnValue("tok");

		await contextCommand({});

		const text = loggedText();
		expect(text).toContain("Expires: 2099-12-31T00:00:00Z");
		expect(text).not.toContain("(EXPIRED)");
	});

	it("renders expired token with (EXPIRED) marker", async () => {
		primePopulated(baseConfig({ token_expires_at: "2000-01-01T00:00:00Z" }));
		mockResolveAuthToken.mockReturnValue("tok");

		await contextCommand({});

		const text = loggedText();
		expect(text).toContain("Expires: 2000-01-01T00:00:00Z (EXPIRED)");
	});
});

// ===========================================
// Full mode — falls through to normal renderer (no `full` renderer defined)
// ===========================================

describe("contextCommand: full mode", () => {
	it("uses the normal renderer (output() full -> normal fallback)", async () => {
		primePopulated(baseConfig({ server_url: "https://prod" }));
		mockResolveAuthToken.mockReturnValue("tok");

		await contextCommand({ full: true });

		const text = loggedText();
		// Same rich output as normal mode.
		expect(text).toContain("Interlinked CLI — Effective Context");
		expect(text).toContain("## Server");
		expect(text).toContain("URL: https://prod");
	});
});
