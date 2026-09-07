// ===========================================
// interlinked init — mutation-kill supplement
// ===========================================
// Targeted tests written against the exact 74-mutant Stryker survivor list
// for src/commands/init.ts (see scratch/mutation-out/reports). Each test
// asserts an EXACT value (array element equality via `calls()`, exact
// object/string equality, or exact call counts) rather than loose
// substring checks, so it only passes when the specific mutated branch,
// operator, or literal is restored to real behavior.
//
// This file uses its OWN module mocks (independent from init.test.ts) so
// the fs / readline mocks can be made strict (encoding-checked,
// arg-capturing) without touching the existing, already-passing suite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- node:fs mock: strict encoding + decoupled exists/read state --------
// `existsSync` and `readFileSync` are backed by two independent maps so a
// fixture can put content at a path WITHOUT marking it as existing (kills
// the `if (existsSync(...))` forced-true mutant), and the encoding arg is
// checked so mutating the literal "utf-8" is observable (kills the
// StringLiteral mutant on that argument).
let fsExists: Set<string>;
let fsFiles: Record<string, string>;
vi.mock("node:fs", () => ({
	existsSync: (p: string) => fsExists.has(p),
	readFileSync: (p: string, encoding?: string) => {
		if (encoding !== "utf-8") throw new Error(`unexpected encoding: ${String(encoding)}`);
		if (!(p in fsFiles)) throw new Error(`ENOENT ${p}`);
		return fsFiles[p];
	},
}));

// ---- node:readline/promises mock: captures createInterface args + close --
let rlAnswers: string[];
const rlQuestions: string[] = [];
const createInterfaceCalls: unknown[] = [];
let closeCallCount = 0;
vi.mock("node:readline/promises", () => ({
	createInterface: (opts: unknown) => {
		createInterfaceCalls.push(opts);
		return {
			question: (prompt: string) => {
				rlQuestions.push(prompt);
				return Promise.resolve(rlAnswers.length ? (rlAnswers.shift() as string) : "");
			},
			close: () => {
				closeCallCount++;
			},
		};
	},
}));

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
import { findProjectRoot, installAllHooks } from "../lib/hooks.js";
import { ensureRemoteOnboarding } from "../lib/onboarding.js";
import { detectClients } from "../lib/settings.js";
import { harnessStartCommand, isHarnessRunning } from "./harness.js";
import { initCommand } from "./init.js";

const mocks = {
	resolveAuthToken: vi.mocked(resolveAuthToken),
	findProjectRoot: vi.mocked(findProjectRoot),
	installAllHooks: vi.mocked(installAllHooks),
	ensureRemoteOnboarding: vi.mocked(ensureRemoteOnboarding),
	detectClients: vi.mocked(detectClients),
	harnessStartCommand: vi.mocked(harnessStartCommand),
	isHarnessRunning: vi.mocked(isHarnessRunning),
};

let logSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.fn>;
const FIXED_CWD = "/repo";
const origStdinTty = process.stdin.isTTY;
const origStdoutTty = process.stdout.isTTY;
const origEnv = { ...process.env };

/** Every console.log call's first argument, as an exact-value array. */
function calls(): string[] {
	return (logSpy.mock.calls as unknown[][]).map((c) => String(c[0]));
}

function setTty(stdin: boolean, stdout: boolean = stdin): void {
	Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
}

beforeEach(() => {
	fsExists = new Set();
	fsFiles = {};
	rlAnswers = [];
	rlQuestions.length = 0;
	createInterfaceCalls.length = 0;
	closeCallCount = 0;
	clientCtorCalls.length = 0;
	vi.clearAllMocks();

	vi.spyOn(process, "cwd").mockReturnValue(FIXED_CWD);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

	fetchSpy = vi.fn(async () => ({ ok: false }) as Response);
	vi.stubGlobal("fetch", fetchSpy);

	setTty(false, false);
	for (const k of Object.keys(process.env)) {
		if (k.startsWith("INTERLINKED_")) delete process.env[k];
	}
	process.env.USER = "alice";
	delete process.env.USERNAME;

	mocks.detectClients.mockReturnValue([]);
	mocks.findProjectRoot.mockReturnValue(null);
	mocks.resolveAuthToken.mockReturnValue(null);
	mocks.installAllHooks.mockReturnValue([]);
	mocks.ensureRemoteOnboarding.mockResolvedValue({
		status: "skipped",
		reason: "not_authenticated",
	});
	mocks.isHarnessRunning.mockReturnValue({ running: false });
	mocks.harnessStartCommand.mockResolvedValue(undefined);
	callToolImpl = () => Promise.reject(new Error("ECONNREFUSED"));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Object.defineProperty(process.stdin, "isTTY", { value: origStdinTty, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTty, configurable: true });
	for (const k of Object.keys(process.env)) {
		if (k.startsWith("INTERLINKED_")) delete process.env[k];
	}
	for (const [k, v] of Object.entries(origEnv)) process.env[k] = v;
});

// =======================================================================
// line 64 — isInteractiveTty: && vs ||
// =======================================================================
describe("isInteractiveTty (line 64)", () => {
	it("treats a mixed TTY (stdin only) as non-interactive: no agent-name prompt fires", async () => {
		setTty(true, false); // stdin is a TTY, stdout is not
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 }); // skip shouldStartHarness path
		await initCommand({ server: "http://localhost:8787", json: true }); // no --agent, no --yes
		// Real (&&): isInteractiveTty() is false here -> autoConfirm true -> no prompt.
		// Mutant (||): isInteractiveTty() would be true -> autoConfirm false -> prompt fires.
		expect(rlQuestions).toStrictEqual([]);
	});
});

// =======================================================================
// deriveProjectFromGit — lines 93, 95, 96 (x3), 98, 100
// (97 and 101 are proven equivalent below the tests)
// =======================================================================
describe("deriveProjectFromGit", () => {
	it("does not read git config when existsSync is false, even if content exists at that path (line 93)", async () => {
		mocks.findProjectRoot.mockReturnValue("/proj");
		// Content present, but the path is deliberately NOT registered as existing.
		fsFiles["/proj/.git/config"] = "url = https://github.com/acme/shouldnotread.git\n";
		await initCommand({ "dry-run": true, json: true, server: "https://s", agent: "a" });
		const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(payload.project).toBe("proj");
	});

	it("derives the repo name from a url line with zero surrounding whitespace (line 95 encoding + line 96 regex x3)", async () => {
		mocks.findProjectRoot.mockReturnValue("/proj2");
		fsExists.add("/proj2/.git/config");
		fsFiles["/proj2/.git/config"] = "url=x/testproj.git\n";
		await initCommand({ "dry-run": true, json: true, server: "https://s", agent: "a" });
		const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		// Every url-regex mutant (requires exactly one space before/after "=",
		// or greedily eats non-whitespace after "=") fails to extract "testproj"
		// from this zero-whitespace input and falls back to the directory name
		// "proj2" instead. A mangled "utf-8" encoding literal also falls back
		// to "proj2" via the strict readFileSync mock.
		expect(payload.project).toBe("testproj");
	});

	it("trims trailing whitespace from the matched url before deriving the repo name (line 98 .trim() removal)", async () => {
		mocks.findProjectRoot.mockReturnValue("/proj3");
		fsExists.add("/proj3/.git/config");
		fsFiles["/proj3/.git/config"] = "url = https://github.com/acme/repotrim.git   \n";
		await initCommand({ "dry-run": true, json: true, server: "https://s", agent: "a" });
		const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		// Without .trim(), the trailing spaces push the "(?:\.git)?$" anchor
		// past the literal ".git", so the repo-name regex instead captures
		// "repotrim.git" (suffix included).
		expect(payload.project).toBe("repotrim");
	});

	it("derives the repo name when the url has no .git suffix (line 100 mandatory-.git mutant)", async () => {
		mocks.findProjectRoot.mockReturnValue("/proj4");
		fsExists.add("/proj4/.git/config");
		fsFiles["/proj4/.git/config"] = "url = https://github.com/acme/norepo\n";
		await initCommand({ "dry-run": true, json: true, server: "https://s", agent: "a" });
		const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(payload.project).toBe("norepo");
	});
});

// =======================================================================
// resolveAgentName — lines 143, 145, 147, 151, 154
// =======================================================================
describe("resolveAgentName", () => {
	it("opens readline on process stdio and always closes it (lines 143 + 147)", async () => {
		setTty(true, true);
		mocks.detectClients.mockReturnValue([]);
		rlAnswers = ["  promptbot  "];
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 }); // skip the harness prompt call site
		await initCommand({ server: "http://localhost:8787", json: true });
		expect(createInterfaceCalls).toStrictEqual([{ input: process.stdin, output: process.stdout }]);
		expect(closeCallCount).toBe(1);
	});

	it("prompts with the exact formatted question text (line 145)", async () => {
		setTty(true, true);
		mocks.detectClients.mockReturnValue([]);
		rlAnswers = ["ignored"];
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		await initCommand({ server: "http://localhost:8787", json: true });
		expect(rlQuestions).toStrictEqual(["4. Agent name [alice-cli]: "]);
	});

	it("echoes the exact non-interactive agent-name line (line 151)", async () => {
		setTty(false, false);
		await initCommand({ "dry-run": true, server: "https://s", agent: "shownbot" });
		expect(calls()).toContain("4. Agent name: shownbot");
	});

	it("prints exactly one blank line right after the agent-name step, before the dry-run message (line 154)", async () => {
		setTty(false, false);
		mocks.detectClients.mockReturnValue([]);
		mocks.findProjectRoot.mockReturnValue(null);
		await initCommand({ "dry-run": true, server: "https://s", agent: "shownbot" });
		const out = calls();
		// The dry-run human message is always the last two calls; the call
		// right before it is resolveAgentName's line-154 blank.
		expect(out.at(-2)).toBe("Dry run — no changes made.");
		expect(out.at(-3)).toBe("");
		expect(out.at(-4)).toBe("4. Agent name: shownbot");
	});
});

// =======================================================================
// installConfigAndHooks — lines 167, 168, 174, 175, 181, 182, 189, 190,
// 191, 195
// =======================================================================
describe("installConfigAndHooks", () => {
	it("only prints an install-error line for a client that actually has one (line 190 &&/true mutants)", async () => {
		mocks.detectClients.mockReturnValue([{ name: "claude", exists: true } as never]);
		mocks.installAllHooks.mockReturnValue([
			{ client: "claude", installed: false, events: [] }, // not installed, no error
		]);
		await initCommand({ server: "https://s", agent: "bot" });
		// "claude" itself legitimately appears in the step-1 client-detection
		// list; only the install-result line (success "hooks (" or error
		// "claude:") must be absent for a client with no error.
		expect(calls().some((s) => s.includes("claude hooks") || s.includes("claude:"))).toBe(false);
	});

	it("prints a blank line immediately before the authenticating header (line 195)", async () => {
		mocks.detectClients.mockReturnValue([]);
		mocks.resolveAuthToken.mockReturnValue(null);
		process.env.INTERLINKED_TOKEN = "tok";
		await initCommand({ server: "https://remote.example", agent: "bot" });
		const out = calls();
		const idx = out.indexOf("6. Authenticating...");
		expect(idx).toBeGreaterThan(0);
		expect(out[idx - 1]).toBe("");
	});

	it("prints every install-step line with exact text in human mode (lines 167,168,174,175,181,182,189,191)", async () => {
		mocks.detectClients.mockReturnValue([
			{ name: "claude", exists: true } as never,
			{ name: "gemini", exists: true } as never,
		]);
		mocks.installAllHooks.mockReturnValue([
			{ client: "claude", installed: true, events: ["PreToolUse", "PostToolUse"] },
			{ client: "gemini", installed: false, events: [], error: "no settings file" },
		]);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		await initCommand({ server: "https://s", agent: "bot" });
		const out = calls();
		expect(out).toContain("5. Installing...");
		expect(out).toContain("   ✓ Config written to .interlinked/");
		expect(out).toContain("   ✓ Hook script v9.9.9");
		expect(out).toContain("   ✓ claude hooks (2 events)");
		expect(out).toContain("   ! gemini: no settings file");
	});
});

// =======================================================================
// authenticate — lines 204, 205, 216, 217, 219
// =======================================================================
describe("authenticate", () => {
	it("prints the exact already-authenticated line for a local server (lines 216, 217)", async () => {
		mocks.resolveAuthToken.mockReturnValue("tok");
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(calls()).toContain("6. Auth: already authenticated");
	});

	it("prints a blank line immediately before the onboarding header (line 219)", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		await initCommand({ server: "https://s", agent: "bot" });
		const out = calls();
		const idx = out.indexOf("7. Connecting to workspace...");
		expect(idx).toBeGreaterThan(0);
		expect(out[idx - 1]).toBe("");
	});
});

// =======================================================================
// runOnboarding — lines 228, 229, 232, 237, 244
// =======================================================================
describe("runOnboarding", () => {
	it("calls ensureRemoteOnboarding with exactly the resolved server url (line 232)", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		await initCommand({ server: "https://exact.example", agent: "bot" });
		expect(mocks.ensureRemoteOnboarding).toHaveBeenCalledWith({ serverUrl: "https://exact.example" });
	});

	it("prints the exact 'registered' line including workspace name (lines 228, 229, 237)", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		mocks.ensureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			isNewAgent: true,
			agentName: "regbot",
			workspaceName: "Acme WS",
		});
		await initCommand({ server: "https://s", agent: "bot" });
		const out = calls();
		expect(out).toContain("7. Connecting to workspace...");
		expect(out).toContain("   ✓ Agent regbot registered");
		expect(out).toContain("   Workspace: Acme WS");
	});

	it("prints the exact onboarding-failed line with its error text (line 244)", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		mocks.ensureRemoteOnboarding.mockResolvedValue({ status: "failed", error: "bootstrap exploded" });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(calls()).toContain("   ! Remote onboarding: bootstrap exploded");
	});
});

// =======================================================================
// shouldStartHarness / startHarness / setupHarness — lines 283, 286, 287,
// 299, 302, 316, 317, 322, 323, 334
// =======================================================================
describe("harness setup", () => {
	it("opens readline for the harness prompt on process stdio and always closes it (lines 283, 287)", async () => {
		setTty(true, true);
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		rlAnswers = ["n"];
		await initCommand({ server: "http://localhost:8787", json: true, agent: "bot" }); // agent given -> no prompt in resolveAgentName
		expect(createInterfaceCalls).toStrictEqual([{ input: process.stdin, output: process.stdout }]);
		expect(closeCallCount).toBe(1);
	});

	it("treats a leading-whitespace 'N' answer as decline (line 286, second .trim() mutant)", async () => {
		setTty(true, true);
		rlAnswers = [" N"]; // stray leading whitespace, uppercase — still means "no"
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		await initCommand({ server: "http://localhost:8787", json: true, agent: "bot" });
		expect(mocks.harnessStartCommand).not.toHaveBeenCalled();
	});

	it("prints the exact 'harness started' success line", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 9001 });
		await initCommand({ server: "https://s", agent: "bot" });
		expect(calls()).toContain("   ✓ Harness started (PID 9001)");
	});

	it("prints the exact 'failed to start harness' line", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		await initCommand({ server: "https://s", agent: "bot" });
		expect(calls()).toContain(
			"   ! Failed to start harness. Run: interlinked harness start --verbose",
		);
	});

	it("prints a blank line immediately before the harness-setup header (lines 316, 317)", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		await initCommand({ server: "https://s", agent: "bot" });
		const out = calls();
		const idx = out.indexOf("8. Harness setup...");
		expect(idx).toBeGreaterThan(0);
		expect(out[idx - 1]).toBe("");
	});

	it("does not report already-running or short-circuit when the harness is not yet running (line 322)", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 42 });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(calls().some((s) => s.includes("already running"))).toBe(false);
		expect(mocks.harnessStartCommand).toHaveBeenCalledTimes(1);
	});

	it("prints the exact already-running harness line with its PID (line 323)", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 555 });
		await initCommand({ server: "https://s", agent: "bot" });
		expect(calls()).toContain("   ✓ Harness already running (PID 555)");
	});

	it("shows the 'start harness' next-step hint when the harness ends up not started (line 334 return-true mutant)", async () => {
		setTty(true, true);
		rlAnswers = ["n"];
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		await initCommand({ server: "http://localhost:8787", agent: "bot" });
		expect(calls()).toContain(
			"  interlinked harness start    — Start guard evaluation server",
		);
	});
});

// =======================================================================
// JSON-mode suppression — kills every isJson-guard-forced-true mutant in
// one shot (lines 167, 174, 181, 195, 204, 216, 219, 228 and their
// BooleanLiteral/ConditionalExpression variants).
// =======================================================================
describe("json mode suppresses every human-only line", () => {
	it("emits exactly one console.log call (the JSON payload) across a full non-dry-run flow", async () => {
		mocks.detectClients.mockReturnValue([
			{ name: "claude", exists: true } as never,
			{ name: "gemini", exists: true } as never,
		]);
		mocks.installAllHooks.mockReturnValue([
			{ client: "claude", installed: true, events: ["PreToolUse"] },
			{ client: "gemini", installed: false, events: [], error: "no settings file" },
		]);
		mocks.resolveAuthToken.mockReturnValue(null);
		process.env.INTERLINKED_TOKEN = "env-tok";
		mocks.ensureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			isNewAgent: true,
			agentName: "bot",
			workspaceName: "WS",
		});
		callToolImpl = (name) =>
			name === "health_check" ? Promise.resolve({}) : Promise.resolve({ agents: [{ name: "x" }] });
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 1 });

		await initCommand({ json: true, server: "https://remote.example", agent: "bot" });

		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).status).toBe("complete");
	});
});
