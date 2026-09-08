import { parseWire, wireString } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// Behavioral tests for `interlinked doctor` (doctorCommand).
//
// Strategy: doctorCommand is a pure orchestrator — it reads the filesystem,
// resolves config/auth, talks to the harness + server, and renders a list of
// CheckResults. We mock every collaborator so each branch (pass/fail/warn per
// check, --json vs normal, server reachable/unreachable, --fix paths, catch
// blocks, ternaries) is driven deterministically with no real I/O.
//
// `node:fs` is the heart of the local checks: existsSync gates almost every
// branch, so we back it with a configurable in-memory file set + content map.
// ===========================================================================

const {
	fsState,
	mockExistsSync,
	mockReadFileSync,
	mockReaddirSync,
	mockStatSync,
	mockRunSystemChecks,
	mockIsHarnessRunning,
	mockQueryHarness,
	mockResolveConfig,
	mockGetConfigDir,
	mockGetSharedConfigPath,
	mockGetLocalConfigPath,
	mockHasLegacyConfig,
	mockMigrateLegacyConfig,
	mockResolveAuthToken,
	mockWriteHookScript,
	mockDefaultSettingsPaths,
	mockValidateSettingsFile,
	mockStripMalformedRules,
	mockMigrateLegacyMode,
	mockHealthCheck,
	mockFetchWorkspaces,
	mockCallTool,
	mockGetClient,
} = vi.hoisted(() => {
	const state = {
		// Set of absolute paths that "exist".
		exists: new Set<string>(),
		// path -> file content (for readFileSync).
		content: new Map<string, string>(),
		// dir path -> file names (for readdirSync).
		dir: new Map<string, string[]>(),
		// path -> mtimeMs (for statSync).
		mtime: new Map<string, number>(),
		// Throw toggles for catch-branch coverage.
		throwOnReadFile: new Set<string>(),
		throwOnReaddir: new Set<string>(),
	};
	return {
		fsState: state,
		mockExistsSync: vi.fn((p: string) => state.exists.has(p)),
		mockReadFileSync: vi.fn((p: string) => {
			if (state.throwOnReadFile.has(p)) throw new Error(`read fail: ${p}`);
			if (state.content.has(p)) return nonNull(state.content.get(p));
			throw new Error(`ENOENT: ${p}`);
		}),
		mockReaddirSync: vi.fn((p: string) => {
			if (state.throwOnReaddir.has(p)) throw new Error(`readdir fail: ${p}`);
			return state.dir.get(p) ?? [];
		}),
		mockStatSync: vi.fn((p: string) => {
			if (!state.mtime.has(p)) throw new Error(`stat fail: ${p}`);
			return { mtimeMs: nonNull(state.mtime.get(p)) };
		}),
		mockRunSystemChecks: vi.fn(
			(): Array<{ name: string; status: string; message: string }> => [],
		),
		mockIsHarnessRunning: vi.fn(
			(): { running: boolean; pid?: number } => ({ running: false }),
		),
		mockResolveConfig: vi.fn(
			(): { server_url: string; agent_name?: string } =>
				({
					server_url: "https://remote.example.com",
					agent_name: "Worker-Alpha",
				}),
		),
		mockGetConfigDir: vi.fn((cwd: string) => `${cwd}/.interlinked`),
		mockGetSharedConfigPath: vi.fn((cwd: string) => `${cwd}/.interlinked/config.json`),
		mockGetLocalConfigPath: vi.fn((cwd: string) => `${cwd}/.interlinked/config.local.json`),
		mockHasLegacyConfig: vi.fn(() => false),
		mockMigrateLegacyConfig: vi.fn(() => true),
		mockResolveAuthToken: vi.fn((): string | null => "tok_abc"),
		mockWriteHookScript: vi.fn(() => ""),
		mockDefaultSettingsPaths: vi.fn((): string[] => []),
		mockValidateSettingsFile: vi.fn(
			(): { exists: boolean; parseError: boolean; malformed: Array<{ rule: string }> } =>
				({
					exists: false,
					parseError: false,
					malformed: [],
				}),
		),
		mockStripMalformedRules: vi.fn(() => 0),
		mockMigrateLegacyMode: vi.fn(() => "quality"),
		mockHealthCheck: vi.fn(
			async (): Promise<{ serverReachable: boolean; authenticated: boolean; serverVersion?: string; error?: string }> =>
				({
					serverReachable: true,
					authenticated: true,
					serverVersion: "9.9.9",
				}),
		),
		mockFetchWorkspaces: vi.fn(async (): Promise<unknown[]> => [{ workspace_key: "main" }]),
		mockCallTool: vi.fn(async (): Promise<unknown> => ({ workspaces: [{ name: "cb-1" }] })),
		mockGetClient: vi.fn(),
		// The harness liveness ROUND-TRIP (`probeHarnessSocket` → queryHarness).
		// Default null = nothing answered, which is what an unseeded fixture
		// should mean: no daemon.
		mockQueryHarness: vi.fn(async (): Promise<unknown> => null),
	};
});

vi.mock("node:fs", () => ({
	existsSync: mockExistsSync,
	readFileSync: mockReadFileSync,
	readdirSync: mockReaddirSync,
	statSync: mockStatSync,
	realpathSync: (path: string) => path,
}));

// Identity color helpers so emitted strings are stable regardless of
// NO_COLOR/CI/TTY at module-load time. statusIcon -> plain `[pass]` etc.
vi.mock("../lib/formatter.js", () => ({
	c: {
		green: (s: string) => s,
		red: (s: string) => s,
		yellow: (s: string) => s,
		dim: (s: string) => s,
		bold: (s: string) => s,
	},
	divider: () => "----",
	header: (t: string) => t,
}));

vi.mock("./doctor-system.js", () => ({
	runSystemChecks: mockRunSystemChecks,
	// Doctor now takes its orphan count from the protection-aware sweep rather
	// than a private `ps` scan that counted the live daemon.
	countVerifiedOrphans: vi.fn(async () => 0),
}));
vi.mock("./harness.js", () => ({ isHarnessRunning: mockIsHarnessRunning }));
// The liveness probe queries by explicit socket path (framed-aware, review
// 2026-08-26); route it to the same mock so the existsSync-then-round-trip
// logic under test stays real.
vi.mock("./harness-status-helpers.js", () => ({
	queryHarness: mockQueryHarness,
	queryHarnessSocket: mockQueryHarness,
}));
// Adoption-artifact rows are covered by adopt.test.ts; stubbed empty here so
// these fixtures keep their pre-adopt output shape (no warn row from the
// host repo's missing baselines leaking into unrelated expectations).
vi.mock("./adopt.js", () => ({ adoptionArtifactChecks: () => [] }));
vi.mock("./doctor-lint.js", () => ({ lintAdoptionChecks: () => [] }));
vi.mock("./doctor-skills.js", () => ({ skillInstallationChecks: () => [] }));

vi.mock("../lib/config.js", () => ({
	getConfigDir: mockGetConfigDir,
	getSharedConfigPath: mockGetSharedConfigPath,
	getLocalConfigPath: mockGetLocalConfigPath,
	hasLegacyConfig: mockHasLegacyConfig,
	migrateLegacyConfig: mockMigrateLegacyConfig,
	resolveConfig: mockResolveConfig,
	// getActivityPath (via thinkingCaptureCheck) resolves through getDataDir.
	getDataDir: (cwd: string) => `${cwd}/.interlinked`,
}));

vi.mock("../lib/auth.js", () => ({ resolveAuthToken: mockResolveAuthToken }));

vi.mock("../lib/hooks.js", () => ({
	HOOK_SCRIPT_VERSION: "1.2.3",
	writeHookScript: mockWriteHookScript,
	// The drift check resolves the current binary; the mocked fs has no
	// manifest, so the check itself yields no rows in these fixtures.
	resolveHookBinaryPath: () => "/mock/dist/hook-entry.js",
}));

vi.mock("../lib/settings-validator.js", () => ({
	defaultSettingsPaths: mockDefaultSettingsPaths,
	stripMalformedRules: mockStripMalformedRules,
	validateSettingsFile: mockValidateSettingsFile,
}));

vi.mock("../harness/rules/modes.js", () => ({
	DEFAULT_HARNESS_MODE: "quality",
	migrateLegacyMode: mockMigrateLegacyMode,
}));

vi.mock("../lib/api-client.js", () => ({ getClient: mockGetClient }));
// Healthy default so the "Data collection" check (added with b65c449) passes;
// the liveness logic itself is covered in collection/liveness.test.ts. Without
// this, getCollectionLiveness reads the mocked fs, finds no collection.jsonl,
// and emits a "missing" warning that broke the zero-warnings assertions.
vi.mock("../lib/collection/liveness.js", () => ({
	getCollectionLiveness: () => ({
		status: "live",
		path: ".interlinked/collection.jsonl",
		exists: true,
		sizeBytes: 100,
		mtimeMs: 0,
		lastRecordTs: "2026-06-07T00:00:00.000Z",
		lastRecordAgeMs: 0,
		reason: "last record 0s ago",
	}),
}));

// Resolved by mockGetConfigDir/etc.; pinned so path strings are predictable.
const CWD = "/repo";

/** Capture all console.log output joined into one string. */
function captured(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((call) => String(call[0]))
		.join("\n");
}

/** Parse the (single) JSON blob written in --json mode. */
function capturedJson(): {
	local: Array<{ name: string; status: string; message: string }>;
	server: Array<{ name: string; status: string; message: string }>;
	summary: { pass: number; fail: number; warn: number };
} {
	const raw = parseWire(vi.mocked(console.log).mock.calls.at(-1)?.[0], wireString, "test JSON value");
	return JSON.parse(raw);
}

const HOOK_PATH = `${CWD}/.interlinked/hooks/interlinked-activity.mjs`;
const SHARED_CFG = `${CWD}/.interlinked/config.json`;

/** Seed fs so every local check lands on its "pass"/clean path. */
function seedHealthyFs(): void {
	fsState.exists.add(`${CWD}/.interlinked`); // config dir
	fsState.exists.add(SHARED_CFG); // shared config
	fsState.exists.add(`${CWD}/.interlinked/config.local.json`); // local config
	fsState.exists.add(HOOK_PATH); // hook script
	fsState.exists.add(`${CWD}/.interlinked/guard-rules.json`); // guard rules
	// Hook content with a matching version stamp (HOOK_SCRIPT_VERSION+mode-quality).
	fsState.content.set(HOOK_PATH, "// interlinked-hook-version: 1.2.3+mode-quality\n");
	// config.json content for expectedHookVersion mode parse.
	fsState.content.set(SHARED_CFG, JSON.stringify({ mode: "quality" }));
}

describe("doctorCommand", () => {
	let exitCodeBackup: typeof process.exitCode;

	beforeEach(() => {
		vi.clearAllMocks();
		// Reset fs state between tests.
		fsState.exists.clear();
		fsState.content.clear();
		fsState.dir.clear();
		fsState.mtime.clear();
		fsState.throwOnReadFile.clear();
		fsState.throwOnReaddir.clear();
		// Re-assert default mock behaviors (clearAllMocks clears call records;
		// individual tests mutate these, so restore them every run).
		mockExistsSync.mockImplementation((p: string) => fsState.exists.has(p));
		mockRunSystemChecks.mockReturnValue([]);
		mockIsHarnessRunning.mockReturnValue({ running: false });
		mockResolveConfig.mockReturnValue({
			server_url: "https://remote.example.com",
			agent_name: "Worker-Alpha",
		});
		mockHasLegacyConfig.mockReturnValue(false);
		mockResolveAuthToken.mockReturnValue("tok_abc");
		mockDefaultSettingsPaths.mockReturnValue([]);
		mockValidateSettingsFile.mockReturnValue({
			exists: false,
			parseError: false,
			malformed: [],
		});
		mockMigrateLegacyMode.mockReturnValue("quality");
		mockHealthCheck.mockResolvedValue({
			serverReachable: true,
			authenticated: true,
			serverVersion: "9.9.9",
		});
		mockFetchWorkspaces.mockResolvedValue([{ workspace_key: "main" }]);
		mockCallTool.mockResolvedValue({ workspaces: [{ name: "cb-1" }] });
		mockGetClient.mockReturnValue({
			healthCheck: mockHealthCheck,
			fetchWorkspaces: mockFetchWorkspaces,
			callTool: mockCallTool,
		});

		vi.spyOn(process, "cwd").mockReturnValue(CWD);
		vi.spyOn(console, "log").mockImplementation(() => {});
		exitCodeBackup = process.exitCode;
		process.exitCode = 0;
	});

	afterEach(() => {
		process.exitCode = exitCodeBackup;
		vi.restoreAllMocks();
	});

	async function run(opts: { fix?: boolean; json?: boolean } = {}): Promise<void> {
		const { doctorCommand } = await import("./doctor.js");
		await doctorCommand(opts);
	}

	// -------------------------------------------------------------------------
	// Local checks — pass paths
	// -------------------------------------------------------------------------

	describe("healthy install (all local checks pass)", () => {
		beforeEach(seedHealthyFs);

		it("reports config directory present", async () => {
			await run();
			expect(captured()).toContain("[pass] Config directory -- .interlinked/ exists");
		});

		it("reports shared + local config present", async () => {
			await run();
			const out = captured();
			expect(out).toContain("[pass] Shared config -- config.json exists");
			expect(out).toContain("[pass] Local config -- config.local.json exists");
		});

		it("does NOT warn about agent identity when agent_name is set", async () => {
			await run();
			expect(captured()).not.toContain("Agent identity");
		});

		it("reports hook script present and version current", async () => {
			await run();
			const out = captured();
			expect(out).toContain("[pass] Hook script -- interlinked-activity.mjs present");
			expect(out).toContain("[pass] Hook version -- v1.2.3+mode-quality (current)");
		});

		it("reports guard rules present", async () => {
			await run();
			expect(captured()).toContain(
				"[pass] Guard rules -- guard-rules.json present (team-shared rules)",
			);
		});

		it("reports Node runtime with version + execPath", async () => {
			await run();
			expect(captured()).toContain(
				`[pass] Node.js runtime -- ${process.version} (${process.execPath})`,
			);
		});

		it("does not set a failing exit code", async () => {
			await run();
			expect(process.exitCode).toBe(0);
		});

		it("renders the summary line and no --fix hint when nothing fails", async () => {
			await run();
			const out = captured();
			expect(out).toContain("passed");
			expect(out).not.toContain("doctor --fix");
		});
	});

	// -------------------------------------------------------------------------
	// Local checks — fail / warn paths
	// -------------------------------------------------------------------------

	it("fails config directory + shared config when .interlinked missing", async () => {
		// Nothing seeded -> config dir absent.
		await run();
		const out = captured();
		expect(out).toContain(
			"[FAIL] Config directory -- .interlinked/ not found -- run 'interlinked enable'",
		);
		expect(out).toContain(
			"[FAIL] Shared config -- config.json not found -- run 'interlinked enable'",
		);
		expect(process.exitCode).toBe(1);
	});

	it("prints the --fix hint in normal mode when a check fails (and --fix not set)", async () => {
		await run();
		expect(captured()).toContain("Run 'interlinked doctor --fix' to attempt auto-fixes.");
	});

	it("warns when local config is missing", async () => {
		fsState.exists.add(`${CWD}/.interlinked`);
		fsState.exists.add(SHARED_CFG);
		await run();
		expect(captured()).toContain(
			"[warn] Local config -- config.local.json not found -- run 'interlinked login' or 'interlinked register'",
		);
	});

	it("warns about agent identity when local config exists but agent_name unset", async () => {
		seedHealthyFs();
		mockResolveConfig.mockReturnValue({ server_url: "https://remote.example.com" });
		await run();
		expect(captured()).toContain("[warn] Agent identity -- agent_name is not set");
	});

	it("accepts the legacy .claude hook path as present", async () => {
		fsState.exists.add(`${CWD}/.interlinked`);
		fsState.exists.add(SHARED_CFG);
		fsState.exists.add(`${CWD}/.interlinked/config.local.json`);
		// Only the legacy hook path exists, not the .interlinked one.
		fsState.exists.add(`${CWD}/.claude/hooks/interlinked-activity.mjs`);
		await run();
		const out = captured();
		expect(out).toContain("[pass] Hook script -- interlinked-activity.mjs present");
		// Version check only runs against the .interlinked path (absent) -> skipped.
		expect(out).not.toContain("Hook version");
	});

	it("warns when no hook script is present at either path", async () => {
		fsState.exists.add(`${CWD}/.interlinked`);
		fsState.exists.add(SHARED_CFG);
		fsState.exists.add(`${CWD}/.interlinked/config.local.json`);
		await run();
		expect(captured()).toContain(
			"[warn] Hook script -- Hook script not found -- run 'interlinked enable' to install",
		);
	});

	// -------------------------------------------------------------------------
	// Hook version drift branches
	// -------------------------------------------------------------------------

	it("warns when hook script has no version stamp", async () => {
		seedHealthyFs();
		fsState.content.set(HOOK_PATH, "// no stamp here\n");
		await run();
		expect(captured()).toContain(
			"[warn] Hook version -- No version stamp found (expected 1.2.3+mode-quality)",
		);
	});

	it("--fix regenerates a stamp-less hook and reports pass", async () => {
		seedHealthyFs();
		fsState.content.set(HOOK_PATH, "// no stamp here\n");
		await run({ fix: true });
		expect(mockWriteHookScript).toHaveBeenCalledWith(CWD);
		expect(captured()).toContain(
			"[pass] Hook version -- Regenerated hook script (v1.2.3+mode-quality)",
		);
	});

	it("warns when installed hook version differs from expected", async () => {
		seedHealthyFs();
		fsState.content.set(HOOK_PATH, "// interlinked-hook-version: 0.0.1+mode-quality\n");
		await run();
		expect(captured()).toContain(
			"[warn] Hook version -- Installed v0.0.1+mode-quality, expected v1.2.3+mode-quality",
		);
	});

	it("--fix updates a drifted hook and reports the version transition", async () => {
		seedHealthyFs();
		fsState.content.set(HOOK_PATH, "// interlinked-hook-version: 0.0.1+mode-quality\n");
		await run({ fix: true });
		expect(mockWriteHookScript).toHaveBeenCalledWith(CWD);
		expect(captured()).toContain(
			"[pass] Hook version -- Updated hook script from v0.0.1+mode-quality to v1.2.3+mode-quality",
		);
	});

	it("expectedHookVersion uses a non-default mode from config.json", async () => {
		seedHealthyFs();
		fsState.content.set(SHARED_CFG, JSON.stringify({ mode: "budget" }));
		mockMigrateLegacyMode.mockReturnValue("budget");
		// Hook stamped for quality -> drift vs expected budget.
		fsState.content.set(HOOK_PATH, "// interlinked-hook-version: 1.2.3+mode-quality\n");
		await run();
		expect(captured()).toContain(
			"[warn] Hook version -- Installed v1.2.3+mode-quality, expected v1.2.3+mode-budget",
		);
	});

	it("expectedHookVersion falls back to default mode when config.json is malformed", async () => {
		seedHealthyFs();
		fsState.content.set(SHARED_CFG, "{ not valid json");
		// Hook stamped current for the default (quality) mode -> still 'current'.
		await run();
		expect(captured()).toContain("[pass] Hook version -- v1.2.3+mode-quality (current)");
	});

	it("expectedHookVersion ignores a non-string mode value (uses default)", async () => {
		seedHealthyFs();
		fsState.content.set(SHARED_CFG, JSON.stringify({ mode: 42 }));
		await run();
		// migrateLegacyMode(undefined,...) default mock returns quality.
		expect(mockMigrateLegacyMode).toHaveBeenCalledWith(undefined, undefined);
		expect(captured()).toContain("[pass] Hook version -- v1.2.3+mode-quality (current)");
	});

	it("P1: expectedHookVersion reads a valid string mode from config.json", async () => {
		seedHealthyFs();
		fsState.content.set(SHARED_CFG, JSON.stringify({ mode: "ci" }));
		mockMigrateLegacyMode.mockReturnValue("ci");
		await run();
		// Proves the string was actually read out of config.json and reached
		// migrateLegacyMode -- the mismatch vs the "quality"-stamped hook (from
		// seedHealthyFs) surfaces as a warn naming "mode-ci" as expected.
		expect(mockMigrateLegacyMode).toHaveBeenCalledWith("ci", undefined);
		expect(captured()).toContain(
			"[warn] Hook version -- Installed v1.2.3+mode-quality, expected v1.2.3+mode-ci",
		);
	});

	it("N1: expectedHookVersion treats a top-level JSON array as no usable mode", async () => {
		seedHealthyFs();
		fsState.content.set(SHARED_CFG, JSON.stringify(["not", "an", "object"]));
		await run();
		expect(mockMigrateLegacyMode).toHaveBeenCalledWith(undefined, undefined);
		expect(captured()).toContain("[pass] Hook version -- v1.2.3+mode-quality (current)");
	});

	it("N2: expectedHookVersion treats a bare JSON null as no usable mode (no throw)", async () => {
		seedHealthyFs();
		fsState.content.set(SHARED_CFG, "null");
		await run();
		expect(mockMigrateLegacyMode).toHaveBeenCalledWith(undefined, undefined);
		expect(captured()).toContain("[pass] Hook version -- v1.2.3+mode-quality (current)");
	});

	it("warns when the hook script cannot be read for the version check", async () => {
		seedHealthyFs();
		fsState.throwOnReadFile.add(HOOK_PATH);
		await run();
		expect(captured()).toContain(
			"[warn] Hook version -- Could not read hook script for version check",
		);
	});

	it("expectedHookVersion uses the default mode when config.json is absent", async () => {
		// Hook script present (so version check runs) but config.json absent ->
		// expectedHookVersion skips the read and uses DEFAULT_HARNESS_MODE.
		fsState.exists.add(`${CWD}/.interlinked`);
		fsState.exists.add(`${CWD}/.interlinked/config.local.json`);
		fsState.exists.add(HOOK_PATH);
		// Stamp matches the default (quality) mode -> 'current'.
		fsState.content.set(HOOK_PATH, "// interlinked-hook-version: 1.2.3+mode-quality\n");
		await run();
		// config.json missing -> Shared config fails, but hook version is current.
		expect(captured()).toContain("[pass] Hook version -- v1.2.3+mode-quality (current)");
	});

	// -------------------------------------------------------------------------
	// Client hooks (5)
	// -------------------------------------------------------------------------

	it("reports installed client hooks when settings reference interlinked-activity", async () => {
		seedHealthyFs();
		fsState.exists.add(`${CWD}/.claude`);
		const settings = `${CWD}/.claude/settings.json`;
		fsState.exists.add(settings);
		fsState.content.set(
			settings,
			// Ownership is SHAPE-parsed (2026-08-30): the fixture must carry the
			// real generated legacy command, not the bare marker string.
			'{"hooks":{"PreToolUse":[{"command":"node \\".interlinked/hooks/interlinked-activity.mjs\\""}]}}',
		);
		await run();
		expect(captured()).toContain("[pass] Claude Code hooks -- Hooks installed");
	});

	it("warns when client settings exist but lack interlinked hooks", async () => {
		seedHealthyFs();
		fsState.exists.add(`${CWD}/.gemini`);
		const settings = `${CWD}/.gemini/settings.json`;
		fsState.exists.add(settings);
		fsState.content.set(settings, "{}");
		await run();
		expect(captured()).toContain(
			"[warn] Google Gemini CLI hooks -- Settings file exists but no Interlinked CLI hooks -- run 'interlinked enable'",
		);
	});

	// Codex's hook commands live in `.codex/hooks.json`; `config.toml` only
	// carries the `[features] hooks = true` gate. This case previously pointed
	// at config.toml, which is why doctor warned about every correct Codex
	// install — the path, not the read, was the defect.
	it("warns when client settings file cannot be read", async () => {
		seedHealthyFs();
		fsState.exists.add(`${CWD}/.codex`);
		const settings = `${CWD}/.codex/hooks.json`;
		fsState.exists.add(settings);
		fsState.throwOnReadFile.add(settings);
		await run();
		expect(captured()).toContain("[warn] OpenAI Codex CLI hooks -- Could not read settings file");
	});

	it("warns when a present client dir is missing its settings file", async () => {
		seedHealthyFs();
		fsState.exists.add(`${CWD}/.claude`); // dir present, settings.json absent
		await run();
		expect(captured()).toContain("[warn] Claude Code hooks -- settings.json not found");
	});

	it("skips clients whose dir is absent entirely", async () => {
		seedHealthyFs();
		await run();
		const out = captured();
		expect(out).not.toContain("Claude Code hooks");
		expect(out).not.toContain("Gemini CLI hooks");
		expect(out).not.toContain("Codex CLI hooks");
	});

	// -------------------------------------------------------------------------
	// Permission-rule hygiene (5b)
	// -------------------------------------------------------------------------

	it("warns about malformed permission rules and shows a truncation-free sample", async () => {
		seedHealthyFs();
		const settings = `${CWD}/.claude/settings.json`;
		mockDefaultSettingsPaths.mockReturnValue([settings]);
		mockValidateSettingsFile.mockReturnValue({
			exists: true,
			parseError: false,
			malformed: [{ rule: "Bash(-d) && cd && echo *)" }],
		});
		await run();
		const out = captured();
		expect(out).toContain("Permission rules (.claude/settings.json)");
		expect(out).toContain("1 malformed rule(s) -- e.g.");
		expect(out).toContain("Run 'interlinked doctor --fix' to strip.");
	});

	it("appends an ellipsis when the malformed sample hits the 60-char cap", async () => {
		seedHealthyFs();
		const settings = `${CWD}/.claude/settings.json`;
		const longRule = "B".repeat(80);
		mockDefaultSettingsPaths.mockReturnValue([settings]);
		mockValidateSettingsFile.mockReturnValue({
			exists: true,
			parseError: false,
			malformed: [{ rule: longRule }],
		});
		await run();
		expect(captured()).toContain(`${JSON.stringify("B".repeat(60))}...`);
	});

	it("--fix strips malformed permission rules and reports the count", async () => {
		seedHealthyFs();
		const settings = `${CWD}/.claude/settings.json`;
		mockDefaultSettingsPaths.mockReturnValue([settings]);
		mockValidateSettingsFile.mockReturnValue({
			exists: true,
			parseError: false,
			malformed: [{ rule: "Bash(-d *)" }],
		});
		mockStripMalformedRules.mockReturnValue(3);
		await run({ fix: true });
		expect(mockStripMalformedRules).toHaveBeenCalledWith(settings);
		expect(captured()).toContain(
			"[pass] Permission rules (.claude/settings.json) -- Stripped 3 malformed rule(s)",
		);
	});

	it("skips permission validation for files that don't exist or fail to parse", async () => {
		seedHealthyFs();
		mockDefaultSettingsPaths.mockReturnValue([`${CWD}/a.json`, `${CWD}/b.json`]);
		mockValidateSettingsFile
			.mockReturnValueOnce({ exists: false, parseError: false, malformed: [] })
			.mockReturnValueOnce({ exists: true, parseError: true, malformed: [] });
		await run();
		expect(captured()).not.toContain("Permission rules");
	});

	it("skips files with no malformed rules", async () => {
		seedHealthyFs();
		mockDefaultSettingsPaths.mockReturnValue([`${CWD}/a.json`]);
		mockValidateSettingsFile.mockReturnValue({
			exists: true,
			parseError: false,
			malformed: [],
		});
		await run();
		expect(captured()).not.toContain("Permission rules");
	});

	it("substitutes ~ for an unset HOME when rendering the settings path", async () => {
		seedHealthyFs();
		const homeBackup = process.env.HOME;
		delete process.env.HOME;
		const settings = `${CWD}/.claude/settings.json`;
		mockDefaultSettingsPaths.mockReturnValue([settings]);
		mockValidateSettingsFile.mockReturnValue({
			exists: true,
			parseError: false,
			malformed: [{ rule: "Bash(-d *)" }],
		});
		try {
			await run();
		} finally {
			if (homeBackup !== undefined) process.env.HOME = homeBackup;
		}
		expect(captured()).toContain("Permission rules (.claude/settings.json)");
	});


	// -------------------------------------------------------------------------
	// Auth token (6)
	// -------------------------------------------------------------------------

	it("fails the auth token check against a remote server when no token", async () => {
		seedHealthyFs();
		mockResolveAuthToken.mockReturnValue(null);
		await run();
		const out = captured();
		expect(out).toContain("[FAIL] Auth token -- No auth token -- run 'interlinked login'");
		expect(out).toContain("[warn] Server checks -- Skipped -- no auth token available");
		expect(process.exitCode).toBe(1);
	});

	it("warns (not fails) on missing token against a localhost dev server", async () => {
		seedHealthyFs();
		mockResolveAuthToken.mockReturnValue(null);
		mockResolveConfig.mockReturnValue({
			server_url: "http://localhost:8787",
			agent_name: "Worker-Alpha",
		});
		await run();
		const out = captured();
		expect(out).toContain(
			"[warn] Auth token -- No auth token (localhost dev mode allows unauthenticated access)",
		);
		// localhost detection must not flip exit code via the auth check alone.
		expect(out).not.toContain("[FAIL] Auth token");
	});

	it("treats 127.0.0.1 as a dev server for the auth-token branch", async () => {
		seedHealthyFs();
		mockResolveAuthToken.mockReturnValue(null);
		mockResolveConfig.mockReturnValue({
			server_url: "http://127.0.0.1:8787",
			agent_name: "Worker-Alpha",
		});
		await run();
		expect(captured()).toContain("[warn] Auth token -- No auth token (localhost dev mode");
	});

	// -------------------------------------------------------------------------
	// Legacy config (7)
	// -------------------------------------------------------------------------

	it("warns about a detected legacy config", async () => {
		seedHealthyFs();
		mockHasLegacyConfig.mockReturnValue(true);
		await run();
		expect(captured()).toContain(
			"[warn] Legacy config -- Found .claude/interlinked-session.json",
		);
	});

	it("--fix migrates legacy config and reports success", async () => {
		seedHealthyFs();
		mockHasLegacyConfig.mockReturnValue(true);
		mockMigrateLegacyConfig.mockReturnValue(true);
		await run({ fix: true });
		expect(mockMigrateLegacyConfig).toHaveBeenCalledWith(CWD);
		expect(captured()).toContain(
			"[pass] Legacy config -- Migrated .claude/interlinked-session.json to .interlinked/",
		);
	});

	it("--fix leaves the legacy warning in place when migration returns false", async () => {
		seedHealthyFs();
		mockHasLegacyConfig.mockReturnValue(true);
		mockMigrateLegacyConfig.mockReturnValue(false);
		await run({ fix: true });
		const out = captured();
		// Still the warning, not the migrated pass message.
		expect(out).toContain("[warn] Legacy config -- Found .claude/interlinked-session.json");
		expect(out).not.toContain("Migrated .claude/interlinked-session.json");
	});

	// -------------------------------------------------------------------------
	// Stale session files (8)
	// -------------------------------------------------------------------------

	it("warns about stale session files (mtime older than 24h)", async () => {
		seedHealthyFs();
		const sessionsDir = `${CWD}/.interlinked/sessions`;
		fsState.exists.add(sessionsDir);
		fsState.dir.set(sessionsDir, ["old.json", "fresh.json"]);
		fsState.mtime.set(`${sessionsDir}/old.json`, Date.now() - 48 * 60 * 60 * 1000);
		fsState.mtime.set(`${sessionsDir}/fresh.json`, Date.now());
		await run();
		expect(captured()).toContain(
			"[warn] Session files -- 1 stale session file(s) in .interlinked/sessions",
		);
	});

	it("passes with an active-count when sessions are all fresh", async () => {
		seedHealthyFs();
		const sessionsDir = `${CWD}/.interlinked/sessions`;
		fsState.exists.add(sessionsDir);
		fsState.dir.set(sessionsDir, ["a.json", "b.json"]);
		fsState.mtime.set(`${sessionsDir}/a.json`, Date.now());
		fsState.mtime.set(`${sessionsDir}/b.json`, Date.now());
		await run();
		expect(captured()).toContain("[pass] Session files -- 2 active session file(s)");
	});

	it("passes with a 'No session files' message when the dir is empty", async () => {
		seedHealthyFs();
		const sessionsDir = `${CWD}/.interlinked/sessions`;
		fsState.exists.add(sessionsDir);
		fsState.dir.set(sessionsDir, []);
		await run();
		expect(captured()).toContain("[pass] Session files -- No session files");
	});

	it("treats an un-stat-able session file as non-stale (statSync throws)", async () => {
		seedHealthyFs();
		const sessionsDir = `${CWD}/.interlinked/sessions`;
		fsState.exists.add(sessionsDir);
		fsState.dir.set(sessionsDir, ["ghost.json"]);
		// No mtime entry -> statSync throws -> filter returns false -> not stale.
		await run();
		expect(captured()).toContain("[pass] Session files -- 1 active session file(s)");
	});

	it("warns when the sessions dir cannot be read (readdirSync throws)", async () => {
		seedHealthyFs();
		const sessionsDir = `${CWD}/.interlinked/sessions`;
		fsState.exists.add(sessionsDir);
		fsState.throwOnReaddir.add(sessionsDir);
		await run();
		expect(captured()).toContain(
			"[warn] Session files -- Could not read .interlinked/sessions",
		);
	});

	it("falls back to the legacy agent-sessions dir when sessions/ is absent", async () => {
		seedHealthyFs();
		const legacyDir = `${CWD}/.interlinked/hooks/agent-sessions`;
		fsState.exists.add(legacyDir);
		fsState.dir.set(legacyDir, ["s.json"]);
		fsState.mtime.set(`${legacyDir}/s.json`, Date.now());
		await run();
		expect(captured()).toContain("[pass] Session files -- 1 active session file(s)");
	});

	it("omits the Session files check entirely when no sessions dir exists", async () => {
		seedHealthyFs();
		await run();
		expect(captured()).not.toContain("Session files");
	});

	// -------------------------------------------------------------------------
	// Harness server (10). A pid is not evidence: the row is decided by a real
	// socket round-trip, so the three states below are distinguishable (audit
	// F1 — doctor used to print `[pass]` for the middle one).
	// -------------------------------------------------------------------------

	// P: pid alive AND the socket answered → the only state that passes.
	it("reports a running harness with its PID when the socket answers", async () => {
		seedHealthyFs();
		mockIsHarnessRunning.mockReturnValue({ running: true, pid: 4242 });
		fsState.exists.add(`${CWD}/.interlinked/harness.sock`);
		mockQueryHarness.mockResolvedValue({ decision: "allow" });
		await run();
		expect(captured()).toContain("[pass] Harness server -- Running (PID 4242) -- socket answering");
	});

	// P: pid alive, socket silent → the ZOMBIE. Must FAIL loudly, and must say
	// what it costs the user, not just that a socket is missing.
	it("FAILS with a ZOMBIE row when the pid is alive but nothing answers", async () => {
		seedHealthyFs();
		mockIsHarnessRunning.mockReturnValue({ running: true, pid: 4242 });
		fsState.exists.add(`${CWD}/.interlinked/harness.sock`);
		mockQueryHarness.mockResolvedValue(null); // connected to nothing
		await run();
		const out = captured();
		expect(out).toContain("[FAIL] Harness server -- ZOMBIE DAEMON: Harness PID 4242 is alive");
		expect(out).toContain("interlinked harness restart");
		expect(out).not.toContain("[pass] Harness server");
	});

	// P: a socket file that does not exist is never dialed — the probe must
	// short-circuit rather than open a connection that can only fail.
	it("does not attempt a round-trip when the socket file is absent", async () => {
		seedHealthyFs();
		mockIsHarnessRunning.mockReturnValue({ running: true, pid: 4242 });
		await run();
		expect(mockQueryHarness).not.toHaveBeenCalled();
		expect(captured()).toContain("[FAIL] Harness server -- ZOMBIE DAEMON");
	});

	it("warns about a stale socket when the harness isn't running", async () => {
		seedHealthyFs();
		mockIsHarnessRunning.mockReturnValue({ running: false });
		fsState.exists.add(`${CWD}/.interlinked/harness.sock`);
		await run();
		expect(captured()).toContain(
			"[warn] Harness server -- Stale socket found but process not running",
		);
	});

	it("warns about inline fallback when neither process nor socket exist", async () => {
		seedHealthyFs();
		mockIsHarnessRunning.mockReturnValue({ running: false });
		await run();
		expect(captured()).toContain(
			"[warn] Harness server -- Not running -- guard evaluation uses inline fallback",
		);
	});

	// -------------------------------------------------------------------------
	// Guard rules (11)
	// -------------------------------------------------------------------------

	it("warns when guard-rules.json is absent", async () => {
		fsState.exists.add(`${CWD}/.interlinked`);
		fsState.exists.add(SHARED_CFG);
		fsState.exists.add(`${CWD}/.interlinked/config.local.json`);
		fsState.exists.add(HOOK_PATH);
		fsState.content.set(HOOK_PATH, "// interlinked-hook-version: 1.2.3+mode-quality\n");
		fsState.content.set(SHARED_CFG, JSON.stringify({ mode: "quality" }));
		// guard-rules.json deliberately not added.
		await run();
		expect(captured()).toContain(
			"[warn] Guard rules -- guard-rules.json not found -- harness uses built-in rules only",
		);
	});

	// -------------------------------------------------------------------------
	// System checks (runSystemChecks output is surfaced)
	// -------------------------------------------------------------------------

	it("surfaces system-check results ahead of config checks", async () => {
		seedHealthyFs();
		mockRunSystemChecks.mockReturnValue([
			{ name: "CPU cores", status: "pass", message: "8 cores" },
		]);
		await run();
		expect(captured()).toContain("[pass] CPU cores -- 8 cores");
	});

	it("counts a failing system check toward the exit code", async () => {
		seedHealthyFs();
		mockRunSystemChecks.mockReturnValue([
			{ name: "Free memory", status: "fail", message: "1.0 GB free" },
		]);
		await run();
		expect(captured()).toContain("[FAIL] Free memory -- 1.0 GB free");
		expect(process.exitCode).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Server checks (need auth) — reachable / unreachable / auth states
	// -------------------------------------------------------------------------

	it("reports server reachable + authenticated + workspaces + codebases", async () => {
		seedHealthyFs();
		await run();
		const out = captured();
		expect(out).toContain(
			"[pass] Server reachable -- Connected to https://remote.example.com",
		);
		expect(out).toContain("[pass] Auth valid -- Server v9.9.9");
		expect(out).toContain("[pass] Registry workspace access -- 1 workspace(s) accessible");
		expect(out).toContain(
			"[pass] Codebase access (active workspace) -- 1 codebase(s) in active workspace",
		);
	});

	it("reports Authenticated (no version) when serverVersion is absent", async () => {
		seedHealthyFs();
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
		await run();
		expect(captured()).toContain("[pass] Auth valid -- Authenticated");
	});

	it("fails server-reachable using health.error when serverReachable is false", async () => {
		seedHealthyFs();
		mockHealthCheck.mockResolvedValue({
			serverReachable: false,
			authenticated: false,
			error: "ECONNREFUSED",
		});
		await run();
		const out = captured();
		expect(out).toContain("[FAIL] Server reachable -- ECONNREFUSED");
		// Auth valid only emits a fail branch when serverReachable is true.
		expect(out).not.toContain("Auth valid");
		expect(process.exitCode).toBe(1);
	});

	it("falls back to 'Server unreachable' when health.error is empty", async () => {
		seedHealthyFs();
		mockHealthCheck.mockResolvedValue({
			serverReachable: false,
			authenticated: false,
			error: "",
		});
		await run();
		expect(captured()).toContain("[FAIL] Server reachable -- Server unreachable");
	});

	it("fails Auth valid when reachable but not authenticated", async () => {
		seedHealthyFs();
		mockHealthCheck.mockResolvedValue({
			serverReachable: true,
			authenticated: false,
			error: "bad token",
		});
		await run();
		expect(captured()).toContain("[FAIL] Auth valid -- bad token -- run 'interlinked login'");
	});

	it("uses a default auth-failure message when reachable, unauthenticated, no error", async () => {
		seedHealthyFs();
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: false });
		await run();
		expect(captured()).toContain(
			"[FAIL] Auth valid -- Authentication failed -- run 'interlinked login'",
		);
	});

	it("warns when zero registry workspaces are accessible", async () => {
		seedHealthyFs();
		mockFetchWorkspaces.mockResolvedValue([]);
		await run();
		expect(captured()).toContain(
			"[warn] Registry workspace access -- No registry workspaces found",
		);
	});

	it("fails registry workspace access when fetchWorkspaces throws an Error", async () => {
		seedHealthyFs();
		mockFetchWorkspaces.mockRejectedValue(new Error("registry down"));
		await run();
		expect(captured()).toContain("[FAIL] Registry workspace access -- registry down");
	});

	it("fails registry workspace access with a default message for a non-Error throw", async () => {
		seedHealthyFs();
		mockFetchWorkspaces.mockRejectedValue("boom");
		await run();
		expect(captured()).toContain(
			"[FAIL] Registry workspace access -- Could not list registry workspaces",
		);
	});

	it("warns when no codebases are found in the active workspace", async () => {
		seedHealthyFs();
		mockCallTool.mockResolvedValue({ workspaces: [] });
		await run();
		expect(captured()).toContain(
			"[warn] Codebase access (active workspace) -- No codebases found in active workspace",
		);
	});

	it("treats a missing workspaces field as zero codebases", async () => {
		seedHealthyFs();
		mockCallTool.mockResolvedValue({});
		await run();
		expect(captured()).toContain(
			"[warn] Codebase access (active workspace) -- No codebases found in active workspace",
		);
	});

	it("warns (not fails) on a codebase-list Error", async () => {
		seedHealthyFs();
		mockCallTool.mockRejectedValue(new Error("DO offline"));
		await run();
		expect(captured()).toContain("[warn] Codebase access (active workspace) -- DO offline");
	});

	it("warns with a default message on a non-Error codebase-list throw", async () => {
		seedHealthyFs();
		mockCallTool.mockRejectedValue(123);
		await run();
		expect(captured()).toContain(
			"[warn] Codebase access (active workspace) -- Could not list codebases in active workspace",
		);
	});

	it("skips workspace + codebase checks when reachable but unauthenticated", async () => {
		seedHealthyFs();
		mockHealthCheck.mockResolvedValue({
			serverReachable: true,
			authenticated: false,
			error: "nope",
		});
		await run();
		const out = captured();
		expect(out).not.toContain("Registry workspace access");
		expect(out).not.toContain("Codebase access");
		expect(mockFetchWorkspaces).not.toHaveBeenCalled();
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("fails server-reachable when the whole health check throws an Error", async () => {
		seedHealthyFs();
		mockHealthCheck.mockRejectedValue(new Error("socket hang up"));
		await run();
		expect(captured()).toContain("[FAIL] Server reachable -- socket hang up");
		expect(process.exitCode).toBe(1);
	});

	it("fails server-reachable with a default message on a non-Error throw", async () => {
		seedHealthyFs();
		mockHealthCheck.mockRejectedValue("kaboom");
		await run();
		expect(captured()).toContain("[FAIL] Server reachable -- Connection failed");
	});

	// -------------------------------------------------------------------------
	// JSON output mode
	// -------------------------------------------------------------------------

	describe("--json output", () => {
		it("emits local/server arrays and an accurate summary", async () => {
			seedHealthyFs();
			await run({ json: true });
			const payload = capturedJson();
			expect(Array.isArray(payload.local)).toBe(true);
			expect(Array.isArray(payload.server)).toBe(true);
			// local includes Config directory; server includes Server reachable.
			expect(payload.local.some((r) => r.name === "Config directory")).toBe(true);
			expect(payload.server.some((r) => r.name === "Server reachable")).toBe(true);
			// Summary counts must equal the actual status tallies across both lists.
			const all = [...payload.local, ...payload.server];
			expect(payload.summary.pass).toBe(all.filter((r) => r.status === "pass").length);
			expect(payload.summary.fail).toBe(all.filter((r) => r.status === "fail").length);
			expect(payload.summary.warn).toBe(all.filter((r) => r.status === "warn").length);
		});

		it("reports a non-zero fail tally and exit code in JSON mode on failure", async () => {
			// No fs seeded -> config dir + shared config fail.
			await run({ json: true });
			const payload = capturedJson();
			expect(payload.summary.fail).toBeGreaterThan(0);
			expect(process.exitCode).toBe(1);
			// The --fix hint is normal-mode only; never in JSON.
			expect(captured()).not.toContain("doctor --fix");
		});
	});

	// -------------------------------------------------------------------------
	// Normal-mode summary composition (pass/fail/warn segments)
	// -------------------------------------------------------------------------

	it("includes failed + warnings segments in the summary when both are present", async () => {
		// config dir/shared missing -> fails; local config missing -> warn.
		await run();
		const out = captured();
		expect(out).toContain("failed");
		expect(out).toContain("warnings");
	});

	it("omits the warnings segment when there are zero warnings", async () => {
		// Drive a state with passes + at least one fail but no warns:
		// healthy fs (all pass), running harness (no fallback warn), a failing
		// system check, agent_name set, token present, server fully healthy.
		seedHealthyFs();
		mockIsHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		mockRunSystemChecks.mockReturnValue([
			{ name: "CPU cores", status: "fail", message: "1 core" },
		]);
		await run();
		const out = captured();
		expect(out).toContain("failed");
		expect(out).not.toContain("warnings");
	});
});
