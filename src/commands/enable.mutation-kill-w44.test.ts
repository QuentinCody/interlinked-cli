// ===========================================
// enable.ts — wave pass1_w44 mutation-kill suite
// ===========================================
// Targets a specific set of live survivors from the mutation report:
// banner/"Installing hooks:" strings, printSkillInstallResults'
// filter/slice/join behavior, maybeMigrateLegacyConfig's guard, the
// "Error:" string, printInstallResults' +/x/- markers and the
// installedCount===0 guard, ensureIndexBuilt's path segments + object
// literal, startHarnessIfNeeded's "!" marker, noteUndetectedClients'
// && vs || logic, printSummary's "Configuration:" header and the
// --clients hint string, and printDryRun's separator / legacy branch /
// gitignore header / options.agent branch.
//
// Each mocked module boundary mirrors ./enable.test.ts so the command
// runs without touching the real filesystem or network.

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstallResult } from "../lib/hook-types.js";
import type { ClientName } from "../lib/settings.js";
import type { SkillInstallResult } from "../lib/skill-installers.js";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock("../lib/config.js", () => ({
	getConfigDir: vi.fn(),
	hasLegacyConfig: vi.fn(),
	initConfig: vi.fn(),
	isConfigured: vi.fn(),
	migrateLegacyConfig: vi.fn(),
	resolveConfig: vi.fn(),
	updateLocalConfig: vi.fn(),
}));

vi.mock("../lib/guard-state.js", () => ({
	clearGuardDisable: vi.fn(() => ({ cleared: [] })),
}));

vi.mock("../lib/hooks.js", () => ({
	detectHookManagers: vi.fn(),
	ensureGitignore: vi.fn(),
	getHookScriptPath: vi.fn(),
	installAllHooks: vi.fn(),
	installStatusLine: vi.fn(),
	writeHookScript: vi.fn(),
}));

vi.mock("../lib/settings.js", () => ({
	detectClients: vi.fn(),
	// Pure id-translation table, not a seam — mocked with the real values so the
	// dry-run summary resolves the same adapters production does.
	CLIENT_TO_RUNNER: {
		claude: "claude-code",
		copilot: "copilot-cli",
		gemini: "gemini-cli",
		codex: "codex",
		cursor: "cursor",
		opencode: "opencode",
		pi: "pi",
	},
}));

vi.mock("../lib/skill-installers.js", () => ({
	installSkills: vi.fn(),
}));

vi.mock("./harness.js", () => ({
	harnessStartCommand: vi.fn(),
	isHarnessRunning: vi.fn(),
}));

// Custom trigram mock (unlike enable.test.ts's arg-discarding stub) so we
// can assert on the `{ cwd }` object literal and the save() path segment.
let trigramSaveMock: ReturnType<typeof vi.fn>;
const trigramBuildMock = vi.fn((opts: unknown) => {
	trigramSaveMock = vi.fn();
	return { save: trigramSaveMock, stats: () => ({ fileCount: 7 }) };
});
vi.mock("../harness/trigram-index.js", () => ({
	TrigramIndex: { build: (opts: unknown) => trigramBuildMock(opts) },
}));

vi.mock("./structure.js", () => ({
	structureInitCommand: vi.fn(),
}));

import { existsSync } from "node:fs";
import {
	getConfigDir,
	hasLegacyConfig,
	isConfigured,
	migrateLegacyConfig,
	resolveConfig,
} from "../lib/config.js";
import { stripAnsi } from "../lib/formatter.js";
import {
	detectHookManagers,
	ensureGitignore,
	getHookScriptPath,
	installAllHooks,
	installStatusLine,
	writeHookScript,
} from "../lib/hooks.js";
import { detectClients } from "../lib/settings.js";
import { installSkills } from "../lib/skill-installers.js";
import { enableCommand } from "./enable.js";
import { harnessStartCommand, isHarnessRunning } from "./harness.js";
import { structureInitCommand } from "./structure.js";

const CWD = "/fake/project";

function install(client: ClientName, over: Partial<InstallResult> = {}): InstallResult {
	return { client, installed: false, events: [], ...over };
}

function detected(name: ClientName, exists: boolean) {
	return { name, settingsPath: `${CWD}/.${name}/settings.json`, exists };
}

function skill(client: ClientName, over: Partial<SkillInstallResult> = {}): SkillInstallResult {
	return { skill: "enforce", client, path: `${CWD}/skill/${client}`, installed: false, ...over };
}

function logged(spy: ReturnType<typeof vi.spyOn>): string {
	const calls = spy.mock.calls as unknown[][];
	return stripAnsi(calls.map((args) => args.join(" ")).join("\n"));
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	process.exitCode = undefined;
	vi.spyOn(process, "cwd").mockReturnValue(CWD);

	vi.mocked(isConfigured).mockReturnValue(false);
	vi.mocked(hasLegacyConfig).mockReturnValue(false);
	vi.mocked(migrateLegacyConfig).mockReturnValue(false);
	vi.mocked(getConfigDir).mockReturnValue(`${CWD}/.interlinked`);
	vi.mocked(resolveConfig).mockReturnValue({
		server_url: "http://localhost:8787",
		sync_mode: "realtime",
	} as never);
	vi.mocked(detectHookManagers).mockReturnValue([]);
	vi.mocked(writeHookScript).mockReturnValue(`${CWD}/.interlinked/hooks/interlinked-activity.mjs`);
	vi.mocked(getHookScriptPath).mockReturnValue(
		`${CWD}/.interlinked/hooks/interlinked-activity.mjs`,
	);
	vi.mocked(detectClients).mockReturnValue([]);
	vi.mocked(installAllHooks).mockReturnValue([]);
	vi.mocked(ensureGitignore).mockReturnValue(false);
	vi.mocked(installStatusLine).mockReturnValue(null);
	vi.mocked(installSkills).mockReturnValue([]);
	vi.mocked(isHarnessRunning).mockReturnValue({ running: true, pid: 4242 } as never);
	vi.mocked(harnessStartCommand).mockResolvedValue(undefined);
	vi.mocked(structureInitCommand).mockResolvedValue(undefined);
});

afterEach(() => {
	process.exitCode = undefined;
	vi.restoreAllMocks();
});

// --- banner separator + "Installing hooks:" (c87653cc, a9e5c8c6, c2c5f63b) --

describe("enableCommand — installing-hooks banner", () => {
	it("prints the 40-dash separator and the Installing hooks header", async () => {
		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("─".repeat(40));
		expect(out).toContain("Installing hooks:");
	});
});

// --- printSkillInstallResults: filter / slice / join --------------------

describe("printSkillInstallResults", () => {
	it("uses the FIRST error-bearing entry as the header error, skipping error-less entries (kills filter mutants)", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installSkills).mockReturnValue([
			skill("codex", { installed: false }), // no error
			skill("claude", { installed: false, error: "boom" }),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Interlinked skills: not installed — boom");
	});

	it("does not repeat the header error in the per-line warnings (kills errors.slice(1)->errors)", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installSkills).mockReturnValue([
			skill("codex", { installed: false, error: "err1" }),
			skill("claude", { installed: false, error: "err2" }),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Interlinked skills: not installed — err1");
		// err1 already shown in the header line; the per-line loop must skip it.
		expect(out).not.toContain("enforce/codex: err1");
		expect(out).toContain("enforce/claude: err2");
	});

	it("joins multiple installed clients with a comma-space (kills the \", \" -> \"\" mutant)", async () => {
		vi.mocked(detectClients).mockReturnValue([
			detected("claude", true),
			detected("codex", true),
		]);
		vi.mocked(installSkills).mockReturnValue([
			skill("claude", { installed: true }),
			skill("codex", { installed: true }),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Installed Interlinked skills for claude, codex");
	});
});

// --- maybeMigrateLegacyConfig guard (ff51b43f) ---------------------------

describe("maybeMigrateLegacyConfig", () => {
	it("does nothing when hasLegacyConfig is false", async () => {
		vi.mocked(hasLegacyConfig).mockReturnValue(false);

		await enableCommand({});

		expect(vi.mocked(migrateLegacyConfig)).not.toHaveBeenCalled();
		expect(logged(logSpy)).not.toContain("Legacy config detected");
	});
});

// --- applyOptionFlags "Error:" string (ca70682819c2c06b) -----------------

describe("applyOptionFlags — invalid sync mode", () => {
	it("prefixes the message with 'Error:'", async () => {
		await enableCommand({ syncMode: "turbo" });

		expect(logged(errorSpy)).toContain("Error: Invalid sync mode");
		expect(process.exitCode).toBe(1);
		expect(vi.mocked(writeHookScript)).not.toHaveBeenCalled();
	});
});

// --- printInstallResults markers + installedCount guard -----------------

describe("printInstallResults", () => {
	it("renders +/x/- markers for installed / error / no-op results", async () => {
		vi.mocked(detectClients).mockReturnValue([
			detected("claude", true),
			detected("copilot", true),
			detected("gemini", true),
		]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("claude", { installed: true, events: ["PreToolUse"] }),
			install("copilot", { error: "boom" }),
			install("gemini"),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("+ claude —");
		expect(out).toContain("x copilot —");
		expect(out).toContain("- gemini —");
	});

	it("does not warn when at least one hook installed (kills installedCount===0 -> true)", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("claude", { installed: true, events: ["PreToolUse"] }),
		]);

		await enableCommand({});

		expect(logged(logSpy)).not.toContain("Warning: No hooks were installed.");
	});
});

// --- ensureIndexBuilt path segments + object literal ---------------------

describe("ensureIndexBuilt", () => {
	it("checks the exact .interlinked/index/trigram.lookup path", async () => {
		await enableCommand({});

		expect(vi.mocked(existsSync)).toHaveBeenCalledWith(
			join(CWD, ".interlinked", "index", "trigram.lookup"),
		);
	});

	it("passes { cwd } through to TrigramIndex.build and saves to .interlinked", async () => {
		await enableCommand({});

		expect(trigramBuildMock).toHaveBeenCalledWith({ cwd: CWD });
		expect(trigramSaveMock).toHaveBeenCalledWith(join(CWD, ".interlinked"));
		expect(logged(logSpy)).toContain("Built trigram search index (7 files)");
	});

	it("prints the '!' failure marker when the build throws", async () => {
		trigramBuildMock.mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		await enableCommand({});

		expect(logged(logSpy)).toContain("! Trigram index build failed (disk full)");
	});
});

// --- startHarnessIfNeeded "!" marker (d98159d5) --------------------------

describe("startHarnessIfNeeded", () => {
	it("prints the '!' failure marker when harness start throws", async () => {
		vi.mocked(isHarnessRunning).mockReturnValue({ running: false } as never);
		vi.mocked(harnessStartCommand).mockRejectedValue(new Error("port in use"));

		await enableCommand({});

		expect(logged(logSpy)).toContain("! Failed to start harness.");
	});
});

// --- structure scaffolding "!" marker (shares symbol pool with above) ----

describe("maybeScaffoldStructure", () => {
	it("prints the '!' failure marker when scaffolding throws", async () => {
		vi.mocked(structureInitCommand).mockRejectedValue(new Error("bad mode"));

		await enableCommand({ structure: "standard" });

		expect(logged(logSpy)).toContain("! Structure scaffolding failed: bad mode");
	});
});

// --- noteUndetectedClients && vs || (e961ad9f) ---------------------------

describe("noteUndetectedClients", () => {
	it("excludes the fallback-forced client from the undetected list (kills && -> ||)", async () => {
		// Nothing detected -> targetClients falls back to ["claude"], so
		// claude must NOT appear in the "Not detected" hint even though
		// `detected` is empty.
		vi.mocked(detectClients).mockReturnValue([]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("claude", { installed: true, events: ["PreToolUse"] }),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Not detected: copilot, gemini, codex, cursor, opencode, opencode2, pi");
	});
});

// --- printSummary "Configuration:" header + --clients hint ---------------

describe("printSummary", () => {
	it("prints the Configuration: header", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("claude", { installed: true, events: ["PreToolUse"] }),
		]);

		await enableCommand({});

		expect(logged(logSpy)).toContain("Configuration:");
	});

	it("includes the full --clients hint in the inactive-hooks fork", async () => {
		vi.mocked(detectClients).mockReturnValue([]);
		vi.mocked(installAllHooks).mockReturnValue([install("claude")]);

		await enableCommand({});

		expect(logged(logSpy)).toContain(
			"--clients claude,copilot,gemini,codex,cursor,opencode,opencode2,pi",
		);
	});
});

// --- printDryRun: separator, legacy branch, gitignore header, agent -----

describe("printDryRun", () => {
	it("prints the 40-dash separator", async () => {
		vi.mocked(detectClients).mockReturnValue([]);

		await enableCommand({ dryRun: true });

		expect(logged(logSpy)).toContain("─".repeat(40));
	});

	it("does not print a Migrate line when hasLegacyConfig is false", async () => {
		vi.mocked(hasLegacyConfig).mockReturnValue(false);
		vi.mocked(detectClients).mockReturnValue([]);

		await enableCommand({ dryRun: true });

		expect(logged(logSpy)).not.toContain("Migrate:");
	});

	it("prints the Would update .gitignore with: header", async () => {
		vi.mocked(detectClients).mockReturnValue([]);

		await enableCommand({ dryRun: true });

		expect(logged(logSpy)).toContain("Would update .gitignore with:");
	});

	it("omits the Agent line when no --agent flag is passed", async () => {
		vi.mocked(detectClients).mockReturnValue([]);

		await enableCommand({ dryRun: true });

		expect(logged(logSpy)).not.toContain("Agent:");
	});
});
