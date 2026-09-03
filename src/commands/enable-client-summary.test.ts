// ===========================================
// enable-client-summary — behavioral coverage
// ===========================================
// Covers the client-summary/skill-install/index/harness-autostart helpers
// extracted from enable.ts: clientSummary event-count text, skill install
// reporting, requested-client parsing (valid/unknown/none), invalid-value
// reporting, trigram index build (skip/ok/fail), harness autostart
// (already-running/starts/start-fails), and buildPostEnableNotes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
}));

vi.mock("../lib/formatter.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/formatter.js")>(
		"../lib/formatter.js",
	);
	return actual;
});

vi.mock("../lib/settings.js", () => ({
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

const trigramBuildMock = vi.fn(() => ({
	save: vi.fn(),
	stats: vi.fn(() => ({ fileCount: 42 })),
}));
vi.mock("../harness/trigram-index.js", () => ({
	TrigramIndex: { build: () => trigramBuildMock() },
}));

import { existsSync } from "node:fs";
import { getAdapter } from "../harness/adapters/index.js";
import { stripAnsi } from "../lib/formatter.js";
import { installSkills } from "../lib/skill-installers.js";
import type { SkillInstallResult } from "../lib/skill-installers.js";
import {
	buildPostEnableNotes,
	clientSummary,
	ensureIndexBuilt,
	installSkillsForClients,
	parseRequestedClients,
	reportInvalidExplicitValue,
	startHarnessIfNeeded,
} from "./enable-client-summary.js";
import { harnessStartCommand, isHarnessRunning } from "./harness.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	process.exitCode = undefined;
});

afterEach(() => {
	logSpy.mockRestore();
	errorSpy.mockRestore();
	process.exitCode = undefined;
});

function logLines(): string[] {
	return logSpy.mock.calls.map((call: unknown[]) => stripAnsi(String(call[0])));
}

// --- clientSummary ---------------------------------------------------------

describe("clientSummary", () => {
	it("computes the event count from the real adapter (claude)", () => {
		const summary = clientSummary("claude");
		expect(summary).not.toBeNull();
		expect(summary?.label).toBe("claude");
		const adapter = getAdapter("claude-code");
		expect(summary?.eventCountText).toContain(`${adapter?.nativeEventNames.length} event`);
		expect(summary?.eventCountText).toContain(".claude/settings.json");
	});

	it("pluralizes singular event counts correctly", () => {
		const summary = clientSummary("gemini");
		expect(summary).not.toBeNull();
		if ((summary?.eventCountText.match(/^1 event /) ?? null) !== null) {
			expect(summary?.eventCountText.startsWith("1 event (")).toBe(true);
		} else {
			expect(summary?.eventCountText).toMatch(/^\d+ events \(/);
		}
	});
});

// --- installSkillsForClients / printSkillInstallResults --------------------

describe("installSkillsForClients", () => {
	it("does nothing for an empty client list", () => {
		installSkillsForClients("/repo", []);
		expect(installSkills).not.toHaveBeenCalled();
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("reports installed skills grouped by client", () => {
		const results: SkillInstallResult[] = [
			{ skill: "interlinked", client: "claude", path: ".claude/skills/interlinked", installed: true },
			{
				skill: "interlinked-harness",
				client: "claude",
				path: ".claude/skills/interlinked-harness",
				installed: true,
			},
		];
		vi.mocked(installSkills).mockReturnValue(results);
		installSkillsForClients("/repo", ["claude"]);
		expect(installSkills).toHaveBeenCalledWith("/repo", ["claude"]);
		const lines = logLines();
		expect(lines.some((l) => l.includes("Installed") && l.includes("claude"))).toBe(true);
	});

	it("reports an error when no skills installed", () => {
		const results: SkillInstallResult[] = [
			{
				skill: "interlinked",
				client: "codex",
				path: ".codex/skills/interlinked",
				installed: false,
				error: "no dir",
			},
		];
		vi.mocked(installSkills).mockReturnValue(results);
		installSkillsForClients("/repo", ["codex"]);
		const lines = logLines();
		expect(lines.some((l) => l.includes("not installed") && l.includes("no dir"))).toBe(true);
	});
});

// --- parseRequestedClients --------------------------------------------------

describe("parseRequestedClients", () => {
	it("returns null requested list when raw is undefined", () => {
		expect(parseRequestedClients(undefined)).toEqual({ requested: null, unknown: [] });
	});

	it("parses, dedupes, and lowercases valid clients", () => {
		const result = parseRequestedClients("claude, Claude,codex");
		expect(result.requested).toEqual(["claude", "codex"]);
		expect(result.unknown).toEqual([]);
	});

	it("collects unknown ids, showing <empty> for blanks", () => {
		const result = parseRequestedClients("claude,bogus,");
		expect(result.requested).toEqual(["claude"]);
		expect(result.unknown).toEqual(["bogus", "<empty>"]);
	});
});

// --- reportInvalidExplicitValue --------------------------------------------

describe("reportInvalidExplicitValue", () => {
	it("prints the allowed values and sets exit code 1", () => {
		reportInvalidExplicitValue("sync", "bogus", ["realtime", "local", "manual"]);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		const message = stripAnsi(String(errorSpy.mock.calls[0]?.[0]));
		expect(message).toContain("Invalid sync mode");
		expect(message).toContain("realtime, local, manual");
		expect(process.exitCode).toBe(1);
	});
});

// --- ensureIndexBuilt --------------------------------------------------------

describe("ensureIndexBuilt", () => {
	it("skips silently when the index already exists", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		ensureIndexBuilt("/repo");
		expect(trigramBuildMock).not.toHaveBeenCalled();
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("builds and reports the index when absent", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		ensureIndexBuilt("/repo");
		expect(trigramBuildMock).toHaveBeenCalledTimes(1);
		const lines = logLines();
		expect(lines.some((l) => l.includes("Built") && l.includes("42 files"))).toBe(true);
	});
});

// --- startHarnessIfNeeded ---------------------------------------------------

describe("startHarnessIfNeeded", () => {
	it("does nothing when the harness is already running", async () => {
		vi.mocked(isHarnessRunning).mockReturnValue({ running: true } as ReturnType<
			typeof isHarnessRunning
		>);
		await startHarnessIfNeeded("/repo");
		expect(harnessStartCommand).not.toHaveBeenCalled();
	});

	it("starts the harness as a daemon when not running", async () => {
		vi.mocked(isHarnessRunning).mockReturnValue({ running: false } as ReturnType<
			typeof isHarnessRunning
		>);
		vi.mocked(harnessStartCommand).mockResolvedValue(undefined);
		await startHarnessIfNeeded("/repo");
		expect(harnessStartCommand).toHaveBeenCalledWith({ daemon: true });
		expect(logLines().some((l) => l.includes("Failed to start harness"))).toBe(false);
	});

	it("warns when the harness start fails", async () => {
		vi.mocked(isHarnessRunning).mockReturnValue({ running: false } as ReturnType<
			typeof isHarnessRunning
		>);
		vi.mocked(harnessStartCommand).mockRejectedValue(new Error("boom"));
		await startHarnessIfNeeded("/repo");
		const lines = logLines();
		expect(lines.some((l) => l.includes("Failed to start harness"))).toBe(true);
	});
});

// --- buildPostEnableNotes ----------------------------------------------------

describe("buildPostEnableNotes", () => {
	it("returns no notes for claude-only targets", () => {
		expect(buildPostEnableNotes(["claude"])).toEqual([]);
	});

	it("returns one note per matching client, in order", () => {
		const notes = buildPostEnableNotes(["copilot", "codex", "opencode", "pi"]);
		expect(notes).toHaveLength(4);
		expect(notes[0]).toContain("skills reload");
		expect(notes[1]).toContain("Codex");
		expect(notes[2]).toContain("OpenCode");
		expect(notes[3]).toContain("Pi");
	});
});
