import { parseWire, wireBoolean, wireObject, wireRecord, wireString } from "../lib/value-validation.js";
// ===========================================
// interlinked attach — behavioral coverage (companion to attach.ts)
// ===========================================
// Drives attachCommand through EVERY branch of the source:
//   - --auto git-derivation (repo / not-a-repo / json-suppressed logs,
//     and the "already supplied so don't override" guards)
//   - --server initConfig wiring + the `server !== undefined` ternary
//   - --workspace valid (servers-merge vs flat-update) and invalid (throw)
//   - applyDefaultContext (early-return, shared-config present/absent fallback,
//     workspaceKey/project ternaries, trim())
//   - agent persistence (trim truthy/falsy)
//   - buildRemoteStatusLines: linked {new,reclaimed,existing} × name fallbacks
//     × agentHandle present/absent; skipped {not_authenticated, agent_name_missing,
//     unknown-reason fallthrough}; failed {with error, without error}; default dim
//   - output modes (json / normal / short→normal / full→normal) and the
//     `|| c.dim("not set")` fallbacks in the normal renderer
//   - the catch path with both an Error and a non-Error throwable
//
// `../lib/config.js`, `../lib/onboarding.js`, and `../lib/git-utils.js` are the
// real disk/network/subprocess surfaces and are fully mocked. `node:fs` is
// mocked per the harness contract so no test can reach the filesystem even by
// accident. `../lib/formatter.js` is mocked to identity renderers so output
// assertions are exact strings rather than ANSI-sensitive substrings.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInitConfig = vi.fn();
const mockReadLocalConfig = vi.fn();
const mockReadSharedConfig = vi.fn();
const mockResolveConfig = vi.fn();
const mockUpdateLocalConfig = vi.fn();
const mockWriteSharedConfig = vi.fn();
const mockEnsureRemoteOnboarding = vi.fn();
const mockIsGitRepo = vi.fn();
const mockDeriveProjectIdentity = vi.fn();

vi.mock("../lib/config.js", () => ({
	initConfig: (opts: unknown) => mockInitConfig(opts),
	readLocalConfig: () => mockReadLocalConfig(),
	readSharedConfig: () => mockReadSharedConfig(),
	resolveConfig: () => mockResolveConfig(),
	updateLocalConfig: (updates: unknown) => mockUpdateLocalConfig(updates),
	writeSharedConfig: (next: unknown) => mockWriteSharedConfig(next),
}));

vi.mock("../lib/onboarding.js", () => ({
	ensureRemoteOnboarding: (opts: unknown) => mockEnsureRemoteOnboarding(opts),
}));

vi.mock("../lib/git-utils.js", () => ({
	isGitRepo: (cwd: string) => mockIsGitRepo(cwd),
	deriveProjectIdentity: (cwd: string) => mockDeriveProjectIdentity(cwd),
}));

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(() => false),
	mkdirSync: vi.fn(),
}));

// Identity/predictable formatter so output assertions are exact. Every `c.<x>`
// returns its input unchanged; header/kvLine return a stable, parseable shape.
vi.mock("../lib/formatter.js", () => {
	const identity = (s: string): string => s;
	return {
		c: new Proxy(
			{},
			{
				get: (): ((s: string) => string) => identity,
			},
		),
		header: (title: string): string => `== ${title} ==`,
		kvLine: (key: string, value: string): string => `${key}: ${value}`,
	};
});

import { nonNull } from "../lib/non-null.js";
import { attachCommand } from "./attach.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let cwdSpy: ReturnType<typeof vi.spyOn>;

// A stable resolveConfig payload; individual tests override fields as needed.
function defaultResolved(): Record<string, unknown> {
	return {
		server_url: "https://resolved.example.com",
		workspace_id: "ws_resolved",
		default_workspace_key: "wk_resolved",
		default_project: "proj_resolved",
		agent_name: "ResolvedAgent",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = 0;

	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");

	// Safe defaults: no servers map, resolves cleanly, remote "skipped" (no
	// reason -> default dim line). Tests override per-case.
	mockReadLocalConfig.mockReturnValue({});
	mockReadSharedConfig.mockReturnValue({ version: 1, server_url: "https://shared.example.com" });
	mockResolveConfig.mockReturnValue(defaultResolved());
	mockEnsureRemoteOnboarding.mockResolvedValue({ status: "skipped" });
	mockIsGitRepo.mockReturnValue(true);
	mockDeriveProjectIdentity.mockReturnValue({});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

const allLog = (): string =>
	logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
const lastLog = (): string => String(logSpy.mock.calls.at(-1)?.[0] ?? "");
const lastErr = (): string => String(errSpy.mock.calls.at(-1)?.[0] ?? "");

// ===========================================
// --auto git-derivation
// ===========================================

describe("attachCommand --auto", () => {
	it("auto-derives workspace_key + project from git metadata and logs both (normal mode)", async () => {
		mockDeriveProjectIdentity.mockReturnValue({ workspaceKey: "derived-wk", projectKey: "main" });

		await attachCommand({ auto: true });

		expect(mockIsGitRepo).toHaveBeenCalledWith("/repo");
		expect(mockDeriveProjectIdentity).toHaveBeenCalledWith("/repo");
		const out = allLog();
		expect(out).toContain("Auto-derived workspace_key: derived-wk");
		expect(out).toContain("Auto-derived project: main");
		// Derived values flow into applyDefaultContext -> writeSharedConfig.
		expect(mockWriteSharedConfig).toHaveBeenCalledWith({
			version: 1,
			server_url: "https://shared.example.com",
			default_workspace_key: "derived-wk",
			default_project: "main",
		});
	});

	it("does NOT log auto-derivation lines in json mode (mode !== 'json' guard)", async () => {
		mockDeriveProjectIdentity.mockReturnValue({ workspaceKey: "derived-wk", projectKey: "main" });

		await attachCommand({ auto: true, json: true });

		const out = allLog();
		expect(out).not.toContain("Auto-derived workspace_key");
		expect(out).not.toContain("Auto-derived project");
		// But derivation still applied to shared config.
		expect(mockWriteSharedConfig).toHaveBeenCalledWith(
			expect.objectContaining({ default_workspace_key: "derived-wk", default_project: "main" }),
		);
	});

	it("does NOT override an explicitly-supplied workspaceKey/project (the `!opts.x` guards)", async () => {
		mockDeriveProjectIdentity.mockReturnValue({ workspaceKey: "derived-wk", projectKey: "derived-proj" });

		await attachCommand({ auto: true, workspaceKey: "explicit-wk", project: "explicit-proj" });

		const out = allLog();
		// Neither auto-log fires because both opts were already set.
		expect(out).not.toContain("Auto-derived");
		// Explicit values win.
		expect(mockWriteSharedConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				default_workspace_key: "explicit-wk",
				default_project: "explicit-proj",
			}),
		);
	});

	it("skips derivation entirely when derived identity is empty (both inner ifs false)", async () => {
		mockDeriveProjectIdentity.mockReturnValue({});

		await attachCommand({ auto: true });

		const out = allLog();
		expect(out).not.toContain("Auto-derived");
		// No workspaceKey/project -> applyDefaultContext early-returns, no write.
		expect(mockWriteSharedConfig).not.toHaveBeenCalled();
	});

	it("warns when --auto runs outside a git repo (normal mode)", async () => {
		mockIsGitRepo.mockReturnValue(false);

		await attachCommand({ auto: true });

		expect(mockDeriveProjectIdentity).not.toHaveBeenCalled();
		expect(allLog()).toContain("--auto: not a git repository, skipping auto-derivation.");
	});

	it("suppresses the not-a-git-repo warning in json mode (else-if mode guard)", async () => {
		mockIsGitRepo.mockReturnValue(false);

		await attachCommand({ auto: true, json: true });

		expect(allLog()).not.toContain("not a git repository");
	});
});

// ===========================================
// --server / --workspace
// ===========================================

describe("attachCommand --server and --workspace", () => {
	it("initializes config with the given server URL and passes it to onboarding (server !== undefined)", async () => {
		await attachCommand({ server: "https://srv.example.com", json: true });

		expect(mockInitConfig).toHaveBeenCalledWith({ serverUrl: "https://srv.example.com" });
		expect(mockEnsureRemoteOnboarding).toHaveBeenCalledWith({
			serverUrl: "https://srv.example.com",
		});
	});

	it("passes an empty options object to onboarding when no --server (server === undefined)", async () => {
		await attachCommand({ json: true });

		expect(mockInitConfig).not.toHaveBeenCalled();
		expect(mockEnsureRemoteOnboarding).toHaveBeenCalledWith({});
	});

	it("merges workspace_id into the active server entry when a servers map exists", async () => {
		mockReadLocalConfig.mockReturnValue({
			active_server: "production",
			servers: {
				production: { server_url: "https://prod", workspace_id: "ws_old" },
				staging: { server_url: "https://stg", workspace_id: "ws_stg" },
			},
		});

		await attachCommand({ workspace: "ws_new123", json: true });

		expect(mockUpdateLocalConfig).toHaveBeenCalledTimes(1);
		const arg = parseWire(nonNull(mockUpdateLocalConfig.mock.calls[0])[0], wireObject({ "workspace_id": wireString, "servers": wireRecord(wireObject({ "server_url": wireString, "workspace_id": wireString })) }), "test JSON value");
		expect(arg.workspace_id).toBe("ws_new123");
		expect(arg.servers.production).toEqual({ server_url: "https://prod", workspace_id: "ws_new123" });
		// Sibling entry preserved by the spread.
		expect(arg.servers.staging).toEqual({ server_url: "https://stg", workspace_id: "ws_stg" });
	});

	it("defaults the active server key to 'production' when active_server is unset (|| branch)", async () => {
		mockReadLocalConfig.mockReturnValue({
			servers: { production: { server_url: "https://prod", workspace_id: "ws_old" } },
		});

		await attachCommand({ workspace: "ws_new123", json: true });

		const arg = parseWire(nonNull(mockUpdateLocalConfig.mock.calls[0])[0], wireObject({ "servers": wireRecord(wireObject({ "workspace_id": wireString })) }), "test JSON value");
		expect(nonNull(arg.servers.production).workspace_id).toBe("ws_new123");
	});

	it("falls back to a flat workspace_id update when readLocalConfig returns null (|| {} branch)", async () => {
		mockReadLocalConfig.mockReturnValue(null);

		await attachCommand({ workspace: "ws_flat99", json: true });

		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ workspace_id: "ws_flat99" });
	});

	it("falls back to a flat update when the active server key has no matching servers entry", async () => {
		mockReadLocalConfig.mockReturnValue({
			active_server: "missing",
			servers: { production: { server_url: "https://prod", workspace_id: "ws_old" } },
		});

		await attachCommand({ workspace: "ws_flat99", json: true });

		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ workspace_id: "ws_flat99" });
	});

	it("rejects an invalid workspace ID (throws -> catch -> outputError, exitCode 1, no onboarding)", async () => {
		await attachCommand({ workspace: "not-a-ws", json: true });

		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
		expect(mockEnsureRemoteOnboarding).not.toHaveBeenCalled();
		const payload = parseWire(JSON.parse(lastErr()), wireObject({ "error": wireString }), "test JSON value");
		expect(payload.error).toBe("Invalid workspace ID 'not-a-ws'. Expected format: ws_<alphanumeric>.");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// applyDefaultContext + agent persistence
// ===========================================

describe("attachCommand applyDefaultContext + agent", () => {
	it("does not touch shared config when neither workspaceKey nor project is given (early return)", async () => {
		await attachCommand({ json: true });

		expect(mockReadSharedConfig).not.toHaveBeenCalled();
		expect(mockWriteSharedConfig).not.toHaveBeenCalled();
	});

	it("writes only default_workspace_key when project is absent (project ternary false)", async () => {
		await attachCommand({ workspaceKey: "  wk-trimmed  ", json: true });

		// Existing shared config is spread; only workspace_key added; project untouched.
		expect(mockWriteSharedConfig).toHaveBeenCalledWith({
			version: 1,
			server_url: "https://shared.example.com",
			default_workspace_key: "wk-trimmed",
		});
	});

	it("writes only default_project when workspaceKey is absent (workspaceKey ternary false)", async () => {
		await attachCommand({ project: "  proj-trimmed  ", json: true });

		expect(mockWriteSharedConfig).toHaveBeenCalledWith({
			version: 1,
			server_url: "https://shared.example.com",
			default_project: "proj-trimmed",
		});
	});

	it("synthesizes a fresh shared config from resolveConfig().server_url when readSharedConfig is null (|| fallback)", async () => {
		mockReadSharedConfig.mockReturnValue(null);
		mockResolveConfig.mockReturnValue({ ...defaultResolved(), server_url: "https://fallback.example.com" });

		await attachCommand({ workspaceKey: "wk", project: "proj", json: true });

		expect(mockWriteSharedConfig).toHaveBeenCalledWith({
			version: 1,
			server_url: "https://fallback.example.com",
			default_workspace_key: "wk",
			default_project: "proj",
		});
	});

	it("treats a whitespace-only workspaceKey/project as absent after trim (early-return, no write)", async () => {
		await attachCommand({ workspaceKey: "   ", project: "   ", json: true });

		// trim() empties both -> applyDefaultContext sees neither -> early return.
		expect(mockReadSharedConfig).not.toHaveBeenCalled();
		expect(mockWriteSharedConfig).not.toHaveBeenCalled();
	});

	it("persists a trimmed agent_name (opts.agent?.trim() truthy)", async () => {
		await attachCommand({ agent: "  Worker-Z  ", json: true });

		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ agent_name: "Worker-Z" });
	});

	it("does NOT persist agent_name when --agent is whitespace-only (trim falsy)", async () => {
		await attachCommand({ agent: "   ", json: true });

		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});

	it("does NOT persist agent_name when --agent is omitted (optional-chain short-circuit)", async () => {
		await attachCommand({ json: true });

		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});
});

// ===========================================
// JSON payload shape
// ===========================================

describe("attachCommand JSON output", () => {
	it("emits a fully-resolved JSON payload mirroring resolveConfig + remote result", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://j.example.com",
			workspace_id: "ws_json",
			default_workspace_key: "wk_json",
			default_project: "proj_json",
			agent_name: "JsonAgent",
		});
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			reason: undefined,
			agentName: "JsonAgent",
			agentHandle: "ah_json.1",
			workspaceName: "main",
			isNewAgent: true,
			reclaimedAgent: false,
			error: undefined,
		});

		await attachCommand({ json: true });

		const payload = parseWire(JSON.parse(lastLog()), wireObject({ "server_url": wireString, "workspace_id": wireString, "default_workspace_key": wireString, "default_project": wireString, "agent_name": wireString, "remote": wireObject({ "status": wireString, "agent_name": wireString, "agent_handle": wireString, "workspace_name": wireString, "is_new_agent": wireBoolean, "reclaimed_agent": wireBoolean }) }), "test JSON value");
		expect(payload).toMatchObject({
			server_url: "https://j.example.com",
			workspace_id: "ws_json",
			default_workspace_key: "wk_json",
			default_project: "proj_json",
			agent_name: "JsonAgent",
		});
		expect(payload.remote).toMatchObject({
			status: "linked",
			agent_name: "JsonAgent",
			agent_handle: "ah_json.1",
			workspace_name: "main",
			is_new_agent: true,
			reclaimed_agent: false,
		});
	});
});

// ===========================================
// normal renderer + buildRemoteStatusLines
// ===========================================

describe("attachCommand normal renderer", () => {
	it("renders the header + all kv lines with resolved values", async () => {
		await attachCommand({});

		const out = allLog();
		expect(out).toContain("== Attach ==");
		expect(out).toContain("Server: https://resolved.example.com");
		expect(out).toContain("Workspace: ws_resolved");
		expect(out).toContain("workspace_key: wk_resolved");
		expect(out).toContain("project_key: proj_resolved");
		expect(out).toContain("Agent: ResolvedAgent");
	});

	it("falls back to 'not set' / 'main (default)' placeholders when resolved fields are empty (|| branches)", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://only-server.example.com",
			workspace_id: undefined,
			default_workspace_key: undefined,
			default_project: undefined,
			agent_name: undefined,
		});

		await attachCommand({});

		const out = allLog();
		expect(out).toContain("Workspace: not set");
		expect(out).toContain("workspace_key: main (default)");
		expect(out).toContain("project_key: main (default)");
		expect(out).toContain("Agent: not set");
	});

	it("short mode falls through to the normal renderer", async () => {
		await attachCommand({ short: true });
		expect(allLog()).toContain("== Attach ==");
	});

	it("full mode falls through to the normal renderer", async () => {
		await attachCommand({ full: true });
		expect(allLog()).toContain("== Attach ==");
	});

	// --- linked lifecycle variants + name/handle fallbacks ---

	it("linked + isNewAgent => 'new' lifecycle, uses remote.agentName, prints agent handle", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "Alpha",
			agentHandle: "ah.alpha",
			isNewAgent: true,
		});

		await attachCommand({});

		const out = allLog();
		expect(out).toContain("Remote: Alpha linked (new)");
		expect(out).toContain("Agent handle: ah.alpha");
	});

	it("linked + reclaimedAgent => 'reclaimed' lifecycle", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "Beta",
			isNewAgent: false,
			reclaimedAgent: true,
		});

		await attachCommand({});

		expect(allLog()).toContain("Remote: Beta linked (reclaimed)");
	});

	it("linked + neither new nor reclaimed => 'existing' lifecycle", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "Gamma",
			isNewAgent: false,
			reclaimedAgent: false,
		});

		await attachCommand({});

		expect(allLog()).toContain("Remote: Gamma linked (existing)");
	});

	it("linked with no remote.agentName falls back to result.agent_name", async () => {
		mockResolveConfig.mockReturnValue({ ...defaultResolved(), agent_name: "FromConfig" });
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "linked", isNewAgent: false });

		await attachCommand({});

		expect(allLog()).toContain("Remote: FromConfig linked (existing)");
	});

	it("linked with no remote.agentName AND no result.agent_name falls back to literal 'agent'", async () => {
		mockResolveConfig.mockReturnValue({ ...defaultResolved(), agent_name: undefined });
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "linked", isNewAgent: false });

		await attachCommand({});

		expect(allLog()).toContain("Remote: agent linked (existing)");
	});

	it("linked without an agentHandle omits the 'Agent handle' line", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "Delta",
			isNewAgent: false,
		});

		await attachCommand({});

		expect(allLog()).not.toContain("Agent handle:");
	});

	// --- skipped reasons ---

	it("skipped/not_authenticated shows the login help line", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "skipped", reason: "not_authenticated" });

		await attachCommand({});

		const out = allLog();
		expect(out).toContain("Remote: not authenticated");
		expect(out).toContain("Run: interlinked login");
	});

	it("skipped/agent_name_missing shows the attach --agent help line", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "skipped", reason: "agent_name_missing" });

		await attachCommand({});

		const out = allLog();
		expect(out).toContain("Remote: agent name required");
		expect(out).toContain("Run: interlinked attach --agent <name>");
	});

	it("skipped with an unmapped reason falls through to the dim 'skipped' line", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "skipped", reason: "server_unavailable" });

		await attachCommand({});

		expect(allLog()).toContain("Remote: skipped");
	});

	it("skipped with no reason at all falls through to the dim 'skipped' line", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "skipped" });

		await attachCommand({});

		expect(allLog()).toContain("Remote: skipped");
	});

	// --- failed ---

	it("failed with an error prints 'not linked' + the indented error", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "failed", error: "boom went the server" });

		await attachCommand({});

		const out = allLog();
		expect(out).toContain("Remote: not linked");
		expect(out).toContain("boom went the server");
	});

	it("failed without an error prints 'not linked' with no error line", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "failed" });

		await attachCommand({});

		const out = allLog();
		expect(out).toContain("Remote: not linked");
		// No second indented error line beyond the status.
		expect(out).not.toContain("Remote: not linked\n ");
	});
});

// ===========================================
// catch path
// ===========================================

describe("attachCommand error handling", () => {
	it("reports an Error thrown by onboarding via outputError (normal mode, exitCode 1)", async () => {
		mockEnsureRemoteOnboarding.mockRejectedValue(new Error("network exploded"));

		await attachCommand({});

		expect(lastErr()).toBe("Error: network exploded");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error throwable in the catch branch (String(err))", async () => {
		mockEnsureRemoteOnboarding.mockRejectedValue("plain string failure");

		await attachCommand({ json: true });

		const payload = parseWire(JSON.parse(lastErr()), wireObject({ "error": wireString }), "test JSON value");
		expect(payload.error).toBe("plain string failure");
		expect(process.exitCode).toBe(1);
	});

	it("uses process.cwd() under --auto", async () => {
		await attachCommand({ auto: true });
		expect(cwdSpy).toHaveBeenCalled();
		expect(mockIsGitRepo).toHaveBeenCalledWith("/repo");
	});
});
