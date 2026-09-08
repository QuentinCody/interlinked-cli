import { parseWire, wireArray, wireString } from "../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================
// Mutation-kill hardening for `interlinked update` (self-update command).
//
// The existing companion `update.integration.test.ts` already drives every
// branch via loose `toContain` assertions on aggregated log text. Many
// surviving mutants (blanked progress strings, flipped `!opts.json` guards,
// an off-by-one loop bound) are invisible to that style because:
//   - several call sites print the IDENTICAL literal ("done", the 40-dash
//     divider) so a substring check on the whole run's output still passes
//     when ONE of those call sites is silenced by a mutant while a sibling
//     call site still emits the same text;
//   - a `!opts.json` guard flipped to a constant is only wrong in the mode
//     nobody asserted an ABSENCE for.
// This file asserts exact call arguments (`toHaveBeenCalledWith`,
// `toContainEqual`, exact counts) instead, so each specific call site is
// pinned independently of its siblings. Same mocking strategy as the
// companion file, duplicated here so this file is a fully self-contained,
// statically-imported SUT consumer (mutation-runner placement contract).
// ===========================================

const mocks = vi.hoisted(() => ({
	execSync: vi.fn(),
	execFileSync: vi.fn(),
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	mkdirSync: vi.fn(),
	realpathSync: vi.fn(),
	homedir: vi.fn(),
	writeHookScript: vi.fn(),
	installAllHooks: vi.fn(),
	detectClients: vi.fn(),
	refreshClientSkills: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execSync: mocks.execSync,
	execFileSync: mocks.execFileSync,
}));

vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	readFileSync: mocks.readFileSync,
	mkdirSync: mocks.mkdirSync,
	realpathSync: mocks.realpathSync,
}));

vi.mock("node:os", () => ({
	homedir: mocks.homedir,
}));

// Pass-through formatter: `c.red("x")` === "x", so every progress/status line
// asserted below is the literal, un-decorated text.
vi.mock("../lib/formatter.js", () => ({
	c: new Proxy(
		{},
		{
			get: () => (s: string) => s,
		},
	),
}));

vi.mock("../lib/hooks.js", () => ({
	writeHookScript: mocks.writeHookScript,
	installAllHooks: mocks.installAllHooks,
}));

vi.mock("../lib/settings.js", () => ({ detectClients: mocks.detectClients }));

vi.mock("./skill-refresh.js", () => ({ refreshClientSkills: mocks.refreshClientSkills }));

import { INTERLINKED_CLI_REPO_URL, updateCommand } from "./update.js";

class ProcessExit extends Error {
	constructor(public code: number) {
		super(`process.exit(${code})`);
	}
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

const CLI_ROOT = "/src/interlinked-cli";
const HOME = "/home/dev";
const MANAGED_ROOT = `${HOME}/.interlinked/interlinked-cli`;
const DASH_LINE = "─".repeat(40);

/** Happy-path source-checkout fs/git layout, mirroring the companion file's
 *  default so both files exercise the same baseline behavior. */
function setSourceCheckoutLayout(): void {
	mocks.realpathSync.mockReturnValue(`${CLI_ROOT}/dist/index.js`);
	mocks.existsSync.mockImplementation((p: unknown) => {
		const path = String(p);
		if (path === `${CLI_ROOT}/package.json`) return true;
		if (path === `${CLI_ROOT}/.git`) return true;
		if (path === `${CLI_ROOT}/src/index.ts`) return true;
		if (path === `${CLI_ROOT}/package-lock.json`) return true;
		if (path === `${CLI_ROOT}/node_modules`) return true;
		return false;
	});
	mocks.readFileSync.mockImplementation((p: unknown) => {
		const path = String(p);
		if (path === `${CLI_ROOT}/package.json`) {
			return JSON.stringify({ name: "interlinked-cli", version: "1.2.3" });
		}
		return "{}";
	});
	mocks.execSync.mockImplementation((cmd: unknown) => {
		const command = String(cmd);
		if (command.includes("status --porcelain")) return "";
		if (command.includes("rev-parse --abbrev-ref")) return "main\n";
		if (command.includes("rev-parse --short")) return "abc1234\n";
		if (command.includes("git pull")) return "Already up to date.\n";
		return "";
	});
	mocks.homedir.mockReturnValue(HOME);
}

/** Count single-arg console.log calls that equal `text` exactly — the tool
 *  for distinguishing "silenced by THIS call site" from "a sibling call
 *  site happens to print the same literal". */
function exactLogCount(text: string): number {
	return (logSpy.mock.calls).filter((call: unknown[]) => call.length === 1 && call[0] === text).length;
}

function execCmds(): string[] {
	return mocks.execSync.mock.calls.map((call: unknown[]) => String(call[0]));
}

function ranCmd(substr: string): boolean {
	return execCmds().some((command: string) => command.includes(substr));
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new ProcessExit(Number(code ?? 0));
	});
	vi.spyOn(process, "cwd").mockReturnValue("/cwd");
	process.argv[1] = "/bin/interlinked";
	setSourceCheckoutLayout();
	mocks.execFileSync.mockReturnValue("");
	mocks.detectClients.mockReturnValue([]);
	mocks.refreshClientSkills.mockReturnValue({
		results: [],
		outputLines: [],
		summary: { clients: [], installed: 0, changed: 0, warnings: [] },
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ===========================================
// Human happy path: exact progress-line, encoding, and exec-options text.
// ===========================================

describe("update — exact progress-line and encoding assertions (human happy path)", () => {
	// test-contract: invariant — attemptGitPull and buildCli each write their
	// own progress prefix, and printUpdateHeader's divider is the ONLY
	// 40-dash line in a non-managed run; a StringLiteral mutant blanking
	// either prefix, or a `!opts.json` guard flipped to a constant, must be
	// visible via the exact write payload.
	it("writes the exact 'Pulling latest... ' and 'Building... ' progress prefixes and exactly one dash-divider line", async () => {
		await updateCommand({});

		expect(stdoutSpy.mock.calls).toContainEqual(["Pulling latest... "]);
		expect(stdoutSpy.mock.calls).toContainEqual(["Building... "]);
		expect(exactLogCount(DASH_LINE)).toBe(1);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	// test-contract: invariant — resolveCliRoot finds CLI_ROOT on its SECOND
	// ancestor probe (dist/ has no package.json); an existsSync guard forced
	// to always-true would read (and possibly match) a package.json one
	// directory too early.
	it("never reads a package.json at the dist/ directory the binary actually lives in", async () => {
		await updateCommand({});

		expect(
			mocks.readFileSync.mock.calls.some((call: unknown[]) => String(call[0]) === `${CLI_ROOT}/dist/package.json`),
		).toBe(false);
	});

	// test-contract: invariant — resolveCliRoot's name-check read and
	// getInstalledVersion's final version-check read both pass "utf-8" as the
	// encoding for the SAME path; blanking EITHER site's literal must be
	// visible even though the other site still passes the correct value.
	it("reads CLI_ROOT's package.json with utf-8 encoding exactly twice", async () => {
		await updateCommand({});

		const utf8Reads = mocks.readFileSync.mock.calls.filter(
			(call: unknown[]) => String(call[0]) === `${CLI_ROOT}/package.json` && call[1] === "utf-8",
		);
		expect(utf8Reads).toHaveLength(2);
	});

	// test-contract: invariant — run() passes the full {cwd, encoding,
	// timeout} options object to execSync, unabridged.
	it("passes the full exec options object {cwd, encoding, timeout} to execSync", async () => {
		await updateCommand({});

		expect(mocks.execSync).toHaveBeenCalledWith("git rev-parse --abbrev-ref HEAD", {
			cwd: CLI_ROOT,
			encoding: "utf-8",
			timeout: 60_000,
		});
		// Ties the exact-options call to an actual observable value: the
		// branch line only renders with this text when execSync received
		// (and therefore honored) this exact options object.
		expect(logSpy.mock.calls).toContainEqual(["Branch: main (abc1234)"]);
	});
});

// ===========================================
// JSON mode: absence of the git-pull progress/status lines.
// ===========================================

describe("update — JSON mode silences the git-pull progress and status lines", () => {
	// test-contract: invariant — under --json, runGitPull's "Branch: ..." line
	// and attemptGitPull's "already up to date" line are each guarded by a
	// distinct `!opts.json` check; a guard forced to always-true must be
	// visible even though nothing else in JSON mode ever emits that text.
	it("never logs the Branch: line or the pull-result line under --json", async () => {
		await updateCommand({ json: true });

		expect(logSpy.mock.calls).not.toContainEqual(["Branch: main (abc1234)"]);
		expect(logSpy.mock.calls).not.toContainEqual(["already up to date"]);
	});
});

// ===========================================
// A `pulled=false` result must always skip an already-present node_modules
// install — kills the three runGitPull bare-`false` mutants plus
// attemptGitPull's catch-block `false`.
// ===========================================

describe("update — a false pull result always skips a present node_modules install", () => {
	// test-contract: invariant — installDependencies only proceeds when
	// `pulled` is true OR node_modules is missing; runGitPull's early
	// (no-.git) return must actually convey pulled=false downstream, not
	// just skip printing git output.
	it("skips install when repoRoot has no .git directory (runGitPull's early return)", async () => {
		mocks.realpathSync.mockReturnValue("/opt/global/dist/index.js");
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path.endsWith("/package.json")) {
				return path === `${MANAGED_ROOT}/package.json` ? true : path.startsWith("/opt/global");
			}
			if (path === MANAGED_ROOT) return false; // absent -> clone branch
			if (path === `${MANAGED_ROOT}/package-lock.json`) return true;
			if (path === `${MANAGED_ROOT}/node_modules`) return true;
			return false; // MANAGED_ROOT/.git deliberately absent
		});
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path.startsWith("/opt/global")) return JSON.stringify({ name: "stranger" });
			if (path === `${MANAGED_ROOT}/package.json`) {
				return JSON.stringify({ name: "interlinked-cli", version: "5.5.5" });
			}
			return "{}";
		});

		await updateCommand({});

		expect(ranCmd("npm ci")).toBe(false);
		expect(ranCmd("npm install")).toBe(false);
	});

	// test-contract: invariant — warnDirtyTreeSkippingPull's caller returns
	// false for a dirty, unforced tree; that false must reach
	// installDependencies, not just print the warning text.
	it("skips install when the tree is dirty and --force is absent", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return " M src/x.ts";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "dddd111";
			return "";
		});

		await updateCommand({});

		expect(ranCmd("npm ci")).toBe(false);
		expect(ranCmd("npm install")).toBe(false);
	});

	// test-contract: invariant — runGitPull's outer catch (an early git
	// command throwing) returns false; that false must reach
	// installDependencies.
	it("skips install when an early git command throws", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) throw new Error("no git binary");
			return "";
		});

		await updateCommand({});

		expect(ranCmd("npm ci")).toBe(false);
		expect(ranCmd("npm install")).toBe(false);
	});

	// test-contract: invariant — attemptGitPull's catch (git pull itself
	// throwing) returns false; that false must reach installDependencies.
	it("skips install when `git pull` itself throws", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "f00";
			if (command.includes("git pull")) throw new Error("network down");
			return "";
		});

		await updateCommand({});

		expect(ranCmd("npm ci")).toBe(false);
		expect(ranCmd("npm install")).toBe(false);
	});
});

// ===========================================
// installDependencies: precise progress-line and completion-line assertions.
// ===========================================

describe("update — installDependencies precise progress-line and completion assertions", () => {
	// test-contract: invariant — installDependencies writes its own progress
	// prefix and its own "done" line, each behind an independent
	// `!opts.json` guard; both must be observed as PRESENT in human mode
	// when install actually runs. The subsequent build step is forced to
	// fail so build's identically-texted "done" never fires, isolating the
	// count to install's own line.
	it("writes 'Installing dependencies... ' and exactly one 'done' line when install runs and the later build fails", async () => {
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) return true;
			if (path === `${CLI_ROOT}/.git`) return true;
			if (path === `${CLI_ROOT}/src/index.ts`) return true;
			if (path === `${CLI_ROOT}/node_modules`) return false; // forces install
			return false; // no lockfile -> npm install, not npm ci
		});
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "x";
			if (command.includes("git pull")) return "ok";
			if (command.includes("npm install")) return ""; // install succeeds
			if (command.includes("npm run build")) throw new Error("tsc exploded"); // fails after
			return "";
		});

		await expect(updateCommand({})).rejects.toBeInstanceOf(ProcessExit);

		expect(stdoutSpy.mock.calls).toContainEqual(["Installing dependencies... "]);
		expect(exactLogCount("done")).toBe(1);
	});
});

// ===========================================
// ensureManagedSourceCheckout + linkManagedCheckout: precise progress lines
// for the fresh-clone path.
// ===========================================

describe("update — managed-checkout clone and link precise progress lines", () => {
	function setCloneAbsentLayout(): void {
		mocks.realpathSync.mockReturnValue("/opt/global/dist/index.js");
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path.endsWith("/package.json")) {
				return path === `${MANAGED_ROOT}/package.json` ? true : path.startsWith("/opt/global");
			}
			if (path === MANAGED_ROOT) return false; // absent -> clone branch
			if (path === `${MANAGED_ROOT}/.git`) return false; // fresh clone -> runGitPull no-ops
			if (path === `${MANAGED_ROOT}/package-lock.json`) return true;
			if (path === `${MANAGED_ROOT}/node_modules`) return true;
			return false;
		});
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path.startsWith("/opt/global")) return JSON.stringify({ name: "stranger" });
			if (path === `${MANAGED_ROOT}/package.json`) {
				return JSON.stringify({ name: "interlinked-cli", version: "2.0.0" });
			}
			return "{}";
		});
		mocks.homedir.mockReturnValue(HOME);
	}

	// test-contract: invariant — the clone branch prints its own header
	// divider, its own "Cloning source... " prefix, its own "Repo URL:" line,
	// and a "done" line on success, plus linkManagedCheckout's own prefix.
	// The divider and "done" text are shared with printUpdateHeader/buildCli
	// respectively, so only an exact COUNT across the whole run (not a
	// substring check) attributes a silenced call site to THIS branch.
	it("writes 'Cloning source... ', the Repo URL line, 'Linking CLI binaries... ', two dash-dividers, and exactly three done lines", async () => {
		setCloneAbsentLayout();

		await updateCommand({});

		expect(stdoutSpy.mock.calls).toContainEqual(["Cloning source... "]);
		expect(stdoutSpy.mock.calls).toContainEqual(["Linking CLI binaries... "]);
		expect(logSpy.mock.calls).toContainEqual([`Repo URL:  ${INTERLINKED_CLI_REPO_URL}`]);
		// git clone's exec options: exact, catching a StringLiteral utf-8 blank.
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"git",
			["clone", INTERLINKED_CLI_REPO_URL, MANAGED_ROOT],
			{ cwd: `${HOME}/.interlinked`, encoding: "utf-8", timeout: 120_000 },
		);
		// GitHub-Checkout header + Self-Update header both print the divider.
		expect(exactLogCount(DASH_LINE)).toBe(2);
		// clone success + build success + link success.
		expect(exactLogCount("done")).toBe(3);
	});

	// test-contract: invariant — a failed clone logs the bare "failed" line
	// (human mode) before calling fail(); this text is distinct from fail()'s
	// own "Failed to clone ..." console.error line and is otherwise untested.
	it("logs the bare 'failed' line before fail() on a clone error (human mode)", async () => {
		setCloneAbsentLayout();
		mocks.execFileSync.mockImplementation((_file: unknown, args: unknown) => {
			if (Array.isArray(args) && (parseWire(args, wireArray(wireString), "test JSON value")).includes("clone")) {
				throw new Error("clone refused");
			}
			return "";
		});

		await expect(updateCommand({})).rejects.toBeInstanceOf(ProcessExit);

		expect(logSpy.mock.calls).toContainEqual(["failed"]);
	});

	// test-contract: invariant — under --json, none of the clone header, its
	// progress prefix, or its "done" line may print, even though the clone,
	// build, and link steps all genuinely run and succeed.
	it("prints no stdout progress and no dash/done lines for a fresh managed clone under --json", async () => {
		setCloneAbsentLayout();

		await updateCommand({ json: true });

		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(exactLogCount(DASH_LINE)).toBe(0);
		expect(exactLogCount("done")).toBe(0);
	});

	// test-contract: invariant — under --json, a clone failure must not log
	// the bare "failed" line (only the JSON error envelope).
	it("emits no bare 'failed' line under --json when the clone throws", async () => {
		setCloneAbsentLayout();
		mocks.execFileSync.mockImplementation((_file: unknown, args: unknown) => {
			if (Array.isArray(args) && (parseWire(args, wireArray(wireString), "test JSON value")).includes("clone")) {
				throw new Error("nope");
			}
			return "";
		});

		await expect(updateCommand({ json: true })).rejects.toBeInstanceOf(ProcessExit);

		expect(logSpy.mock.calls).not.toContainEqual(["failed"]);
	});
});

// ===========================================
// JSON mode, everything runs and succeeds: pull + install + link + refresh.
// ===========================================

describe("update — JSON mode silences every guarded line even when every step runs and succeeds", () => {
	function setManagedReuseForcedPullAndRefresh(): void {
		mocks.realpathSync.mockReturnValue("/opt/global/dist/index.js");
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path.endsWith("/package.json")) {
				return path === `${MANAGED_ROOT}/package.json` ? true : path.startsWith("/opt/global");
			}
			if (path === MANAGED_ROOT) return true; // already checked out -> reuse branch
			if (path === `${MANAGED_ROOT}/.git`) return true;
			if (path === `${MANAGED_ROOT}/src/index.ts`) return true;
			if (path === `${MANAGED_ROOT}/node_modules`) return false; // forces install too
			if (path === "/cwd/.interlinked") return true; // triggers refresh
			return false; // no lockfile -> npm install
		});
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path.startsWith("/opt/global")) return JSON.stringify({ name: "stranger" });
			if (path === `${MANAGED_ROOT}/package.json`) {
				return JSON.stringify({ name: "interlinked-cli", version: "2.5.0" });
			}
			return "{}";
		});
		let sha = "before";
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return sha;
			if (command.includes("git pull")) {
				sha = "after"; // HEAD advances -> pulled=true -> forces install regardless
				return "ok";
			}
			return "";
		});
		mocks.homedir.mockReturnValue(HOME);
		mocks.detectClients.mockReturnValue([{ name: "codex", exists: true }]);
		mocks.refreshClientSkills.mockReturnValue({
			results: [],
			outputLines: [],
			summary: { clients: ["codex"], installed: 1, changed: 1, warnings: ["heads up"] },
		});
	}

	// test-contract: invariant — every progress-prefix write, every "done"
	// line, and every refresh-warning line in this file is individually
	// guarded by `!opts.json`; with pull+install+link+refresh ALL running
	// and succeeding, pristine code must still emit zero of them under
	// --json. A guard flipped to always-true (or polarity-flipped) on ANY of
	// those independent sites breaks this.
	it("writes no stdout progress, no 'done' lines, and no warning lines when pull+install+link+refresh all succeed under --json", async () => {
		setManagedReuseForcedPullAndRefresh();

		await updateCommand({ json: true });

		expect(ranCmd("npm install")).toBe(true); // sanity: install really ran
		expect(ranCmd("npm link")).toBe(true); // sanity: link really ran
		expect(mocks.refreshClientSkills).toHaveBeenCalled(); // sanity: refresh really ran
		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(exactLogCount("done")).toBe(0);
		expect(logSpy.mock.calls).not.toContainEqual(["  heads up"]);
	});
});

// ===========================================
// refreshLocalInstall: client filtering, gating, and its own progress lines.
// ===========================================

describe("update — refreshLocalInstall client filtering and gating", () => {
	function withInterlinkedDirDefault(): void {
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) return true;
			if (path === `${CLI_ROOT}/.git`) return true;
			if (path === `${CLI_ROOT}/src/index.ts`) return true;
			if (path === `${CLI_ROOT}/package-lock.json`) return true;
			if (path === `${CLI_ROOT}/node_modules`) return true;
			if (path === "/cwd/.interlinked") return true;
			return false;
		});
	}

	// test-contract: invariant — refreshLocalInstall's very first line
	// returns early, WITHOUT touching hooks/settings/skill-refresh at all,
	// when cwd has no `.interlinked/` directory (the default fs layout).
	it("never calls the hook/settings/skill-refresh modules when cwd has no .interlinked", async () => {
		await updateCommand({});

		expect(mocks.writeHookScript).not.toHaveBeenCalled();
		expect(mocks.installAllHooks).not.toHaveBeenCalled();
		expect(mocks.detectClients).not.toHaveBeenCalled();
		expect(mocks.refreshClientSkills).not.toHaveBeenCalled();
	});

	// test-contract: invariant — installAllHooks only runs for a NON-EMPTY
	// filtered client list; detectClients() returning [] (the default mock)
	// must leave it uncalled, distinguishing `length > 0` from a mutant that
	// is unconditionally true or accepts `length >= 0` (also always true for
	// a non-negative length).
	it("does not call installAllHooks when detectClients returns no clients", async () => {
		withInterlinkedDirDefault();
		// mocks.detectClients defaults to [] from beforeEach.

		await updateCommand({});

		expect(mocks.installAllHooks).not.toHaveBeenCalled();
		// Positive value check alongside the negative one: the empty,
		// correctly-typed [] still reaches refreshClientSkills, proving we
		// took the "computed clients=[]" branch rather than bailing out
		// before the client-detection logic ran at all.
		expect(mocks.refreshClientSkills).toHaveBeenCalledWith("/cwd", []);
	});

	// test-contract: invariant — only clients with `exists: true` are passed
	// to installAllHooks; the `.filter((c) => c.exists)` step must actually
	// run, not just the `.map`.
	it("filters out clients whose exists flag is false before calling installAllHooks", async () => {
		withInterlinkedDirDefault();
		mocks.detectClients.mockReturnValue([
			{ name: "codex", exists: true },
			{ name: "cursor", exists: false },
		]);

		await updateCommand({});

		expect(mocks.installAllHooks).toHaveBeenCalledWith("/cwd", ["codex"]);
	});

	// test-contract: invariant — refreshLocalInstall prints its own "done"
	// line (text shared with buildCli's); an exact COUNT across the run
	// (build's + refresh's) attributes a silenced "done" to refresh
	// specifically, rather than a substring check that both would satisfy.
	it("writes exactly two 'done' lines (build + refresh) when the local refresh succeeds", async () => {
		withInterlinkedDirDefault();
		mocks.detectClients.mockReturnValue([{ name: "codex", exists: true }]);

		await updateCommand({});

		expect(exactLogCount("done")).toBe(2);
	});

	// test-contract: invariant — a non-empty refresh warnings array is
	// logged one line per warning, prefixed with two spaces, via the
	// forEach callback; this pins both "the loop ran" (the guard) and "the
	// callback itself performs the log" (not replaced by a no-op).
	it("logs each refresh warning with its two-space prefix in human mode", async () => {
		withInterlinkedDirDefault();
		mocks.detectClients.mockReturnValue([{ name: "codex", exists: true }]);
		mocks.refreshClientSkills.mockReturnValue({
			results: [],
			outputLines: [],
			summary: { clients: ["codex"], installed: 1, changed: 0, warnings: ["check your PATH"] },
		});

		await updateCommand({});

		expect(logSpy.mock.calls).toContainEqual(["  check your PATH"]);
	});
});

// ===========================================
// Exact "Error: " / "Warning: " prefix text.
// ===========================================

describe("update — exact error/warning prefix text", () => {
	// test-contract: invariant — fail()'s human-mode line is the single
	// template string `Error: <message>`, not a bare message with no prefix.
	it("prefixes fail()'s human-mode message with the exact 'Error: ' text", async () => {
		mocks.realpathSync.mockReturnValue("/opt/global/dist/index.js");
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path.endsWith("/package.json")) return path.startsWith("/opt/global");
			if (path === MANAGED_ROOT) return true; // dir exists, but...
			return false; // ...no .git / src markers -> not a valid checkout
		});
		mocks.readFileSync.mockReturnValue(JSON.stringify({ name: "stranger", version: "0" }));
		mocks.homedir.mockReturnValue(HOME);

		await expect(updateCommand({})).rejects.toBeInstanceOf(ProcessExit);

		expect(errSpy.mock.calls).toContainEqual([
			`Error: Managed checkout path exists but is not an interlinked-cli source checkout: ${MANAGED_ROOT}`,
		]);
	});

	// test-contract: invariant — warnDirtyTreeSkippingPull's first line is
	// the single string `Warning: Working tree has uncommitted changes.`.
	it("prefixes the dirty-tree message with the exact 'Warning: ' text", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return " M src/x.ts";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "dddd111";
			return "";
		});

		await updateCommand({});

		expect(logSpy.mock.calls).toContainEqual(["Warning: Working tree has uncommitted changes."]);
	});
});

// ===========================================
// resolveCliRoot boundary conditions.
// ===========================================

describe("update — resolveCliRoot boundary conditions", () => {
	// test-contract: invariant — `process.argv[1] === undefined` returns null
	// BEFORE calling realpathSync at all; realpathSync must never be invoked
	// on an undefined path.
	it("never calls realpathSync when process.argv[1] is undefined", async () => {
		process.argv.length = 1;
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === MANAGED_ROOT) return true;
			if (path === `${MANAGED_ROOT}/.git`) return true;
			if (path === `${MANAGED_ROOT}/src/index.ts`) return true;
			if (path === `${MANAGED_ROOT}/package.json`) return true;
			if (path === `${MANAGED_ROOT}/package-lock.json`) return true;
			if (path === `${MANAGED_ROOT}/node_modules`) return true;
			return false;
		});
		mocks.readFileSync.mockReturnValue(JSON.stringify({ name: "interlinked-cli", version: "1.0.0" }));

		await updateCommand({});

		expect(mocks.realpathSync).not.toHaveBeenCalled();
	});

	// test-contract: invariant — the ancestor walk checks at most 5
	// directory levels (`i < 5`); a package.json sitting exactly one level
	// past that bound must never be probed.
	it("never probes a package.json 6 directory levels above the binary", async () => {
		mocks.realpathSync.mockReturnValue("/deep6/a/b/c/d/dist/index.js");
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === MANAGED_ROOT) return true;
			if (path === `${MANAGED_ROOT}/.git`) return true;
			if (path === `${MANAGED_ROOT}/src/index.ts`) return true;
			if (path === `${MANAGED_ROOT}/package.json`) return true;
			if (path === `${MANAGED_ROOT}/package-lock.json`) return true;
			if (path === `${MANAGED_ROOT}/node_modules`) return true;
			return false; // every /deep6/... package.json probe reports absent
		});
		mocks.readFileSync.mockReturnValue(JSON.stringify({ name: "interlinked-cli", version: "6.6.6" }));

		await updateCommand({});

		expect(mocks.existsSync.mock.calls.map((call: unknown[]) => String(call[0]))).not.toContain(
			"/deep6/package.json",
		);
	});

	// test-contract: invariant — a non-object package.json at a SHALLOWER
	// ancestor must not abort the walk; parsePackageJsonUsed returning null
	// for it has to let the loop continue to the real interlinked-cli
	// package.json one level up. An unguarded property access/destructure on
	// that null throws, which the surrounding try/catch turns into a wrong
	// early `null` return instead of finding the real root.
	it("keeps walking past a non-object package.json to find the real interlinked-cli root", async () => {
		mocks.realpathSync.mockReturnValue(`${CLI_ROOT}/dist/index.js`);
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/dist/package.json`) return true; // shallower, non-object
			if (path === `${CLI_ROOT}/package.json`) return true; // real one, one level up
			if (path === `${CLI_ROOT}/.git`) return true;
			if (path === `${CLI_ROOT}/src/index.ts`) return true;
			if (path === `${CLI_ROOT}/package-lock.json`) return true;
			if (path === `${CLI_ROOT}/node_modules`) return true;
			return false;
		});
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/dist/package.json`) return "null";
			if (path === `${CLI_ROOT}/package.json`) {
				return JSON.stringify({ name: "interlinked-cli", version: "8.8.8" });
			}
			return "{}";
		});

		await updateCommand({});

		expect(logSpy.mock.calls).not.toContainEqual([`Repo URL:  ${INTERLINKED_CLI_REPO_URL}`]);
		expect(logSpy.mock.calls).toContainEqual(["Updated to Interlinked CLI v8.8.8"]);
	});
});
