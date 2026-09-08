import { parseWire, wireArray, wireString } from "../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================
// Behavioral tests for `interlinked update` (self-update command).
//
// Strategy: mock every effectful boundary so the branch tree is driven
// deterministically and nothing touches the real disk / git / npm:
//   - node:child_process  → execSync / execFileSync spies (git, npm)
//   - node:fs             → existsSync / readFileSync / mkdirSync / realpathSync
//   - node:os             → homedir (managed-checkout root)
//   - ../lib/formatter.js → pass-through `c` so we assert plain strings
//   - hooks/settings/skill-refresh → local install refresh spies (Step 5)
// process.exit throws a typed sentinel so `never`-returning paths can be
// asserted on (exit code + that execution stopped at that point).
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

// Pass-through formatter: `c.red("x")` === "x". Assertions can match the
// literal message text without smuggling ANSI escape codes.
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

import { nonNull } from "../lib/non-null.js";
import {
	getManagedSourceRoot,
	INTERLINKED_CLI_REPO_URL,
	resolveSourceRepoRoot,
	updateCommand,
} from "./update.js";

class ProcessExit extends Error {
	constructor(public code: number) {
		super(`process.exit(${code})`);
	}
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

// ---- Defaults: a "source checkout" install that is a clean, up-to-date git
//      repo with node_modules + package-lock present and no .interlinked/ dir.
//      Individual tests override the fs / git surface to reach other branches.

const CLI_ROOT = "/src/interlinked-cli";
const HOME = "/home/dev";

/** Reset every fs path predicate to the happy-path source-checkout layout. */
function setSourceCheckoutLayout(): void {
	// resolveCliRoot: realpath(argv[1]) -> dist/index.js, walk up one to CLI_ROOT.
	mocks.realpathSync.mockReturnValue(`${CLI_ROOT}/dist/index.js`);
	mocks.existsSync.mockImplementation((p: unknown) => {
		const path = String(p);
		// package.json lives at CLI_ROOT (used by resolveCliRoot + version).
		if (path === `${CLI_ROOT}/package.json`) return true;
		// source-checkout markers (.git + src/index.ts at CLI_ROOT).
		if (path === `${CLI_ROOT}/.git`) return true;
		if (path === `${CLI_ROOT}/src/index.ts`) return true;
		// install step: lockfile + node_modules present -> no install by default.
		if (path === `${CLI_ROOT}/package-lock.json`) return true;
		if (path === `${CLI_ROOT}/node_modules`) return true;
		// no .interlinked dir in cwd by default -> skip hook regen.
		return false;
	});
	mocks.readFileSync.mockImplementation((p: unknown) => {
		const path = String(p);
		if (path === `${CLI_ROOT}/package.json`) {
			return JSON.stringify({ name: "interlinked-cli", version: "1.2.3" });
		}
		return "{}";
	});
	// git: clean tree, on main, sha holds steady across pull (no update).
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

/** Concatenate all console.log calls into one searchable string. */
function logText(): string {
	return logSpy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");
}

function errText(): string {
	return errSpy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");
}

/** All console.log calls as their first-arg strings (JSON envelopes). */
function logLines(): string[] {
	return logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
}

/** Concatenate every process.stdout.write payload (progress prefixes). */
function stdoutText(): string {
	return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
}

/** All execSync command strings issued so far. */
function execCmds(): string[] {
	return mocks.execSync.mock.calls.map((call: unknown[]) => String(call[0]));
}

/** Whether any execSync command matched a substring. */
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
	// process.argv[1] is read by resolveCliRoot; give it a stable value.
	process.argv[1] = "/bin/interlinked";
	setSourceCheckoutLayout();
	// runFile() trims execFileSync's return, so it must default to a string
	// (git clone / remote set-url go through it). Tests that exercise the
	// failure paths re-implement this to throw on the relevant verb.
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
// Pure-export unit coverage (also keeps the old tombstone assertions).
// ===========================================

describe("update — pure exports", () => {
	it("exposes the canonical GitHub source repo URL", () => {
		expect(INTERLINKED_CLI_REPO_URL).toBe(
			"https://github.com/QuentinCody/interlinked-cli.git",
		);
	});

	it("places the managed checkout under <home>/.interlinked/interlinked-cli", () => {
		expect(getManagedSourceRoot("/tmp/home")).toBe(
			"/tmp/home/.interlinked/interlinked-cli",
		);
	});

	it("defaults the managed checkout root to the real homedir", () => {
		mocks.homedir.mockReturnValue("/users/me");
		expect(getManagedSourceRoot()).toBe("/users/me/.interlinked/interlinked-cli");
	});

	it("resolveSourceRepoRoot returns cliRoot when .git + src/index.ts sit there", () => {
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			return path === "/repo/.git" || path === "/repo/src/index.ts";
		});
		expect(resolveSourceRepoRoot("/repo")).toBe("/repo");
	});

	it("resolveSourceRepoRoot walks up to the parent dir holding .git (monorepo)", () => {
		// .git at the parent, src/index.ts under the cli subdir.
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			return path === "/mono/.git" || path === "/mono/cli/src/index.ts";
		});
		expect(resolveSourceRepoRoot("/mono/cli")).toBe("/mono");
	});

	it("resolveSourceRepoRoot returns null when src/index.ts is absent", () => {
		// .git present at both candidates but no src/index.ts -> not a checkout.
		mocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith("/.git"));
		expect(resolveSourceRepoRoot("/x")).toBeNull();
	});

	it("resolveSourceRepoRoot returns null when nothing matches", () => {
		mocks.existsSync.mockReturnValue(false);
		expect(resolveSourceRepoRoot("/nope")).toBeNull();
	});
});

// ===========================================
// Source-checkout happy path (human output).
// ===========================================

describe("update — source checkout, human output", () => {
	it("prints header, clean-tree pull, and the new version", async () => {
		await updateCommand({});

		const out = logText();
		expect(out).toContain("Interlinked CLI — Self-Update");
		expect(out).toContain(`CLI root:  ${CLI_ROOT}`);
		expect(out).toContain(`Repo root: ${CLI_ROOT}`);
		// Not a managed checkout -> no Repo URL line.
		expect(out).not.toContain(`Repo URL:  ${INTERLINKED_CLI_REPO_URL}`);
		// Branch line from git.
		expect(out).toContain("Branch: main (abc1234)");
		// Pull ran, sha unchanged -> "already up to date".
		expect(out).toContain("already up to date");
		// Build completion line.
		expect(out).toContain("done");
		// Final version line pulls from package.json.
		expect(out).toContain("Updated to Interlinked CLI v1.2.3");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("runs git pull and npm run build but NOT install when node_modules exists and no pull", async () => {
		await updateCommand({});

		expect(ranCmd("npm run build")).toBe(true);
		expect(ranCmd("git pull --ff-only")).toBe(true);
		// node_modules present + sha unchanged (pulled=false) -> install skipped.
		expect(ranCmd("npm ci")).toBe(false);
		expect(ranCmd("npm install")).toBe(false);
		// Does not link (not a managed checkout).
		expect(ranCmd("npm link")).toBe(false);
	});

	it("reports a real version bump when the post-pull sha differs", async () => {
		let sha = "before00";
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return sha;
			if (command.includes("git pull")) {
				sha = "after999"; // pull advanced HEAD
				return "Updating...";
			}
			return "";
		});

		await updateCommand({});

		expect(logText()).toContain("updated before00 → after999");
		// pulled=true forces an install pass even though node_modules exists.
		expect(ranCmd("npm ci")).toBe(true);
	});
});

// ===========================================
// Uncommitted-tree branch + --force.
// ===========================================

describe("update — dirty working tree", () => {
	it("warns and skips pull when the tree is dirty and --force is absent", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return " M src/x.ts"; // dirty
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "dddd111";
			return "";
		});

		await updateCommand({});

		const out = logText();
		expect(out).toContain("Working tree has uncommitted changes.");
		expect(out).toContain("Use --force to pull anyway");
		expect(out).toContain("Skipping git pull — rebuilding from current source.");
		// No pull command issued.
		expect(ranCmd("git pull")).toBe(false);
	});

	it("--force pulls despite a dirty tree", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return " M src/x.ts"; // dirty
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "eeee222";
			if (command.includes("git pull")) return "ok";
			return "";
		});

		await updateCommand({ force: true });

		expect(ranCmd("git pull --ff-only")).toBe(true);
		expect(logText()).not.toContain("uncommitted changes");
	});
});

// ===========================================
// Git failure branches (inner pull-catch + outer git-catch).
// ===========================================

describe("update — git failure paths", () => {
	it("swallows a failed `git pull` and rebuilds from current source", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "f00";
			if (command.includes("git pull")) throw new Error("network down");
			return "";
		});

		await updateCommand({});

		expect(logText()).toContain("skipped (pull failed — rebuilding from current source)");
		// Build still runs after the pull failure.
		expect(ranCmd("npm run build")).toBe(true);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("falls back to 'Git not available' when an early git command throws", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			// The very first git call (status) throws -> outer catch.
			if (command.includes("status --porcelain")) throw new Error("no git binary");
			return "";
		});

		await updateCommand({});

		expect(logText()).toContain("Git not available — rebuilding from current source.");
	});

	it("skips all git steps when repoRoot has no .git directory (Step-1 false branch)", async () => {
		// The only path that reaches Step 1 with isGitRepo === false is a *freshly
		// cloned* managed checkout: resolveSourceRepoRoot requires .git, so a source
		// checkout is always a git repo; the clone branch (checkout absent) returns
		// repoRoot WITHOUT consulting .git, so we can leave .git absent entirely.
		const managedRoot = `${HOME}/.interlinked/interlinked-cli`;
		// resolveCliRoot -> null (stranger package.json), so we bootstrap managed.
		mocks.realpathSync.mockReturnValue("/opt/global/dist/index.js");
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path.endsWith("/package.json")) {
				return path === `${managedRoot}/package.json` ? true : path.startsWith("/opt/global");
			}
			if (path === managedRoot) return false; // checkout absent -> clone branch
			// .git deliberately absent on the cloned dir -> Step 1 isGitRepo false.
			if (path === `${managedRoot}/package-lock.json`) return true;
			if (path === `${managedRoot}/node_modules`) return true;
			return false;
		});
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path.startsWith("/opt/global")) return JSON.stringify({ name: "stranger" });
			if (path === `${managedRoot}/package.json`) {
				return JSON.stringify({ name: "interlinked-cli", version: "5.5.5" });
			}
			return "{}";
		});

		await updateCommand({});

		// Clone happened (execFileSync), but no git porcelain/pull/rev-parse ran.
		expect(
			mocks.execFileSync.mock.calls.some(
				(call: unknown[]) => Array.isArray(call[1]) && (parseWire(call[1], wireArray(wireString), "test JSON value")).includes("clone"),
			),
		).toBe(true);
		expect(ranCmd("git pull")).toBe(false);
		expect(ranCmd("status --porcelain")).toBe(false);
		expect(ranCmd("rev-parse")).toBe(false);
		// The build still ran and the version line printed.
		expect(ranCmd("npm run build")).toBe(true);
		expect(logText()).toContain("Updated to Interlinked CLI v5.5.5");
	});
});

// ===========================================
// Install step branches (npm ci vs npm install vs failure).
// ===========================================

describe("update — dependency install step", () => {
	it("uses `npm ci` when package-lock.json is present (after a pull)", async () => {
		// Force pulled=true via a sha change so install runs.
		let sha = "a";
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return sha;
			if (command.includes("git pull")) {
				sha = "b";
				return "ok";
			}
			return "";
		});

		await updateCommand({});

		expect(execCmds()).toContain("npm ci --no-audit --no-fund");
	});

	it("uses `npm install` when node_modules is missing and there is no lockfile", async () => {
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) return true;
			if (path === `${CLI_ROOT}/.git`) return true;
			if (path === `${CLI_ROOT}/src/index.ts`) return true;
			if (path === `${CLI_ROOT}/package-lock.json`) return false; // no lockfile
			if (path === `${CLI_ROOT}/node_modules`) return false; // forces install
			return false;
		});

		await updateCommand({});

		expect(execCmds()).toContain("npm install --no-audit --no-fund");
	});

	it("swallows an install failure and continues to build", async () => {
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) return true;
			if (path === `${CLI_ROOT}/.git`) return true;
			if (path === `${CLI_ROOT}/src/index.ts`) return true;
			if (path === `${CLI_ROOT}/node_modules`) return false; // forces install
			return false;
		});
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "x";
			if (command.includes("git pull")) return "ok";
			if (command.includes("npm install")) throw new Error("install boom");
			return "";
		});

		await updateCommand({});

		expect(logText()).toContain("skipped (install failed)");
		expect(ranCmd("npm run build")).toBe(true);
	});
});

// ===========================================
// Build failure (exit 1) — human and JSON.
// ===========================================

describe("update — build failure", () => {
	it("exits 1 and prints the error in human mode when build throws", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "abc1234";
			if (command.includes("git pull")) return "Already up to date.";
			if (command.includes("npm run build")) throw new Error("tsc exploded");
			return "";
		});

		await expect(updateCommand({})).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errText()).toContain("Build failed:");
		expect(errText()).toContain("tsc exploded");
	});

	it("emits a JSON error object and exits 1 when build throws under --json", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "abc1234";
			if (command.includes("git pull")) return "ok";
			if (command.includes("npm run build")) throw new Error("boom");
			return "";
		});

		await expect(updateCommand({ json: true })).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(logText()).toContain(JSON.stringify({ success: false, error: "Build failed" }));
	});
});

// ===========================================
// JSON output happy path.
// ===========================================

describe("update — JSON output", () => {
	it("emits the start envelope and a success envelope, no human chrome", async () => {
		await updateCommand({ json: true });

		const lines = logLines();
		const start = JSON.parse(nonNull(lines[0]));
		expect(start).toMatchObject({
			cli_root: CLI_ROOT,
			repo_root: CLI_ROOT,
			repo_url: INTERLINKED_CLI_REPO_URL,
			managed_checkout: false,
			updating: true,
		});

		const success = JSON.parse(nonNull(lines[lines.length - 1]));
		expect(success).toMatchObject({
			success: true,
			version: "1.2.3",
			pulled: false,
			linked: false,
			managed_checkout: false,
			repo_root: CLI_ROOT,
		});
		// No human header in JSON mode.
		expect(logText()).not.toContain("Interlinked CLI — Self-Update");
		// No progress writes to stdout in JSON mode.
		expect(stdoutSpy).not.toHaveBeenCalled();
	});

	it("reports pulled:true in JSON when HEAD advanced", async () => {
		let sha = "01";
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return sha;
			if (command.includes("git pull")) {
				sha = "02";
				return "ok";
			}
			return "";
		});

		await updateCommand({ json: true });

		const lines = logLines();
		const success = JSON.parse(nonNull(lines[lines.length - 1]));
		expect(success.pulled).toBe(true);
	});
});

// ===========================================
// Managed-checkout path: clone, set-url, link, JSON link errors.
// ===========================================

describe("update — managed checkout (not a source install)", () => {
	const managedRoot = `${HOME}/.interlinked/interlinked-cli`;

	/** fs layout where the running binary is NOT a source checkout. */
	function setNonSourceInstall(opts: { checkoutExists: boolean }): void {
		// resolveCliRoot finds a package.json but with the WRONG name -> null.
		mocks.realpathSync.mockReturnValue("/opt/global/dist/index.js");
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			// resolveCliRoot walks up: every package.json it finds is a stranger.
			if (path.endsWith("/package.json")) {
				// managed root's package.json exists (for version read at the end).
				return path === `${managedRoot}/package.json`
					? true
					: path.startsWith("/opt/global");
			}
			// managed checkout existence toggle.
			if (path === managedRoot) return opts.checkoutExists;
			// managed root is a valid source checkout (resolveSourceRepoRoot).
			if (path === `${managedRoot}/.git`) return opts.checkoutExists;
			if (path === `${managedRoot}/src/index.ts`) return opts.checkoutExists;
			// install: lockfile + node_modules present so we don't fight install here.
			if (path === `${managedRoot}/package-lock.json`) return true;
			if (path === `${managedRoot}/node_modules`) return true;
			return false;
		});
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			// resolveCliRoot reads the stranger package.json -> not interlinked-cli.
			if (path.startsWith("/opt/global")) {
				return JSON.stringify({ name: "some-other-tool", version: "9.9.9" });
			}
			if (path === `${managedRoot}/package.json`) {
				return JSON.stringify({ name: "interlinked-cli", version: "2.0.0" });
			}
			return "{}";
		});
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "managed1";
			if (command.includes("git pull")) return "ok";
			return "";
		});
		mocks.homedir.mockReturnValue(HOME);
	}

	function execFileArgs(): string[][] {
		return mocks.execFileSync.mock.calls
			.map((call: unknown[]) => call[1])
			.filter((args: unknown): args is string[] => Array.isArray(args));
	}

	it("clones the repo when the managed checkout is absent, then links", async () => {
		setNonSourceInstall({ checkoutExists: false });

		await updateCommand({});

		// Parent dir created.
		expect(mocks.mkdirSync).toHaveBeenCalledWith(`${HOME}/.interlinked`, {
			recursive: true,
		});
		// git clone via execFileSync.
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"git",
			["clone", INTERLINKED_CLI_REPO_URL, managedRoot],
			expect.objectContaining({ cwd: `${HOME}/.interlinked` }),
		);
		const out = logText();
		expect(out).toContain("Interlinked CLI — GitHub Checkout");
		expect(out).toContain(`Target:    ${managedRoot}`);
		// Managed checkout -> Repo URL line in the self-update header.
		expect(out).toContain(`Repo URL:  ${INTERLINKED_CLI_REPO_URL}`);
		// npm link runs for managed checkouts.
		expect(ranCmd("npm link")).toBe(true);
		expect(out).toContain("Updated to Interlinked CLI v2.0.0");
	});

	it("reuses an existing managed checkout and resets its origin remote", async () => {
		setNonSourceInstall({ checkoutExists: true });

		await updateCommand({});

		// No clone (already present).
		const cloned = execFileArgs().some((args: string[]) => args.includes("clone"));
		expect(cloned).toBe(false);
		// origin remote re-pointed at the canonical URL.
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"git",
			["remote", "set-url", "origin", INTERLINKED_CLI_REPO_URL],
			expect.objectContaining({ cwd: managedRoot }),
		);
	});

	it("reports pulled+linked+managed_checkout in JSON for a managed update", async () => {
		setNonSourceInstall({ checkoutExists: true });

		await updateCommand({ json: true });

		const lines = logLines();
		const success = JSON.parse(nonNull(lines[lines.length - 1]));
		expect(success).toMatchObject({
			success: true,
			linked: true,
			managed_checkout: true,
			version: "2.0.0",
		});
	});

	it("exits 1 with the clone error when git clone fails", async () => {
		setNonSourceInstall({ checkoutExists: false });
		mocks.execFileSync.mockImplementation((_file: unknown, args: unknown) => {
			if (Array.isArray(args) && (parseWire(args, wireArray(wireString), "test JSON value")).includes("clone")) {
				throw new Error("clone refused");
			}
			return "";
		});

		await expect(updateCommand({})).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		// fail() in human mode goes to console.error.
		expect(errText()).toContain("Failed to clone");
		expect(errText()).toContain("clone refused");
	});

	it("emits a JSON clone error when git clone fails under --json", async () => {
		setNonSourceInstall({ checkoutExists: false });
		mocks.execFileSync.mockImplementation((_file: unknown, args: unknown) => {
			if (Array.isArray(args) && (parseWire(args, wireArray(wireString), "test JSON value")).includes("clone")) {
				throw new Error("nope");
			}
			return "";
		});

		await expect(updateCommand({ json: true })).rejects.toBeInstanceOf(ProcessExit);
		const out = logText();
		expect(out).toContain('"success":false');
		expect(out).toContain("Failed to clone");
	});

	it("exits 1 with a human error when npm link fails", async () => {
		setNonSourceInstall({ checkoutExists: true });
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "m1";
			if (command.includes("git pull")) return "ok";
			if (command.includes("npm run build")) return "";
			if (command.includes("npm link")) throw new Error("link denied");
			return "";
		});

		await expect(updateCommand({})).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(logText()).toContain("failed");
		expect(errText()).toContain("link denied");
	});

	it("emits a JSON link error and exits 1 when npm link fails under --json", async () => {
		setNonSourceInstall({ checkoutExists: true });
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "m1";
			if (command.includes("git pull")) return "ok";
			if (command.includes("npm run build")) return "";
			if (command.includes("npm link")) throw new Error("denied");
			return "";
		});

		await expect(updateCommand({ json: true })).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(logText()).toContain(JSON.stringify({ success: false, error: "npm link failed" }));
	});

	it("set-url failure is non-fatal (swallowed) and the update proceeds", async () => {
		setNonSourceInstall({ checkoutExists: true });
		mocks.execFileSync.mockImplementation((_file: unknown, args: unknown) => {
			if (Array.isArray(args) && (parseWire(args, wireArray(wireString), "test JSON value")).includes("set-url")) {
				throw new Error("remote weirdness");
			}
			return "";
		});

		await updateCommand({});

		// Reached the end despite the set-url throw.
		expect(logText()).toContain("Updated to Interlinked CLI v2.0.0");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("fails closed when the managed path exists but is not a source checkout", async () => {
		// checkout dir exists but lacks .git/src markers -> resolveSourceRepoRoot null.
		mocks.realpathSync.mockReturnValue("/opt/global/dist/index.js");
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path.endsWith("/package.json")) return path.startsWith("/opt/global");
			if (path === managedRoot) return true; // dir exists
			// but it is NOT a valid checkout (no .git / src markers).
			return false;
		});
		mocks.readFileSync.mockReturnValue(
			JSON.stringify({ name: "stranger", version: "0" }),
		);
		mocks.homedir.mockReturnValue(HOME);

		await expect(updateCommand({})).rejects.toBeInstanceOf(ProcessExit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errText()).toContain("is not an interlinked-cli source checkout");
	});
});

// ===========================================
// resolveCliRoot edge: realpathSync throws -> null -> managed bootstrap.
// ===========================================

describe("update — resolveCliRoot failure", () => {
	const managedRoot = `${HOME}/.interlinked/interlinked-cli`;

	it("falls back to a managed checkout when the binary path cannot be resolved", async () => {
		// realpathSync throws -> resolveCliRoot catch -> null -> managed path.
		mocks.realpathSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === managedRoot) return true;
			if (path === `${managedRoot}/.git`) return true;
			if (path === `${managedRoot}/src/index.ts`) return true;
			if (path === `${managedRoot}/package.json`) return true;
			if (path === `${managedRoot}/package-lock.json`) return true;
			if (path === `${managedRoot}/node_modules`) return true;
			return false;
		});
		mocks.readFileSync.mockReturnValue(
			JSON.stringify({ name: "interlinked-cli", version: "3.3.3" }),
		);
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "z";
			return "";
		});
		mocks.homedir.mockReturnValue(HOME);

		await updateCommand({});

		expect(logText()).toContain("Updated to Interlinked CLI v3.3.3");
	});

	it("resolveCliRoot ignores package.json files whose name is not interlinked-cli", async () => {
		// A package.json exists but with the wrong name; walk exhausts -> managed.
		mocks.realpathSync.mockReturnValue("/weird/a/b/c/d/dist/index.js");
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			// every ancestor has a package.json (stranger name).
			if (path.endsWith("/package.json")) {
				return path.startsWith("/weird") || path === `${managedRoot}/package.json`;
			}
			if (path === managedRoot) return true;
			if (path === `${managedRoot}/.git`) return true;
			if (path === `${managedRoot}/src/index.ts`) return true;
			if (path === `${managedRoot}/package-lock.json`) return true;
			if (path === `${managedRoot}/node_modules`) return true;
			return false;
		});
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path.startsWith("/weird")) return JSON.stringify({ name: "not-us" });
			if (path === `${managedRoot}/package.json`) {
				return JSON.stringify({ name: "interlinked-cli", version: "4.4.4" });
			}
			return "{}";
		});
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "z";
			return "";
		});
		mocks.homedir.mockReturnValue(HOME);

		await updateCommand({});

		// Confirms the managed bootstrap won (so resolveCliRoot returned null).
		expect(logText()).toContain(`Repo URL:  ${INTERLINKED_CLI_REPO_URL}`);
		expect(logText()).toContain("Updated to Interlinked CLI v4.4.4");
	});
});

// ===========================================
// Step 5: hook-script regeneration when cwd has .interlinked/.
// ===========================================

describe("update — local hook and skill refresh step", () => {
	function withInterlinkedDir(): void {
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) return true;
			if (path === `${CLI_ROOT}/.git`) return true;
			if (path === `${CLI_ROOT}/src/index.ts`) return true;
			if (path === `${CLI_ROOT}/package-lock.json`) return true;
			if (path === `${CLI_ROOT}/node_modules`) return true;
			if (path === "/cwd/.interlinked") return true; // triggers Step 5
			return false;
		});
	}

	it("refreshes hooks and skills when cwd/.interlinked exists", async () => {
		withInterlinkedDir();
		mocks.detectClients.mockReturnValue([{ name: "codex", exists: true }]);

		await updateCommand({});

		expect(mocks.writeHookScript).toHaveBeenCalledWith("/cwd");
		expect(mocks.installAllHooks).toHaveBeenCalledWith("/cwd", ["codex"]);
		expect(mocks.refreshClientSkills).toHaveBeenCalledWith("/cwd", ["codex"]);
		// Progress prefix is written to stdout, the result to console.log.
		expect(stdoutText()).toContain("Refreshing local hooks and skills...");
		// "done" appears for build and local refresh.
		expect(logText()).toContain("done");
	});

	it("swallows a hook-regeneration failure and still finishes", async () => {
		withInterlinkedDir();
		mocks.writeHookScript.mockImplementation(() => {
			throw new Error("write failed");
		});

		await updateCommand({});

		expect(logText()).toContain("skipped (local refresh failed)");
		expect(logText()).toContain("Updated to Interlinked CLI v1.2.3");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("refreshes without human output in JSON mode when .interlinked exists", async () => {
		withInterlinkedDir();

		await updateCommand({ json: true });

		// Step 5 still runs (import + writeHookScript) but prints nothing.
		expect(mocks.writeHookScript).toHaveBeenCalledWith("/cwd");
		expect(logText()).not.toContain("Refreshing local hooks and skills");
	});
});

// ===========================================
// JSON-mode no-op arms: the same failure scenarios as above but under --json,
// where every `if (!opts.json)` progress/warning line is suppressed. These
// cover the suppressed (false) arm of each such branch and assert nothing
// human leaks while the machine envelope still emits.
// ===========================================

describe("update — JSON mode suppresses human chrome on every soft-failure", () => {
	/** Assert the trailing JSON success envelope plus zero human chrome. */
	function expectCleanJsonSuccess(): void {
		const lines = logLines();
		const success = JSON.parse(nonNull(lines[lines.length - 1]));
		expect(success.success).toBe(true);
		// No human progress strings leaked into stdout/console in JSON mode.
		expect(stdoutText()).toBe("");
		expect(logText()).not.toContain("Warning:");
		expect(logText()).not.toContain("skipped");
		expect(logText()).not.toContain("Git not available");
	}

	it("suppresses the dirty-tree warning under --json (L105 false arm)", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return " M f.ts"; // dirty
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "d1";
			return "";
		});

		await updateCommand({ json: true });

		expect(ranCmd("git pull")).toBe(false); // still skips the pull
		expectCleanJsonSuccess();
	});

	it("suppresses the pull-failed line under --json (L125 false arm)", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "p1";
			if (command.includes("git pull")) throw new Error("pull boom");
			return "";
		});

		await updateCommand({ json: true });

		expect(ranCmd("npm run build")).toBe(true); // build ran after swallowed failure
		expectCleanJsonSuccess();
	});

	it("suppresses the 'Git not available' line under --json (L133 false arm)", async () => {
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) throw new Error("no git");
			return "";
		});

		await updateCommand({ json: true });

		expect(ranCmd("npm run build")).toBe(true); // build still ran
		expectCleanJsonSuccess();
	});

	it("suppresses the 'install failed' line under --json (L149 false arm)", async () => {
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) return true;
			if (path === `${CLI_ROOT}/.git`) return true;
			if (path === `${CLI_ROOT}/src/index.ts`) return true;
			if (path === `${CLI_ROOT}/node_modules`) return false; // forces install
			return false;
		});
		mocks.execSync.mockImplementation((cmd: unknown) => {
			const command = String(cmd);
			if (command.includes("status --porcelain")) return "";
			if (command.includes("rev-parse --abbrev-ref")) return "main";
			if (command.includes("rev-parse --short")) return "i1";
			if (command.includes("git pull")) return "ok";
			if (command.includes("npm install")) throw new Error("install boom");
			return "";
		});

		await updateCommand({ json: true });

		expect(ranCmd("npm install")).toBe(true); // install attempted then swallowed
		expectCleanJsonSuccess();
	});

	it("suppresses the 'hook regeneration failed' line under --json (L198 false arm)", async () => {
		mocks.existsSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) return true;
			if (path === `${CLI_ROOT}/.git`) return true;
			if (path === `${CLI_ROOT}/src/index.ts`) return true;
			if (path === `${CLI_ROOT}/package-lock.json`) return true;
			if (path === `${CLI_ROOT}/node_modules`) return true;
			if (path === "/cwd/.interlinked") return true; // triggers Step 5
			return false;
		});
		mocks.writeHookScript.mockImplementation(() => {
			throw new Error("write failed");
		});

		await updateCommand({ json: true });

		expect(mocks.writeHookScript).toHaveBeenCalledWith("/cwd");
		expectCleanJsonSuccess();
	});
});

// ===========================================
// parsePackageJsonUsed boundary parser (module-private — driven indirectly,
// matching this file's black-box style for every other internal helper).
// ===========================================

describe("update — package.json boundary parser", () => {
	it("P1: extra unrecognised fields (e.g. bin, scripts) do not block resolution", async () => {
		// resolveCliRoot only reads `name`; a real package.json carries many more
		// fields (bin, scripts, dependencies, …) that the parser must ignore
		// rather than choke on.
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) {
				return JSON.stringify({
					name: "interlinked-cli",
					version: "1.2.3",
					bin: { interlinked: "dist/index.js" },
					scripts: { build: "tsup" },
				});
			}
			return "{}";
		});

		await updateCommand({});

		expect(logText()).toContain("Updated to Interlinked CLI v1.2.3");
	});

	it("N1: a package.json that parses to a non-object (e.g. a bare array) is treated as unresolved", async () => {
		// resolveCliRoot's package.json is syntactically valid JSON but not an
		// object — the old `JSON.parse(...) as {...}` cast would have read
		// `.name` as `undefined` off the array too, so this pins the SAME
		// outcome (falls through to the managed-checkout bootstrap) via the
		// parser's isJsonObject guard instead of an unchecked property read.
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) return JSON.stringify(["not", "an", "object"]);
			if (path === `${HOME}/.interlinked/interlinked-cli/package.json`) {
				return JSON.stringify({ name: "interlinked-cli", version: "9.9.9" });
			}
			return "{}";
		});

		await updateCommand({});

		// Fell through to the managed-checkout bootstrap (Repo URL line only
		// prints for a managed checkout) rather than resolving CLI_ROOT.
		expect(logText()).toContain(`Repo URL:  ${INTERLINKED_CLI_REPO_URL}`);
		expect(logText()).toContain("Updated to Interlinked CLI v9.9.9");
	});

	it("N2: getInstalledVersion falls back to 'unknown' when version is present but the wrong type", async () => {
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) {
				return JSON.stringify({ name: "interlinked-cli", version: 20260101 });
			}
			return "{}";
		});

		await updateCommand({});

		expect(logText()).toContain("Updated to Interlinked CLI vunknown");
	});
});

// ===========================================
// getInstalledVersion fallback.
// ===========================================

describe("update — version resolution", () => {
	it("falls back to 'unknown' when package.json cannot be read at the end", async () => {
		// Make the final version read fail (readFileSync throws for that path)
		// while resolveCliRoot's earlier read still succeeds.
		let firstRead = true;
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) {
				if (firstRead) {
					firstRead = false; // resolveCliRoot's read succeeds.
					return JSON.stringify({ name: "interlinked-cli", version: "1.2.3" });
				}
				throw new Error("gone"); // getInstalledVersion read fails.
			}
			return "{}";
		});

		await updateCommand({});

		expect(logText()).toContain("Updated to Interlinked CLI vunknown");
	});

	it("falls back to 'unknown' when package.json has no version field", async () => {
		mocks.readFileSync.mockImplementation((p: unknown) => {
			const path = String(p);
			if (path === `${CLI_ROOT}/package.json`) {
				return JSON.stringify({ name: "interlinked-cli" }); // no version
			}
			return "{}";
		});

		await updateCommand({});

		expect(logText()).toContain("Updated to Interlinked CLI vunknown");
	});
});
