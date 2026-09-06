import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Behavioral tests for the implicit-entry flow (`interlinked` with no args).
//
// 2026-08-16 rewrite alongside first-run.ts's harness-first rework: the old
// suite pinned the deleted server-era wizard (health probes, server URL
// prompts, scripted login answers). The new contract is routing:
//   unconfigured + TTY      → runSetupWizardInteractive, then short status
//   unconfigured + non-TTY  → runSetupWizardNonInteractive
//   configured              → statusCommand (+ quick-start suggestions on TTY)
//   any argv                → return false, run nothing
// The wizard's own behavior is pinned in setup-wizard(.test|-run.test).ts —
// this suite deliberately does not restate it.
// ============================================================================

const {
	mockIsConfigured,
	mockResolveConfig,
	mockResolveAuthToken,
	mockStatusCommand,
	mockWizardInteractive,
	mockWizardNonInteractive,
} = vi.hoisted(() => ({
	mockIsConfigured: vi.fn<() => boolean>(),
	mockResolveConfig: vi.fn(() => ({
		server_url: "http://localhost:8787",
		// SAFETY: widened literals — the config shape allows undefined and the
		// quick-start branch reads both fields.
		agent_name: "ConfiguredAgent" as string | undefined,
		sync_mode: "local" as string | undefined,
	})),
	mockResolveAuthToken: vi.fn<() => string | undefined>(() => undefined),
	mockStatusCommand: vi.fn<(opts?: { short?: boolean }) => Promise<void>>(async () => {}),
	mockWizardInteractive: vi.fn<() => Promise<void>>(async () => {}),
	mockWizardNonInteractive: vi.fn<() => Promise<void>>(async () => {}),
}));

vi.mock("../lib/config.js", () => ({
	isConfigured: mockIsConfigured,
	resolveConfig: mockResolveConfig,
}));
vi.mock("../lib/auth.js", () => ({ resolveAuthToken: mockResolveAuthToken }));
vi.mock("./status.js", () => ({ statusCommand: mockStatusCommand }));
vi.mock("./setup-wizard-run.js", () => ({
	runSetupWizardInteractive: mockWizardInteractive,
	runSetupWizardNonInteractive: mockWizardNonInteractive,
}));

import { handleImplicitEntry } from "./first-run.js";

const ORIGINAL_ARGV = process.argv;

function setTty(tty: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
}

const logLines: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

function printedText(): string {
	return logLines.join("\n");
}

beforeEach(() => {
	process.argv = ["node", "interlinked"];
	vi.clearAllMocks();
	logLines.length = 0;
	logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logLines.push(args.map((a) => String(a)).join(" "));
	});
});

afterEach(() => {
	process.argv = ORIGINAL_ARGV;
	logSpy.mockRestore();
});

describe("handleImplicitEntry — positive (must route)", () => {
	// test-contract: public-api — the first touch on an unconfigured repo IS the harness-first wizard, followed by a short status
	it("P1: unconfigured + TTY runs the interactive wizard then a short status", async () => {
		mockIsConfigured.mockReturnValue(false);
		setTty(true);
		const handled = await handleImplicitEntry();
		expect(handled).toBe(true);
		expect(mockWizardInteractive).toHaveBeenCalledTimes(1);
		expect(mockWizardNonInteractive).not.toHaveBeenCalled();
		expect(mockStatusCommand.mock.calls[0]?.[0]).toMatchObject({ short: true });
	});

	// test-contract: public-api — a non-TTY unconfigured invocation bootstraps env-driven, never prompts
	it("P2: unconfigured + non-TTY runs the non-interactive bootstrap only", async () => {
		mockIsConfigured.mockReturnValue(false);
		setTty(false);
		const handled = await handleImplicitEntry();
		expect(handled).toBe(true);
		expect(mockWizardNonInteractive).toHaveBeenCalledTimes(1);
		expect(mockWizardInteractive).not.toHaveBeenCalled();
	});

	// test-contract: public-api — a configured repo gets the status dashboard, not the wizard
	it("P3: configured runs statusCommand and never the wizard", async () => {
		mockIsConfigured.mockReturnValue(true);
		setTty(false);
		const handled = await handleImplicitEntry();
		expect(handled).toBe(true);
		expect(mockStatusCommand).toHaveBeenCalledTimes(1);
		expect(mockWizardInteractive).not.toHaveBeenCalled();
		expect(mockWizardNonInteractive).not.toHaveBeenCalled();
	});

	// test-contract: public-api — configured + TTY additionally prints the quick-start suggestions
	it("P4: configured + TTY prints the quick-start block", async () => {
		mockIsConfigured.mockReturnValue(true);
		setTty(true);
		await handleImplicitEntry();
		expect(printedText()).toContain("Command Quick Start");
		expect(printedText()).toContain("interlinked --help");
	});
});

describe("handleImplicitEntry — negative (must not hijack)", () => {
	// test-contract: invariant — any explicit argv means the entry flow steps aside for commander
	it("N1: with argv present it returns false and runs nothing", async () => {
		process.argv = ["node", "interlinked", "status"];
		const handled = await handleImplicitEntry();
		expect(handled).toBe(false);
		expect(mockWizardInteractive).not.toHaveBeenCalled();
		expect(mockStatusCommand).not.toHaveBeenCalled();
	});

	// test-contract: boundary — quick-start suggests login only for a remote server with no auth; local server stays quiet about login
	it("N2: local-server config never suggests interlinked login", async () => {
		mockIsConfigured.mockReturnValue(true);
		setTty(true);
		await handleImplicitEntry();
		expect(printedText()).toContain("Command Quick Start");
		expect(printedText()).not.toContain("interlinked login");
	});
});

describe("handleImplicitEntry — quick-start per-field suggestions", () => {
	// test-contract: boundary — an unnamed agent gets the attach suggestion; a named one does not
	it("suggests `interlinked attach --agent` when agent_name is unset", async () => {
		mockIsConfigured.mockReturnValue(true);
		setTty(true);
		mockResolveConfig.mockReturnValueOnce({
			server_url: "http://localhost:8787",
			agent_name: undefined,
			sync_mode: "local",
		});
		await handleImplicitEntry();
		expect(printedText()).toContain("interlinked attach --agent <name>");
	});

	// test-contract: boundary — a remote server with no resolved auth token gets the login suggestion
	it("suggests `interlinked login` for a remote server with no auth token", async () => {
		mockIsConfigured.mockReturnValue(true);
		setTty(true);
		mockResolveConfig.mockReturnValueOnce({
			server_url: "https://interlinked.example.dev",
			agent_name: "ConfiguredAgent",
			sync_mode: "local",
		});
		mockResolveAuthToken.mockReturnValueOnce(undefined);
		await handleImplicitEntry();
		expect(printedText()).toContain("interlinked login");
	});

	// test-contract: boundary — a non-local sync mode gets the sync suggestion; "local" mode does not
	it("suggests `interlinked sync` when sync_mode is not \"local\"", async () => {
		mockIsConfigured.mockReturnValue(true);
		setTty(true);
		mockResolveConfig.mockReturnValueOnce({
			server_url: "http://localhost:8787",
			agent_name: "ConfiguredAgent",
			sync_mode: "realtime",
		});
		await handleImplicitEntry();
		expect(printedText()).toContain("interlinked sync");
	});
});
