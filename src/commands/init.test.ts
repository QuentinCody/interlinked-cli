import { parseWire, wireRecord, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// interlinked init — behavioral coverage
// ===========================================
// Deep behavioral tests for initCommand. Every module boundary that
// touches fs / network / subprocess / readline is mocked so each branch
// is driven deterministically with no real I/O. We assert real rendered
// output strings, side-effects (config / hook writes, login + harness
// calls), JSON payloads, and every conditional branch:
//   --dry-run (json + human), --json, --yes / autoConfirm, TTY prompts,
//   server resolution (flag / env / reachable-probe / fallback),
//   agent-name resolution (flag / env / prompt / USER fallback),
//   client detection (some / none), per-client install (ok / error),
//   auth (already-authed / env-token / interactive / skip-no-tty / local),
//   onboarding (linked-new / linked-reconnect / skipped / failed),
//   health check (reachable + agents / reachable no-agents / unreachable),
//   harness (already-running / start-ok / start-fail / decline / prompt).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- node:fs mock: virtual git-config existence + contents -------------
let fsExists: Set<string>;
let fsFiles: Record<string, string>;
let fsReadThrows: Set<string>;

vi.mock("node:fs", () => ({
	existsSync: (p: string) => fsExists.has(p),
	readFileSync: (p: string) => {
		if (fsReadThrows.has(p)) throw new Error(`EACCES ${p}`);
		if (!(p in fsFiles)) throw new Error(`ENOENT ${p}`);
		return fsFiles[p];
	},
}));

// ---- node:readline/promises mock: scripted answers --------------------
// Each createInterface() consumes the next queued answer for its
// single question() call. close() is a no-op.
let rlAnswers: string[];
const rlQuestions: string[] = [];
vi.mock("node:readline/promises", () => ({
	createInterface: () => ({
		question: (prompt: string) => {
			rlQuestions.push(prompt);
			return Promise.resolve(rlAnswers.length ? (nonNull(rlAnswers.shift())) : "");
		},
		close: () => {},
	}),
}));

// ---- formatter mock: identity colors so output is plain ----------------
vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		green: (s: string) => s,
		yellow: (s: string) => s,
		cyan: (s: string) => s,
		red: (s: string) => s,
	},
}));

// ---- lib boundary mocks ------------------------------------------------
vi.mock("../lib/auth.js", () => ({ resolveAuthToken: vi.fn() }));
vi.mock("../lib/config.js", () => ({
	initConfig: vi.fn(),
	updateLocalConfig: vi.fn(),
}));
vi.mock("../lib/onboarding.js", () => ({ ensureRemoteOnboarding: vi.fn() }));
vi.mock("../lib/settings.js", () => ({ detectClients: vi.fn() }));
vi.mock("../lib/hooks.js", () => ({
	HOOK_SCRIPT_VERSION: "9.9.9",
	findProjectRoot: vi.fn(),
	installAllHooks: vi.fn(),
	writeHookScript: vi.fn(),
}));
vi.mock("./harness.js", () => ({
	harnessStartCommand: vi.fn(),
	isHarnessRunning: vi.fn(),
}));
vi.mock("./login.js", () => ({ loginCommand: vi.fn() }));

// ---- dynamic import boundary: ../lib/api-client.js --------------------
// initCommand does `await import("../lib/api-client.js")` for the health
// check. The constructor records its options; callTool is scripted per
// tool name so we can drive reachable / agents / throw branches.
const clientCtorCalls: unknown[][] = [];
let callToolImpl: (name: string, args?: unknown) => Promise<unknown>;
vi.mock("../lib/api-client.js", () => ({
	InterlinkedClient: class {
		constructor(opts: unknown) {
			clientCtorCalls.push([opts]);
		}
		callTool(name: string, args?: unknown) {
			return callToolImpl(name, args);
		}
	},
}));

import { resolveAuthToken } from "../lib/auth.js";
import { initConfig, updateLocalConfig } from "../lib/config.js";
import {
	findProjectRoot,
	HOOK_SCRIPT_VERSION,
	installAllHooks,
	writeHookScript,
} from "../lib/hooks.js";
import { nonNull } from "../lib/non-null.js";
import { ensureRemoteOnboarding } from "../lib/onboarding.js";
import { detectClients } from "../lib/settings.js";
import { harnessStartCommand, isHarnessRunning } from "./harness.js";
import { initCommand } from "./init.js";
import { loginCommand } from "./login.js";

const mocks = {
	resolveAuthToken: vi.mocked(resolveAuthToken),
	initConfig: vi.mocked(initConfig),
	updateLocalConfig: vi.mocked(updateLocalConfig),
	findProjectRoot: vi.mocked(findProjectRoot),
	installAllHooks: vi.mocked(installAllHooks),
	writeHookScript: vi.mocked(writeHookScript),
	ensureRemoteOnboarding: vi.mocked(ensureRemoteOnboarding),
	detectClients: vi.mocked(detectClients),
	harnessStartCommand: vi.mocked(harnessStartCommand),
	isHarnessRunning: vi.mocked(isHarnessRunning),
	loginCommand: vi.mocked(loginCommand),
};

// ---- console + tty + env + fetch harness ------------------------------
let logSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.fn>;
const FIXED_CWD = "/repo";
const origStdinTty = process.stdin.isTTY;
const origStdoutTty = process.stdout.isTTY;
const origEnv = { ...process.env };

// Join every console.log arg-0 across calls. Typed param (unknown[][]) so
// the map callback has an explicit type under noImplicitAny.
function joinCalls(calls: unknown[][]): string {
	return calls.map((call) => String(call[0])).join("\n");
}
function logged(): string {
	return joinCalls(logSpy.mock.calls);
}
// In json mode every human banner / step line is guarded by `!isJson`, so
// the only thing logged is the single JSON payload — parse that last line.
function loggedJson(): Record<string, unknown> {
	const calls = logSpy.mock.calls;
	const last = calls.at(-1);
	if (!last) throw new Error("nothing logged");
	return parseWire(JSON.parse(String(last[0])), wireRecord(wireUnknown), "test JSON value");
}

function setTty(on: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
}

beforeEach(() => {
	fsExists = new Set();
	fsFiles = {};
	fsReadThrows = new Set();
	rlAnswers = [];
	rlQuestions.length = 0;
	clientCtorCalls.length = 0;
	vi.clearAllMocks();

	vi.spyOn(process, "cwd").mockReturnValue(FIXED_CWD);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

	// fetch is only used by the reachability probe (no --server / env).
	fetchSpy = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
	vi.stubGlobal("fetch", fetchSpy);

	// Default deterministic environment: non-TTY (autoConfirm true), no env
	// overrides for server / agent / token, a stable USER.
	setTty(false);
	for (const k of Object.keys(process.env)) {
		if (k.startsWith("INTERLINKED_")) delete process.env[k];
	}
	process.env.USER = "alice";
	delete process.env.USERNAME;

	// Sensible defaults; individual tests override.
	mocks.detectClients.mockReturnValue([]);
	mocks.findProjectRoot.mockReturnValue(null);
	mocks.resolveAuthToken.mockReturnValue(null);
	mocks.installAllHooks.mockReturnValue([]);
	mocks.writeHookScript.mockReturnValue("/repo/.interlinked/hooks/interlinked-activity.mjs");
	mocks.ensureRemoteOnboarding.mockResolvedValue({
		status: "skipped",
		reason: "not_authenticated",
	});
	mocks.isHarnessRunning.mockReturnValue({ running: false });
	mocks.harnessStartCommand.mockResolvedValue(undefined);
	mocks.loginCommand.mockResolvedValue(undefined);
	// Default health check: server unreachable (callTool throws).
	callToolImpl = () => Promise.reject(new Error("ECONNREFUSED"));
});

afterEach(() => {
	vi.unstubAllGlobals();
	Object.defineProperty(process.stdin, "isTTY", { value: origStdinTty, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTty, configurable: true });
	for (const k of Object.keys(process.env)) {
		if (k.startsWith("INTERLINKED_")) delete process.env[k];
	}
	for (const [k, v] of Object.entries(origEnv)) process.env[k] = v;
	vi.restoreAllMocks();
});

// =======================================================================
// Module export
// =======================================================================
describe("init command module", () => {
	it("exports initCommand as a function", () => {
		expect(typeof initCommand).toBe("function");
	});
});

// =======================================================================
// --dry-run
// =======================================================================
describe("initCommand --dry-run", () => {
	it("human dry-run prints banner + 'no changes made' and writes nothing", async () => {
		await initCommand({ "dry-run": true, server: "https://srv.example" });
		const out = logged();
		expect(out).toContain("Interlinked CLI — Quick Setup");
		expect(out).toContain("Dry run — no changes made.");
		expect(out).toContain("Would install hooks, configure, and authenticate.");
		// No mutation occurred.
		expect(mocks.initConfig).not.toHaveBeenCalled();
		expect(mocks.writeHookScript).not.toHaveBeenCalled();
		expect(mocks.installAllHooks).not.toHaveBeenCalled();
		expect(mocks.ensureRemoteOnboarding).not.toHaveBeenCalled();
	});

	it("json dry-run emits a single dry_run payload with resolved fields", async () => {
		mocks.detectClients.mockReturnValue([
			{ name: "claude", exists: true, settingsPath: "/repo/.claude/settings.json" },
			{ name: "gemini", exists: false, settingsPath: "/repo/.gemini/settings.json" },
		]);
		mocks.findProjectRoot.mockReturnValue("/repo");
		// git config present → project derived from remote url
		fsExists.add("/repo/.git/config");
		fsFiles["/repo/.git/config"] = "[remote]\n  url = git@github.com:user/cool-proj.git\n";

		await initCommand({
			"dry-run": true,
			json: true,
			server: "https://srv.example",
			agent: "bot-1",
			"sync-mode": "manual",
		});

		const payload = loggedJson();
		expect(payload).toEqual({
			dry_run: true,
			server_url: "https://srv.example",
			agent_name: "bot-1",
			project: "cool-proj",
			sync_mode: "manual",
			detected_clients: ["claude"], // only exists:true survives the filter
			hook_version: HOOK_SCRIPT_VERSION,
		});
		// json mode prints exactly one line (the payload) — no banner.
		expect(logSpy).toHaveBeenCalledTimes(1);
	});
});

// =======================================================================
// Server resolution
// =======================================================================
describe("server resolution", () => {
	it("uses --server flag verbatim and labels production for non-local", async () => {
		await initCommand({ "dry-run": true, server: "https://api.interlinked.dev" });
		expect(logged()).toContain("Server: https://api.interlinked.dev");
		expect(logged()).toContain("(production)");
		expect(fetchSpy).not.toHaveBeenCalled(); // flag short-circuits the probe
	});

	it("uses INTERLINKED_SERVER_URL when no flag given", async () => {
		process.env.INTERLINKED_SERVER_URL = "https://env-server.example";
		await initCommand({ "dry-run": true });
		expect(logged()).toContain("Server: https://env-server.example");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("probes localhost and selects it as local dev server when reachable", async () => {
		fetchSpy.mockResolvedValue(new Response(null));
		await initCommand({ "dry-run": true });
		expect(fetchSpy).toHaveBeenCalledWith(
			"http://localhost:8787/health",
			expect.objectContaining({ signal: expect.anything() }),
		);
		expect(logged()).toContain("Server: http://localhost:8787");
		expect(logged()).toContain("(local dev server)");
	});

	it("falls back to the remote default when the localhost probe rejects", async () => {
		// fetch rejects → isServerReachable catch → false. Both DEFAULT_LOCAL
		// and DEFAULT_REMOTE are localhost:8787, so the fallback branch is
		// exercised and still resolves to localhost.
		fetchSpy.mockRejectedValue(new Error("refused"));
		await initCommand({ "dry-run": true });
		expect(logged()).toContain("Server: http://localhost:8787");
	});

	it("treats a non-ok health response as unreachable in the probe", async () => {
		fetchSpy.mockResolvedValue(new Response(null, { status: 503 }));
		await initCommand({ "dry-run": true });
		// res.ok false → reachable false → still falls back to localhost default
		expect(logged()).toContain("Server: http://localhost:8787");
	});

	it("aborts the reachability probe on timeout and falls back", async () => {
		// fetch hangs until its AbortSignal fires; advancing fake timers past
		// SERVER_REACHABLE_TIMEOUT_MS triggers the setTimeout(abort) callback,
		// which rejects the awaited fetch → caught → unreachable.
		vi.useFakeTimers();
		try {
			fetchSpy.mockImplementation(
				(_url: string, init: { signal: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						init.signal.addEventListener("abort", () =>
							reject(new DOMException("aborted", "AbortError")),
						);
					}),
			);
			const p = initCommand({ "dry-run": true });
			await vi.advanceTimersByTimeAsync(2000); // SERVER_REACHABLE_TIMEOUT_MS
			await p;
		} finally {
			vi.useRealTimers();
		}
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(logged()).toContain("Server: http://localhost:8787");
	});
});

// =======================================================================
// Client detection + project context (human output)
// =======================================================================
describe("client detection + project context", () => {
	it("lists detected clients and the derived git project + root", async () => {
		mocks.detectClients.mockReturnValue([
			{ name: "claude", exists: true, settingsPath: "/repo/.claude/settings.json" },
			{ name: "codex", exists: true, settingsPath: "/repo/.codex/settings.json" },
			{ name: "cursor", exists: false, settingsPath: "/repo/.cursor/settings.json" },
		]);
		mocks.findProjectRoot.mockReturnValue("/repo");
		fsExists.add("/repo/.git/config");
		fsFiles["/repo/.git/config"] = "  url = https://github.com/acme/widget.git\n";

		await initCommand({ "dry-run": true, server: "https://s" });
		const out = logged();
		expect(out).toContain("Detecting AI clients...");
		expect(out).toContain("claude");
		expect(out).toContain("codex");
		expect(out).not.toContain("\ncursor"); // exists:false filtered out
		expect(out).toContain("Git project: widget");
		expect(out).toContain("Root: /repo");
	});

	it("reports no clients and no git repo when nothing is detected", async () => {
		mocks.detectClients.mockReturnValue([]);
		mocks.findProjectRoot.mockReturnValue(null);
		await initCommand({ "dry-run": true, server: "https://s" });
		const out = logged();
		expect(out).toContain("No AI client directories found.");
		expect(out).toContain("No git repository detected.");
	});

	it("falls back to the directory basename when git config is absent", async () => {
		mocks.findProjectRoot.mockReturnValue("/home/me/myrepo");
		// no .git/config in fsExists → existsSync false → basename fallback
		await initCommand({
			"dry-run": true,
			json: true,
			server: "https://s",
			agent: "a",
		});
		expect(loggedJson().project).toBe("myrepo");
	});

	it("falls back to basename when git config read throws", async () => {
		mocks.findProjectRoot.mockReturnValue("/home/me/throwrepo");
		fsExists.add("/home/me/throwrepo/.git/config");
		fsReadThrows.add("/home/me/throwrepo/.git/config");
		await initCommand({
			"dry-run": true,
			json: true,
			server: "https://s",
			agent: "a",
		});
		expect(loggedJson().project).toBe("throwrepo");
	});

	it("falls back to basename when git config has no url line", async () => {
		mocks.findProjectRoot.mockReturnValue("/x/nourl");
		fsExists.add("/x/nourl/.git/config");
		fsFiles["/x/nourl/.git/config"] = "[core]\n  bare = false\n";
		await initCommand({
			"dry-run": true,
			json: true,
			server: "https://s",
			agent: "a",
		});
		expect(loggedJson().project).toBe("nourl");
	});

	it("falls back to basename when the url matches no repo pattern", async () => {
		// A url ending in a slash makes the repo-name regex fail → repoMatch null.
		mocks.findProjectRoot.mockReturnValue("/x/weird");
		fsExists.add("/x/weird/.git/config");
		fsFiles["/x/weird/.git/config"] = "  url = https://example.com/\n";
		await initCommand({
			"dry-run": true,
			json: true,
			server: "https://s",
			agent: "a",
		});
		expect(loggedJson().project).toBe("weird");
	});

	it("project is null when no project root is found at all", async () => {
		mocks.findProjectRoot.mockReturnValue(null);
		await initCommand({
			"dry-run": true,
			json: true,
			server: "https://s",
			agent: "a",
		});
		expect(loggedJson().project).toBe(null);
	});
});

// =======================================================================
// Agent name resolution
// =======================================================================
describe("agent name resolution", () => {
	it("prefers the --agent flag", async () => {
		await initCommand({ "dry-run": true, json: true, server: "https://s", agent: "flagbot" });
		expect(loggedJson().agent_name).toBe("flagbot");
	});

	it("uses INTERLINKED_AGENT_NAME env when no flag", async () => {
		process.env.INTERLINKED_AGENT_NAME = "envbot";
		await initCommand({ "dry-run": true, json: true, server: "https://s" });
		expect(loggedJson().agent_name).toBe("envbot");
	});

	it("uses INTERLINKED_AGENT env as a secondary source", async () => {
		process.env.INTERLINKED_AGENT = "envbot2";
		await initCommand({ "dry-run": true, json: true, server: "https://s" });
		expect(loggedJson().agent_name).toBe("envbot2");
	});

	it("derives USER-<firstClient> when no flag/env and a client is detected", async () => {
		mocks.detectClients.mockReturnValue([{ name: "gemini", exists: true, settingsPath: "/repo/.gemini/settings.json" }]);
		await initCommand({ "dry-run": true, json: true, server: "https://s" });
		expect(loggedJson().agent_name).toBe("alice-gemini");
	});

	it("derives USER-cli when no clients are detected", async () => {
		mocks.detectClients.mockReturnValue([]);
		await initCommand({ "dry-run": true, json: true, server: "https://s" });
		expect(loggedJson().agent_name).toBe("alice-cli");
	});

	it("uses USERNAME when USER is unset", async () => {
		delete process.env.USER;
		process.env.USERNAME = "winuser";
		await initCommand({ "dry-run": true, json: true, server: "https://s" });
		expect(loggedJson().agent_name).toBe("winuser-cli");
	});

	it("falls back to 'agent-cli' when USER/USERNAME are both unset", async () => {
		delete process.env.USER;
		delete process.env.USERNAME;
		await initCommand({ "dry-run": true, json: true, server: "https://s" });
		expect(loggedJson().agent_name).toBe("agent-cli");
	});

	it("prompts interactively for agent name on TTY and trims the answer", async () => {
		setTty(true);
		rlAnswers = ["  promptbot  "];
		// TTY path runs the full flow; keep it short by using a local server
		// (skips auth) and an already-running harness.
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 42 });
		await initCommand({ server: "http://localhost:8787", json: true });
		expect(rlQuestions.some((q) => q.includes("Agent name"))).toBe(true);
		expect(loggedJson().agent_name).toBe("promptbot");
	});

	it("keeps the suggested name when the interactive answer is blank", async () => {
		setTty(true);
		rlAnswers = ["   "]; // whitespace → falsy after trim → keep suggestion
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 7 });
		mocks.detectClients.mockReturnValue([{ name: "claude", exists: true, settingsPath: "/repo/.claude/settings.json" }]);
		await initCommand({ server: "http://localhost:8787", json: true });
		expect(loggedJson().agent_name).toBe("alice-claude");
	});

	it("does not prompt when --agent is supplied even on a TTY", async () => {
		setTty(true);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		await initCommand({ server: "http://localhost:8787", json: true, agent: "given" });
		expect(rlQuestions.some((q) => q.includes("Agent name"))).toBe(false);
		expect(loggedJson().agent_name).toBe("given");
	});

	it("does not prompt for agent name when --yes is passed on a TTY", async () => {
		setTty(true);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 2 });
		mocks.detectClients.mockReturnValue([{ name: "codex", exists: true, settingsPath: "/repo/.codex/settings.json" }]);
		await initCommand({ server: "http://localhost:8787", json: true, yes: true });
		expect(rlQuestions.some((q) => q.includes("Agent name"))).toBe(false);
		expect(loggedJson().agent_name).toBe("alice-codex");
	});

	it("echoes the agent name (non-prompt) in human non-TTY output", async () => {
		setTty(false);
		await initCommand({ "dry-run": true, server: "https://s", agent: "shownbot" });
		expect(logged()).toContain("Agent name: shownbot");
	});
});

// =======================================================================
// Sync mode
// =======================================================================
describe("sync mode", () => {
	it("rejects an invalid sync mode before writing configuration", async () => {
		await expect(initCommand({ server: "https://s", agent: "a", yes: true, "sync-mode": "bogus" })).rejects.toThrow("Invalid --sync-mode: bogus");
		expect(mocks.initConfig).not.toHaveBeenCalled();
		expect(mocks.updateLocalConfig).not.toHaveBeenCalled();
	});

	it("defaults to realtime", async () => {
		await initCommand({ "dry-run": true, json: true, server: "https://s", agent: "a" });
		expect(loggedJson().sync_mode).toBe("realtime");
	});

	it("honors --sync-mode", async () => {
		await initCommand({
			"dry-run": true,
			json: true,
			server: "https://s",
			agent: "a",
			"sync-mode": "local",
		});
		expect(loggedJson().sync_mode).toBe("local");
	});
});

// =======================================================================
// Full install path: config + hooks (non-dry-run)
// =======================================================================
describe("install: config + hooks", () => {
	it("writes config + hook script and reports per-client install results", async () => {
		mocks.detectClients.mockReturnValue([
			{ name: "claude", exists: true, settingsPath: "/repo/.claude/settings.json" },
			{ name: "gemini", exists: true, settingsPath: "/repo/.gemini/settings.json" },
		]);
		mocks.installAllHooks.mockReturnValue([
			{ client: "claude", installed: true, events: ["PreToolUse", "PostToolUse"] },
			{ client: "gemini", installed: false, events: [], error: "no settings file" },
		]);
		await initCommand({ server: "https://s", agent: "bot" });

		// Config writes carry the resolved server / agent / sync mode + cwd.
		expect(mocks.initConfig).toHaveBeenCalledWith(
			{ serverUrl: "https://s", agentName: "bot" },
			FIXED_CWD,
		);
		expect(mocks.updateLocalConfig).toHaveBeenCalledWith({ sync_mode: "realtime" }, FIXED_CWD);
		expect(mocks.writeHookScript).toHaveBeenCalledWith(FIXED_CWD);
		expect(mocks.installAllHooks).toHaveBeenCalledWith(FIXED_CWD, ["claude", "gemini"]);

		const out = logged();
		expect(out).toContain("Config written to .interlinked/");
		expect(out).toContain(`Hook script v${HOOK_SCRIPT_VERSION}`);
		expect(out).toContain("claude hooks (2 events)");
		expect(out).toContain("gemini: no settings file");
	});

	it("skips installAllHooks entirely when no clients are detected", async () => {
		mocks.detectClients.mockReturnValue([]);
		await initCommand({ server: "https://s", agent: "bot" });
		expect(mocks.installAllHooks).not.toHaveBeenCalled();
		// config + hook script still written, with the resolved server/agent/cwd
		expect(mocks.initConfig).toHaveBeenCalledWith(
			{ serverUrl: "https://s", agentName: "bot" },
			FIXED_CWD,
		);
		expect(mocks.writeHookScript).toHaveBeenCalledWith(FIXED_CWD);
	});

	it("suppresses per-client install lines in json mode", async () => {
		mocks.detectClients.mockReturnValue([{ name: "claude", exists: true, settingsPath: "/repo/.claude/settings.json" }]);
		mocks.installAllHooks.mockReturnValue([
			{ client: "claude", installed: true, events: ["PreToolUse"] },
		]);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 3 });
		await initCommand({ json: true, server: "https://s", agent: "bot" });
		// installAllHooks still runs, but nothing human is logged.
		expect(mocks.installAllHooks).toHaveBeenCalledTimes(1);
		expect(logged()).not.toContain("hooks (");
	});
});

// =======================================================================
// Authentication branch
// =======================================================================
describe("authentication", () => {
	it("reports already-authenticated and skips login when a token resolves", async () => {
		mocks.resolveAuthToken.mockReturnValue("tok-123");
		await initCommand({ server: "https://remote.example", agent: "a" });
		expect(logged()).toContain("already authenticated");
		expect(mocks.loginCommand).not.toHaveBeenCalled();
	});

	it("logs in with an env token when unauthenticated against a remote server", async () => {
		mocks.resolveAuthToken.mockReturnValue(null);
		process.env.INTERLINKED_TOKEN = "env-tok";
		await initCommand({ server: "https://remote.example", agent: "a" });
		expect(mocks.loginCommand).toHaveBeenCalledWith({
			server: "https://remote.example",
			token: "env-tok",
		});
	});

	it("reads INTERLINKED_ACCESS_TOKEN as the secondary env token source", async () => {
		mocks.resolveAuthToken.mockReturnValue(null);
		process.env.INTERLINKED_ACCESS_TOKEN = "access-tok";
		await initCommand({ server: "https://remote.example", agent: "a" });
		expect(mocks.loginCommand).toHaveBeenCalledWith({
			server: "https://remote.example",
			token: "access-tok",
		});
	});

	it("runs interactive login (no token arg) on a TTY with no env token", async () => {
		setTty(true);
		mocks.resolveAuthToken.mockReturnValue(null);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 9 });
		// answer the harness prompt blank (accept); agent given → no name prompt
		rlAnswers = [""];
		await initCommand({ server: "https://remote.example", agent: "a" });
		expect(mocks.loginCommand).toHaveBeenCalledWith({ server: "https://remote.example" });
	});

	it("skips auth with a no-TTY notice when unauthenticated, remote, and no env token", async () => {
		setTty(false);
		mocks.resolveAuthToken.mockReturnValue(null);
		await initCommand({ server: "https://remote.example", agent: "a" });
		expect(logged()).toContain("Skipped");
		expect(logged()).toContain("interlinked login");
		expect(mocks.loginCommand).not.toHaveBeenCalled();
	});

	it("suppresses the no-TTY auth-skip notice in json mode", async () => {
		setTty(false);
		mocks.resolveAuthToken.mockReturnValue(null);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		await initCommand({ json: true, server: "https://remote.example", agent: "a" });
		expect(logged()).not.toContain("interlinked login");
		expect(mocks.loginCommand).not.toHaveBeenCalled();
	});

	it("never authenticates against a local server even when unauthenticated", async () => {
		mocks.resolveAuthToken.mockReturnValue(null);
		await initCommand({ server: "http://127.0.0.1:8787", agent: "a" });
		expect(mocks.loginCommand).not.toHaveBeenCalled();
		// local server short-circuits to the "already authenticated" else-branch
		expect(logged()).toContain("already authenticated");
	});
});

// =======================================================================
// Remote onboarding branch
// =======================================================================
describe("remote onboarding", () => {
	it("prints 'registered' for a new linked agent and the workspace name", async () => {
		mocks.ensureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			isNewAgent: true,
			agentName: "resolved-bot",
			workspaceName: "Acme WS",
		});
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		const out = logged();
		expect(out).toContain("Agent resolved-bot registered");
		expect(out).toContain("Workspace: Acme WS");
	});

	it("prints 'reconnected' for an existing linked agent and falls back to the local agent name", async () => {
		mocks.ensureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			isNewAgent: false,
			// no agentName → uses the local `agentName`
		});
		await initCommand({ server: "http://localhost:8787", agent: "localbot" });
		expect(logged()).toContain("Agent localbot reconnected");
	});

	it("omits the workspace line when a linked agent has no workspace name", async () => {
		mocks.ensureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			isNewAgent: true,
			agentName: "nw",
		});
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(logged()).not.toContain("Workspace:");
	});

	it("prints the skip reason when onboarding is skipped", async () => {
		mocks.ensureRemoteOnboarding.mockResolvedValue({
			status: "skipped",
			reason: "agent_name_missing",
		});
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(logged()).toContain("Remote onboarding skipped: agent_name_missing");
	});

	it("prints 'unknown' when skipped with no reason", async () => {
		mocks.ensureRemoteOnboarding.mockResolvedValue({ status: "skipped" });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(logged()).toContain("Remote onboarding skipped: unknown");
	});

	it("prints the failure error when onboarding fails", async () => {
		mocks.ensureRemoteOnboarding.mockResolvedValue({
			status: "failed",
			error: "bootstrap exploded",
		});
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(logged()).toContain("Remote onboarding: bootstrap exploded");
	});

	it("prints 'failed' when onboarding fails with no error string", async () => {
		mocks.ensureRemoteOnboarding.mockResolvedValue({ status: "failed" });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(logged()).toContain("Remote onboarding: failed");
	});

	it("suppresses onboarding lines in json mode", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		mocks.ensureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			isNewAgent: true,
			agentName: "x",
			workspaceName: "WS",
		});
		await initCommand({ json: true, server: "http://localhost:8787", agent: "bot" });
		expect(logged()).not.toContain("registered");
		expect(logged()).not.toContain("Workspace:");
	});

	it("suppresses the onboarding-failed line in json mode", async () => {
		// Exercises the `else { if (!isJson) … }` failed branch with isJson true.
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		mocks.ensureRemoteOnboarding.mockResolvedValue({ status: "failed", error: "boom" });
		await initCommand({ json: true, server: "http://localhost:8787", agent: "bot" });
		expect(logged()).not.toContain("Remote onboarding");
		// The completion payload still carries the failed status.
		expect(loggedJson().onboarding).toBe("failed");
	});
});

// =======================================================================
// Health check (dynamic api-client import)
// =======================================================================
describe("health check", () => {
	it("reports server reachable with online agent count", async () => {
		mocks.resolveAuthToken.mockReturnValue("tok");
		callToolImpl = (name) => {
			if (name === "health_check") return Promise.resolve({});
			if (name === "list_online_agents")
				return Promise.resolve({ agents: [{ name: "a" }, { name: "b" }] });
			return Promise.reject(new Error("unexpected"));
		};
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		const out = logged();
		expect(out).toContain("Ready! Connected to local server as bot.");
		expect(out).toContain("2 agents online");
		// client constructed with token threaded through
		expect(nonNull(clientCtorCalls[0])[0]).toEqual({ serverUrl: "http://localhost:8787", token: "tok" });
	});

	it("passes the threshold_minutes arg to list_online_agents", async () => {
		let onlineArgs: unknown;
		callToolImpl = (name, args) => {
			if (name === "health_check") return Promise.resolve({});
			onlineArgs = args;
			return Promise.resolve({ agents: [] });
		};
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(onlineArgs).toEqual({ threshold_minutes: 5 });
	});

	it("uses singular 'agent' wording for exactly one online agent", async () => {
		callToolImpl = (name) =>
			name === "health_check"
				? Promise.resolve({})
				: Promise.resolve({ agents: [{ name: "solo" }] });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(logged()).toContain("1 agent online");
	});

	it("omits the agent label when reachable but zero agents online", async () => {
		callToolImpl = (name) =>
			name === "health_check" ? Promise.resolve({}) : Promise.resolve({ agents: [] });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		const out = logged();
		expect(out).toContain("Ready! Connected to local server as bot.");
		expect(out).not.toContain("agents online");
		expect(out).not.toContain("agent online");
	});

	it("treats a missing agents field as zero online", async () => {
		// Every tool call resolves to an empty object — including a missing
		// `agents` field, which must read as zero online.
		callToolImpl = () => Promise.resolve({});
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(logged()).toContain("Ready! Connected to local server as bot.");
	});

	it("stays reachable when list_online_agents throws (best-effort)", async () => {
		callToolImpl = (name) =>
			name === "health_check"
				? Promise.resolve({})
				: Promise.reject(new Error("no such tool"));
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(logged()).toContain("Ready! Connected to local server as bot.");
	});

	it("reports unreachable + local-buffer message when health_check throws", async () => {
		callToolImpl = () => Promise.reject(new Error("ECONNREFUSED"));
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		const out = logged();
		expect(out).toContain("Setup complete.");
		expect(out).toContain("Server not reachable — hooks will buffer locally.");
		expect(out).not.toContain("Ready! Connected");
	});

	it("constructs the client without a token when none resolves", async () => {
		mocks.resolveAuthToken.mockReturnValue(null);
		callToolImpl = (name) =>
			name === "health_check" ? Promise.resolve({}) : Promise.resolve({ agents: [] });
		// remote server + no token + no TTY → auth skipped, health still attempted
		await initCommand({ server: "https://remote.example", agent: "bot" });
		expect(nonNull(clientCtorCalls[0])[0]).toEqual({ serverUrl: "https://remote.example" });
	});

	it("labels production in the ready line for a non-local reachable server", async () => {
		mocks.resolveAuthToken.mockReturnValue("tok");
		callToolImpl = (name) =>
			name === "health_check" ? Promise.resolve({}) : Promise.resolve({ agents: [] });
		await initCommand({ server: "https://remote.example", agent: "bot" });
		expect(logged()).toContain("Ready! Connected to production as bot.");
	});
});

// =======================================================================
// Harness setup branch
// =======================================================================
describe("harness setup", () => {
	it("does not prompt or start automatically if the terminal disconnects during onboarding", async () => {
		setTty(true);
		mocks.isHarnessRunning.mockImplementation(() => {
			setTty(false);
			return { running: false };
		});
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(mocks.harnessStartCommand).not.toHaveBeenCalled();
		expect(rlQuestions).not.toEqual(expect.arrayContaining([expect.stringContaining("Start harness server")]));
		expect(logged()).toContain("Skipped — start later with: interlinked harness start");
	});
	it("reports an already-running harness and suppresses the start hint", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 555 });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		const out = logged();
		expect(out).toContain("Harness already running (PID 555)");
		expect(mocks.harnessStartCommand).not.toHaveBeenCalled();
		// harnessStarted true → start hint omitted from next steps
		expect(out).not.toContain("interlinked harness start    —");
	});

	it("auto-starts the harness on non-TTY (autoConfirm) and reports the new PID", async () => {
		// first call: not running; after start: running
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 1234 });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(mocks.harnessStartCommand).toHaveBeenCalledWith({ daemon: true, json: true });
		expect(logged()).toContain("Harness started (PID 1234)");
	});

	it("reports failure when the harness does not come up after start", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false }); // both calls
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(mocks.harnessStartCommand).toHaveBeenCalledTimes(1);
		const out = logged();
		expect(out).toContain("Failed to start harness.");
		// not started → start hint present in next steps
		expect(out).toContain("interlinked harness start");
	});

	it("starts the harness when the interactive prompt is accepted (blank = default Y)", async () => {
		setTty(true);
		rlAnswers = [""]; // harness prompt → blank accept (agent given → no name prompt)
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 77 });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(rlQuestions.some((q) => q.includes("Start harness server"))).toBe(true);
		expect(mocks.harnessStartCommand).toHaveBeenCalledTimes(1);
		expect(logged()).toContain("Harness started (PID 77)");
	});

	it("starts the harness when the interactive prompt answers a non-'n' value", async () => {
		setTty(true);
		rlAnswers = ["yes"]; // any non-'n' → accept
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 88 });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(mocks.harnessStartCommand).toHaveBeenCalledWith({ daemon: true, json: true });
		expect(logged()).toContain("Harness started (PID 88)");
	});

	it("declines to start the harness when the interactive prompt answers 'n'", async () => {
		setTty(true);
		rlAnswers = ["n"]; // harness prompt → decline
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(mocks.harnessStartCommand).not.toHaveBeenCalled();
		expect(logged()).toContain("Skipped — start later with: interlinked harness start");
	});

	it("auto-starts the harness silently in json mode (suppresses status lines)", async () => {
		// json + autoConfirm (non-TTY): start runs but the `if (!isJson)` status
		// block is skipped — covers the json-mode false-path at the start site.
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 99 });
		await initCommand({ json: true, server: "http://localhost:8787", agent: "bot" });
		expect(mocks.harnessStartCommand).toHaveBeenCalledTimes(1);
		expect(logged()).not.toContain("Harness started");
		expect(loggedJson().status).toBe("complete");
	});

	it("declines harness start silently in json mode (TTY 'n', no skip line)", async () => {
		// json + TTY + 'n' → shouldStart false → the `else if (!isJson)` skip
		// line is suppressed. Covers the json-mode false-path at the decline site.
		setTty(true);
		rlAnswers = ["n"];
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		await initCommand({ json: true, server: "http://localhost:8787", agent: "bot" });
		expect(mocks.harnessStartCommand).not.toHaveBeenCalled();
		expect(logged()).not.toContain("Skipped — start later");
		expect(loggedJson().status).toBe("complete");
	});
});

// =======================================================================
// JSON completion payload
// =======================================================================
describe("json completion payload", () => {
	it("emits the full completion object with reachability + onboarding status", async () => {
		mocks.detectClients.mockReturnValue([{ name: "claude", exists: true, settingsPath: "/repo/.claude/settings.json" }]);
		mocks.findProjectRoot.mockReturnValue("/repo");
		fsExists.add("/repo/.git/config");
		fsFiles["/repo/.git/config"] = "  url = git@github.com:o/jsonproj.git\n";
		mocks.resolveAuthToken.mockReturnValue("tok");
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 5 });
		mocks.ensureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			isNewAgent: true,
			agentName: "jb",
		});
		callToolImpl = (name) =>
			name === "health_check"
				? Promise.resolve({})
				: Promise.resolve({ agents: [{ name: "x" }] });

		await initCommand({
			json: true,
			server: "https://remote.example",
			agent: "jb",
			"sync-mode": "manual",
		});

		const payload = loggedJson();
		expect(payload).toEqual({
			status: "complete",
			server_url: "https://remote.example",
			agent_name: "jb",
			project: "jsonproj",
			sync_mode: "manual",
			detected_clients: ["claude"],
			server_reachable: true,
			online_agents: 1,
			onboarding: "linked",
		});
		// json mode never prints human banners / step lines.
		expect(logged()).not.toContain("Quick Setup");
		expect(logged()).not.toContain("Harness setup");
	});

	it("emits server_reachable:false in the json payload when the health check fails", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		callToolImpl = () => Promise.reject(new Error("down"));
		await initCommand({ json: true, server: "https://remote.example", agent: "jb" });
		const payload = loggedJson();
		expect(payload.server_reachable).toBe(false);
		expect(payload.online_agents).toBe(0);
	});
});
