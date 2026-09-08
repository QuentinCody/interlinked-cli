import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- mocks for every module init.ts imports (besides node:fs/path/process/non-null) ----

vi.mock("../lib/auth.js", () => ({
	resolveAuthToken: vi.fn(),
}));

vi.mock("../lib/config.js", () => ({
	initConfig: vi.fn(),
	updateLocalConfig: vi.fn(),
}));

vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		green: (s: string) => s,
		cyan: (s: string) => s,
		yellow: (s: string) => s,
		dim: (s: string) => s,
	},
}));

vi.mock("../lib/hooks.js", () => ({
	findProjectRoot: vi.fn(),
	HOOK_SCRIPT_VERSION: "9.9.9",
	installAllHooks: vi.fn(() => []),
	writeHookScript: vi.fn(),
}));

vi.mock("../lib/onboarding.js", () => ({
	ensureRemoteOnboarding: vi.fn(),
}));

vi.mock("../lib/settings.js", () => ({
	detectClients: vi.fn(() => []),
}));

vi.mock("./harness.js", () => ({
	harnessStartCommand: vi.fn(),
	isHarnessRunning: vi.fn(() => ({ running: true, pid: 1 })),
}));

vi.mock("./init-presentation.js", () => ({
	emitDryRun: vi.fn(),
	isLocalServer: vi.fn(() => true),
	printBanner: vi.fn(),
	printCompletion: vi.fn(),
	printDetectedClients: vi.fn(),
	printProjectContext: vi.fn(),
	printServer: vi.fn(),
}));

vi.mock("./login.js", () => ({
	loginCommand: vi.fn(),
}));

vi.mock("node:readline/promises", () => ({
	createInterface: vi.fn(() => ({
		question: vi.fn().mockResolvedValue(""),
		close: vi.fn(),
	})),
}));

vi.mock("../lib/api-client.js", () => ({
	InterlinkedClient: vi.fn().mockImplementation(() => ({
		callTool: vi.fn().mockResolvedValue({ agents: [] }),
	})),
}));

import { createInterface } from "node:readline/promises";
import { resolveAuthToken } from "../lib/auth.js";
import { findProjectRoot, installAllHooks } from "../lib/hooks.js";
import { ensureRemoteOnboarding } from "../lib/onboarding.js";
import { detectClients } from "../lib/settings.js";
import { isHarnessRunning } from "./harness.js";
import { initCommand } from "./init.js";
import { isLocalServer, printProjectContext } from "./init-presentation.js";

const origIsTTYIn = process.stdin.isTTY;
const origIsTTYOut = process.stdout.isTTY;
const origEnv = { ...process.env };

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
	(installAllHooks as any).mockReturnValue([]);
	// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
	(isHarnessRunning as any).mockReturnValue({ running: true, pid: 1 });
	// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
	(ensureRemoteOnboarding as any).mockResolvedValue({ status: "skipped", reason: "test" });
	// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
	(resolveAuthToken as any).mockReturnValue("some-token");
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	logSpy.mockRestore();
	// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
	(process.stdin as any).isTTY = origIsTTYIn;
	// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
	(process.stdout as any).isTTY = origIsTTYOut;
	process.env = { ...origEnv };
});

function loggedLines(): string[] {
	return logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
}

// ---------------------------------------------------------------------------
// Group A: deriveProjectFromGit (symbol 456f8d93f1963ad2), reached via dry-run
// ---------------------------------------------------------------------------

describe("git-derived project name (dry-run)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "init-w46-"));
		mkdirSync(join(tmpDir, ".git"), { recursive: true });
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(findProjectRoot as any).mockReturnValue(tmpDir);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	async function runAndGetProjectName(gitConfigContent: string): Promise<unknown> {
		writeFileSync(join(tmpDir, ".git", "config"), gitConfigContent);
		await initCommand({
			"dry-run": true,
			json: true,
			yes: true,
			agent: "a",
			server: "http://example.test",
		});
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		const call = (printProjectContext as any).mock.calls[0];
		return call?.[0];
	}

	it("kills a7a21002835a6631 (utf-8 -> '' encoding) and baseline extraction", async () => {
		const name = await runAndGetProjectName("[remote]\n\turl = git@example.com:user/testproj4.git\n");
		expect(name).toBe("testproj4");
	});

	it("kills e2ab0e7b84c66a07 and 77a5d09d1b8c9bec (no whitespace around '=')", async () => {
		// No space before OR after "=" — original \s* (zero-or-more) still matches;
		// either mutant requiring a mandatory single whitespace fails to match.
		const name = await runAndGetProjectName("url=x/testproj2.git\n");
		expect(name).toBe("testproj2");
	});

	it("kills 0d71addb84073c73 (\\s* -> \\S* after '=')", async () => {
		const name = await runAndGetProjectName("url=x/testproj5.git\n");
		expect(name).toBe("testproj5");
	});

	it("kills 33bfeadb57a9b224 (optional .git suffix made mandatory)", async () => {
		const name = await runAndGetProjectName("url = x/testproj3\n");
		expect(name).toBe("testproj3");
	});

	it("kills f1d24720c5e4bf7b (missing .trim() on captured url)", async () => {
		// Trailing space after the captured URL, no trailing newline: without
		// .trim() the repo-name regex is forced to swallow the trailing space.
		const name = await runAndGetProjectName("url=x/testproj6.git ");
		expect(name).toBe("testproj6");
	});

	it("falls back to directory basename when no url line is present", async () => {
		const name = await runAndGetProjectName("[core]\n\tbare = false\n");
		expect(typeof name).toBe("string");
		// Pin the exact fallback value: basename(tmpDir). A stub/no-op fallback
		// (e.g. returning "" or a hardcoded name) would fail this literal check.
		expect(name).toBe(basename(tmpDir));
	});
});

// ---------------------------------------------------------------------------
// Group B: isServerReachable (symbol fa0aa30ada351839), reached via resolveServerUrl
// ---------------------------------------------------------------------------

describe("server reachability probe (dry-run)", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		delete process.env.INTERLINKED_SERVER_URL;
	});

	it("kills 787b11426c3f1a31 (finally block dropping clearTimeout)", async () => {
		delete process.env.INTERLINKED_SERVER_URL;
		// SAFETY: this test reads only Response.ok and restores global.fetch in afterEach.
		global.fetch = vi.fn().mockResolvedValue({ ok: true }) as any;
		const setSpy = vi.spyOn(global, "setTimeout");
		const clearSpy = vi.spyOn(global, "clearTimeout");
		await initCommand({
			"dry-run": true,
			json: true,
			yes: true,
			agent: "a",
		});
		expect(clearSpy).toHaveBeenCalled();
		// Pin the exact timer handle: clearTimeout must be called with the SAME
		// handle setTimeout returned, not merely "called with something".
		const timerHandle = setSpy.mock.results[0]?.value;
		expect(clearSpy).toHaveBeenCalledWith(timerHandle);
		setSpy.mockRestore();
		clearSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// Group C: isInteractiveTty LogicalOperator (symbol b4b271a49f46f9e4)
// ---------------------------------------------------------------------------

describe("isInteractiveTty && vs || (dry-run, via resolveAgentName routing)", () => {
	it("kills 6986c29bfb7e8fe3: mixed TTY (stdin only) must NOT be interactive", async () => {
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdin as any).isTTY = true;
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdout as any).isTTY = false;
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(findProjectRoot as any).mockReturnValue(null);

		await initCommand({
			"dry-run": true,
			json: false,
			server: "http://example.test",
			// no `yes`, no `agent` — forces resolveAgentName to consult isInteractiveTty()
		});

		// With `&&`, isInteractiveTty() is false here, so autoConfirm becomes true
		// and resolveAgentName takes the non-interactive branch: no readline prompt,
		// and it prints the "4." agent-name line instead.
		expect(createInterface).not.toHaveBeenCalled();
		expect(loggedLines().some((l) => l.includes("4.") && l.includes("Agent name"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Group D: resolveAgentName (symbol e441459989199b2e)
// ---------------------------------------------------------------------------

describe("resolveAgentName (dry-run)", () => {
	it("kills 0e750a4ac82da572/e1a9925fa3225b96 ('4.' literal) and 573206d729c0eebe (blank line) in non-interactive branch", async () => {
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdin as any).isTTY = false;
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdout as any).isTTY = false;
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(findProjectRoot as any).mockReturnValue(null);

		await initCommand({
			"dry-run": true,
			json: false,
			yes: true,
			server: "http://example.test",
		});

		const lines = loggedLines();
		expect(lines.some((l) => l.startsWith("4. Agent name: "))).toBe(true);
		expect(lines).toContain("");
	});

	it("kills 6651ef945538d060 (createInterface object literal) and e9a2e62a40ca7764 (rl.close dropped) in interactive branch", async () => {
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdin as any).isTTY = true;
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdout as any).isTTY = true;
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(findProjectRoot as any).mockReturnValue(null);

		const closeSpy = vi.fn();
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(createInterface as any).mockReturnValue({
			question: vi.fn().mockResolvedValue(""),
			close: closeSpy,
		});

		await initCommand({
			"dry-run": true,
			json: false,
			server: "http://example.test",
			// no `yes`, no `agent`: forces the interactive branch
		});

		expect(createInterface).toHaveBeenCalled();
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		const arg = (createInterface as any).mock.calls[0][0];
		expect(arg).toBeTruthy();
		expect("input" in arg).toBe(true);
		expect("output" in arg).toBe(true);
		expect(closeSpy).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Full-run helpers for steps that occur after the dry-run early return.
// ---------------------------------------------------------------------------

function baseFullRunOptions(overrides: Record<string, unknown> = {}) {
	return {
		"dry-run": false,
		json: false,
		yes: true,
		agent: "testagent",
		server: "http://example.test",
		...overrides,
	};
}

describe("installConfigAndHooks (full run, symbol f0dfc89b5e601aed)", () => {
	beforeEach(() => {
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdin as any).isTTY = false;
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdout as any).isTTY = false;
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(findProjectRoot as any).mockReturnValue(null);
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(detectClients as any).mockReturnValue([
			{ name: "claude", exists: true },
			{ name: "gemini", exists: true },
		]);
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(installAllHooks as any).mockReturnValue([
			{ client: "claude", installed: true, events: ["PreToolUse", "PostToolUse"] },
			{ client: "gemini", installed: false, error: "not found" },
		]);
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(isLocalServer as any).mockReturnValue(true); // skip authenticate's login branch cleanly
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(ensureRemoteOnboarding as any).mockResolvedValue({ status: "skipped", reason: "test" });
	});

	it("prints every installation line when json is false", async () => {
		await initCommand(baseFullRunOptions({ json: false }));
		const lines = loggedLines();
		expect(lines).toContain("5. Installing...");
		expect(lines).toContain("   ✓ Config written to .interlinked/");
		expect(lines).toContain("   ✓ Hook script v9.9.9");
		expect(lines).toContain("   ✓ claude hooks (2 events)");
		expect(lines).toContain("   ! gemini: not found");
		expect(lines).toContain("");
	});

	it("prints nothing at all when json is true", async () => {
		await initCommand(baseFullRunOptions({ json: true }));
		expect(logSpy).not.toHaveBeenCalled();
	});
});

describe("authenticate (full run, symbol fdeb1c10b02cadbb)", () => {
	beforeEach(() => {
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdin as any).isTTY = false;
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdout as any).isTTY = false;
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(findProjectRoot as any).mockReturnValue(null);
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(detectClients as any).mockReturnValue([]);
		delete process.env.INTERLINKED_TOKEN;
		delete process.env.INTERLINKED_ACCESS_TOKEN;
	});

	it("prints '6. Authenticating...' and the no-TTY skip + blank line when unauthenticated on a remote server", async () => {
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(resolveAuthToken as any).mockReturnValue(undefined);
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(isLocalServer as any).mockReturnValue(false);

		await initCommand(baseFullRunOptions({ json: false }));

		const lines = loggedLines();
		expect(lines).toContain("6. Authenticating...");
		expect(lines).toContain("");
	});

	it("prints '6. Auth: already authenticated' when already authenticated", async () => {
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(resolveAuthToken as any).mockReturnValue("a-real-token");
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(isLocalServer as any).mockReturnValue(false);

		await initCommand(baseFullRunOptions({ json: false }));

		const lines = loggedLines();
		expect(lines).toContain("6. Auth: already authenticated");
	});

	it("prints nothing when json is true, regardless of auth branch", async () => {
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(resolveAuthToken as any).mockReturnValue(undefined);
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(isLocalServer as any).mockReturnValue(false);

		await initCommand(baseFullRunOptions({ json: true }));
		expect(logSpy).not.toHaveBeenCalled();
	});
});

describe("runOnboarding (full run, symbol 47ceb28cb59bf0d2)", () => {
	beforeEach(() => {
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdin as any).isTTY = false;
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdout as any).isTTY = false;
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(findProjectRoot as any).mockReturnValue(null);
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(detectClients as any).mockReturnValue([]);
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(isLocalServer as any).mockReturnValue(true);
	});

	it("prints '7. Connecting...' and the registered line, calling ensureRemoteOnboarding with {serverUrl}", async () => {
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(ensureRemoteOnboarding as any).mockResolvedValue({
			status: "linked",
			isNewAgent: true,
			agentName: "testagent",
			workspaceName: "myws",
		});

		await initCommand(baseFullRunOptions({ json: false, server: "http://example.test" }));

		const lines = loggedLines();
		expect(lines).toContain("7. Connecting to workspace...");
		expect(
			lines.some((l) => l.includes("✓") && l.includes("testagent") && l.includes("registered")),
		).toBe(true);

		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		const callArg = (ensureRemoteOnboarding as any).mock.calls[0][0];
		expect(callArg).toEqual({ serverUrl: "http://example.test" });
	});

	it("prints the '!' failure line on a non-linked/skipped status", async () => {
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(ensureRemoteOnboarding as any).mockResolvedValue({
			status: "error",
			error: "boom",
		});

		await initCommand(baseFullRunOptions({ json: false }));

		const lines = loggedLines();
		expect(lines.some((l) => l.includes("!") && l.includes("boom"))).toBe(true);
	});

	it("prints nothing when json is true", async () => {
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(ensureRemoteOnboarding as any).mockResolvedValue({ status: "linked", agentName: "testagent" });
		await initCommand(baseFullRunOptions({ json: true }));
		expect(logSpy).not.toHaveBeenCalled();
	});
});

describe("shouldStartHarness / startHarness (full run, symbol f950e99585a91174)", () => {
	it("kills 3e3206d97335510f (createInterface object literal in harness prompt)", async () => {
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdin as any).isTTY = true;
		// SAFETY: the test temporarily overrides the live stream property and restores it in afterEach.
		(process.stdout as any).isTTY = true;
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(findProjectRoot as any).mockReturnValue(null);
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(detectClients as any).mockReturnValue([]);
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(isLocalServer as any).mockReturnValue(true);
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(resolveAuthToken as any).mockReturnValue("already-have-a-token");
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(ensureRemoteOnboarding as any).mockResolvedValue({ status: "skipped", reason: "test" });

		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(isHarnessRunning as any).mockReturnValueOnce({ running: false }).mockReturnValueOnce({
			running: true,
			pid: 42,
		});

		const closeSpy = vi.fn();
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		(createInterface as any).mockReturnValue({
			question: vi.fn().mockResolvedValue(""),
			close: closeSpy,
		});

		await initCommand(baseFullRunOptions({ json: false, agent: "testagent", yes: false }));

		expect(createInterface).toHaveBeenCalled();
		// SAFETY: vi.mock replaces this import, so Vitest supplies its mock methods at runtime.
		const calledWithInputOutput = (createInterface as any).mock.calls.some(
			(call: unknown[]) => typeof call[0] === "object" && call[0] !== null && "input" in call[0] && "output" in call[0],
		);
		expect(calledWithInputOutput).toBe(true);
	});
});
