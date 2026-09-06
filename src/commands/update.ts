// ===========================================
// Update Command — Self-update the Interlinked CLI
// ===========================================
// Source checkouts pull/build in place. If the running binary is not already
// tied to a source checkout, bootstrap a managed GitHub checkout and link it.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { c } from "../lib/formatter.js";
import { isJsonObject } from "../lib/json-types.js";
import type { SkillRefreshSummary } from "./skill-refresh.js";

export const INTERLINKED_CLI_REPO_URL = "https://github.com/QuentinCody/interlinked-cli.git";

/** package.json, narrowed to the two fields this file actually reads:
 *  `name` (identifies the interlinked-cli checkout while walking up from the
 *  running binary) and `version` (the self-update result line). Replaces two
 *  bare `JSON.parse(...)` results read as `any` with no shape check at all. */
interface PackageJsonUsed {
	name?: string;
	version?: string;
}

function parsePackageJsonUsed(value: unknown): PackageJsonUsed | null {
	if (!isJsonObject(value)) return null;
	const { name, version } = value;
	return {
		...(typeof name === "string" ? { name } : {}),
		...(typeof version === "string" ? { version } : {}),
	};
}

export function getManagedSourceRoot(home = homedir()): string {
	return join(home, ".interlinked", "interlinked-cli");
}

/** Resolve the monorepo root from the running binary's symlink */
function resolveCliRoot(): string | null {
	try {
		// The binary is at cli/dist/index.js — resolve symlinks to find the real path
		const argv1 = process.argv[1];
		if (argv1 === undefined) return null;
		const binPath = realpathSync(argv1);
		// Walk up from dist/index.js to cli/
		let dir = dirname(binPath);
		for (let i = 0; i < 5; i++) {
			if (existsSync(join(dir, "package.json"))) {
				const pkg = parsePackageJsonUsed(JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")));
				if (pkg?.name === "interlinked-cli") return dir;
			}
			dir = dirname(dir);
		}
	} catch (_) {
		/* intentional: best-effort scan for package root, null means not found */
	}
	return null;
}

function run(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, encoding: "utf-8", timeout: 60_000 }).trim();
}

function runFile(file: string, args: string[], cwd: string, timeout = 120_000): string {
	return execFileSync(file, args, { cwd, encoding: "utf-8", timeout }).trim();
}

function fail(opts: { json?: boolean }, message: string): never {
	if (opts.json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(`${c.red("Error:")} ${message}`);
	}
	process.exit(1);
}

export type UpdateOpts = { json?: boolean; force?: boolean };
export type ResolvedRoots = { cliRoot: string; repoRoot: string; managedCheckout: boolean };

/** Injectable seams for `resolveRoots`, defaulted to the real resolvers so
 *  production behavior is unchanged; a test can substitute either to drive
 *  the "cannot resolve CLI install location" guard without touching the
 *  real filesystem/git. */
export interface ResolveRootsDeps {
	resolveCliRoot?: () => string | null;
	ensureManagedSourceCheckout?: (opts: UpdateOpts) => string;
}

/** Locate the source checkout to update, bootstrapping a managed clone if needed. */
export function resolveRoots(opts: UpdateOpts, deps: ResolveRootsDeps = {}): ResolvedRoots {
	const resolveCliRootFn = deps.resolveCliRoot ?? resolveCliRoot;
	const ensureManagedSourceCheckoutFn = deps.ensureManagedSourceCheckout ?? ensureManagedSourceCheckout;
	let cliRoot = resolveCliRootFn();
	let repoRoot = cliRoot ? resolveSourceRepoRoot(cliRoot) : null;
	let managedCheckout = false;
	if (!repoRoot) {
		repoRoot = ensureManagedSourceCheckoutFn(opts);
		cliRoot = repoRoot;
		managedCheckout = true;
	}
	if (!cliRoot) {
		fail(opts, "Cannot resolve CLI install location");
	}
	return { cliRoot, repoRoot, managedCheckout };
}

/** Self-update header: machine envelope in JSON mode, human chrome otherwise. */
function printUpdateHeader(opts: UpdateOpts, roots: ResolvedRoots): void {
	const { cliRoot, repoRoot, managedCheckout } = roots;
	if (opts.json) {
		console.log(
			JSON.stringify({
				cli_root: cliRoot,
				repo_root: repoRoot,
				repo_url: INTERLINKED_CLI_REPO_URL,
				managed_checkout: managedCheckout,
				updating: true,
			}),
		);
		return;
	}
	console.log(`${c.bold("Interlinked CLI — Self-Update")}`);
	console.log(c.dim("────────────────────────────────────────"));
	console.log(`${c.dim("CLI root:")}  ${cliRoot}`);
	console.log(`${c.dim("Repo root:")} ${repoRoot}`);
	if (managedCheckout) console.log(`${c.dim("Repo URL:")}  ${INTERLINKED_CLI_REPO_URL}`);
	console.log();
}

/** Warn (human-only) that a dirty tree blocks the pull without --force. */
function warnDirtyTreeSkippingPull(opts: UpdateOpts): void {
	if (opts.json) return;
	console.log(`${c.yellow("Warning:")} Working tree has uncommitted changes.`);
	console.log(c.dim("Use --force to pull anyway, or commit/stash first."));
	console.log();
	console.log(c.dim("Skipping git pull — rebuilding from current source."));
}

/** Run `git pull --ff-only`, reporting the sha delta. Returns whether HEAD moved. */
function attemptGitPull(opts: UpdateOpts, repoRoot: string, beforeSha: string): boolean {
	if (!opts.json) process.stdout.write("Pulling latest... ");
	try {
		run("git pull --ff-only", repoRoot);
		const afterSha = run("git rev-parse --short HEAD", repoRoot);
		const pulled = beforeSha !== afterSha;
		if (!opts.json) {
			if (pulled) {
				console.log(`${c.green("updated")} ${beforeSha} → ${afterSha}`);
			} else {
				console.log(c.green("already up to date"));
			}
		}
		return pulled;
	} catch {
		if (!opts.json) {
			console.log(c.yellow("skipped (pull failed — rebuilding from current source)"));
		}
		return false;
	}
}

/** Step 1: pull latest when the repo is a clean (or --force) git checkout. */
function runGitPull(opts: UpdateOpts, repoRoot: string): boolean {
	if (!existsSync(join(repoRoot, ".git"))) return false;
	try {
		const status = run("git status --porcelain", repoRoot);
		const branch = run("git rev-parse --abbrev-ref HEAD", repoRoot);
		const beforeSha = run("git rev-parse --short HEAD", repoRoot);

		if (!opts.json) {
			console.log(`${c.dim("Branch:")} ${branch} (${beforeSha})`);
		}

		if (status && !opts.force) {
			warnDirtyTreeSkippingPull(opts);
			return false;
		}
		return attemptGitPull(opts, repoRoot, beforeSha);
	} catch {
		if (!opts.json) console.log(c.dim("Git not available — rebuilding from current source."));
		return false;
	}
}

/** Step 2: install dependencies when HEAD moved or node_modules is missing. */
function installDependencies(opts: UpdateOpts, cliRoot: string, pulled: boolean): void {
	const nodeModules = join(cliRoot, "node_modules");
	if (!pulled && existsSync(nodeModules)) return;
	if (!opts.json) process.stdout.write("Installing dependencies... ");
	try {
		const installCmd = existsSync(join(cliRoot, "package-lock.json"))
			? "npm ci --no-audit --no-fund"
			: "npm install --no-audit --no-fund";
		run(installCmd, cliRoot);
		if (!opts.json) console.log(c.green("done"));
	} catch {
		if (!opts.json) console.log(c.yellow("skipped (install failed)"));
	}
}

/** Step 3: rebuild the CLI. Exits non-zero on build failure (never returns). */
function buildCli(opts: UpdateOpts, cliRoot: string): void {
	if (!opts.json) process.stdout.write("Building... ");
	try {
		run("npm run build", cliRoot);
		if (!opts.json) console.log(c.green("done"));
	} catch (err) {
		if (opts.json) {
			console.log(JSON.stringify({ success: false, error: "Build failed" }));
		} else {
			console.error(`${c.red("Build failed:")}`);
			console.error(String(err));
		}
		process.exit(1);
	}
}

/**
 * Step 4: `npm link` managed checkouts so future invocations use the fresh build.
 * Returns whether linking occurred; exits non-zero if the link fails.
 */
function linkManagedCheckout(opts: UpdateOpts, cliRoot: string, managedCheckout: boolean): boolean {
	if (!managedCheckout) return false;
	if (!opts.json) process.stdout.write("Linking CLI binaries... ");
	try {
		run("npm link", cliRoot);
		if (!opts.json) console.log(c.green("done"));
		return true;
	} catch (err) {
		if (opts.json) {
			console.log(JSON.stringify({ success: false, error: "npm link failed" }));
		} else {
			console.log(c.red("failed"));
			console.error(String(err));
		}
		process.exit(1);
	}
}

/** Step 5: refresh hooks and deployed skills when the current repo is enabled. */
async function refreshLocalInstall(opts: UpdateOpts): Promise<SkillRefreshSummary | null> {
	const cwd = process.cwd();
	if (!existsSync(join(cwd, ".interlinked"))) return null;
	if (!opts.json) process.stdout.write("Refreshing local hooks and skills... ");
	try {
		const { installAllHooks, writeHookScript } = await import("../lib/hooks.js");
		const { detectClients } = await import("../lib/settings.js");
		const { refreshClientSkills } = await import("./skill-refresh.js");
		writeHookScript(cwd);
		const clients = detectClients(cwd)
			.filter((client) => client.exists)
			.map((client) => client.name);
		if (clients.length > 0) installAllHooks(cwd, clients);
		const refresh = refreshClientSkills(cwd, clients);
		if (!opts.json) console.log(c.green("done"));
		if (!opts.json) refresh.summary.warnings.forEach((warning) => console.log(c.yellow(`  ${warning}`)));
		return refresh.summary;
	} catch {
		if (!opts.json) console.log(c.yellow("skipped (local refresh failed)"));
		return null;
	}
}

/** Step 6: emit the final version envelope (JSON) or human "Updated to…" line. */
function printUpdateResult(
	opts: UpdateOpts,
	roots: ResolvedRoots,
	state: { pulled: boolean; linked: boolean; skills: SkillRefreshSummary | null },
): void {
	const newVersion = getInstalledVersion(roots.cliRoot);
	if (opts.json) {
		console.log(
			JSON.stringify({
				success: true,
				version: newVersion,
				pulled: state.pulled,
				linked: state.linked,
				skills: state.skills,
				managed_checkout: roots.managedCheckout,
				repo_root: roots.repoRoot,
			}),
		);
	} else {
		console.log();
		console.log(`${c.green("Updated")} to Interlinked CLI v${newVersion}`);
	}
}

export async function updateCommand(opts: { json?: boolean; force?: boolean }): Promise<void> {
	const roots = resolveRoots(opts);

	printUpdateHeader(opts, roots);

	// Step 1: Check for git changes.
	const pulled = runGitPull(opts, roots.repoRoot);

	// Step 2: Install dependencies if needed.
	installDependencies(opts, roots.cliRoot, pulled);

	// Step 3: Build.
	buildCli(opts, roots.cliRoot);

	// Step 4: Link managed source checkouts so future `interlinked` invocations
	// use the freshly-built GitHub checkout.
	const linked = linkManagedCheckout(opts, roots.cliRoot, roots.managedCheckout);

	// Step 5: Refresh hooks and skills in the current directory when enabled.
	const skills = await refreshLocalInstall(opts);

	// Step 6: Show new version.
	printUpdateResult(opts, roots, { pulled, linked, skills });
}

function getInstalledVersion(cliRoot: string): string {
	try {
		const pkg = parsePackageJsonUsed(JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf-8")));
		return pkg?.version || "unknown";
	} catch {
		return "unknown";
	}
}

function ensureManagedSourceCheckout(opts: { json?: boolean; force?: boolean }): string {
	const repoRoot = getManagedSourceRoot();
	const parent = dirname(repoRoot);
	mkdirSync(parent, { recursive: true });

	if (!existsSync(repoRoot)) {
		if (!opts.json) {
			console.log(`${c.bold("Interlinked CLI — GitHub Checkout")}`);
			console.log(c.dim("────────────────────────────────────────"));
			console.log(`${c.dim("Repo URL:")}  ${INTERLINKED_CLI_REPO_URL}`);
			console.log(`${c.dim("Target:")}    ${repoRoot}`);
			process.stdout.write("Cloning source... ");
		}
		try {
			runFile("git", ["clone", INTERLINKED_CLI_REPO_URL, repoRoot], parent);
			if (!opts.json) console.log(c.green("done"));
		} catch (err) {
			if (!opts.json) console.log(c.red("failed"));
			fail(opts, `Failed to clone ${INTERLINKED_CLI_REPO_URL}: ${String(err)}`);
		}
		return repoRoot;
	}

	if (!resolveSourceRepoRoot(repoRoot)) {
		fail(
			opts,
			`Managed checkout path exists but is not an interlinked-cli source checkout: ${repoRoot}`,
		);
	}

	try {
		runFile("git", ["remote", "set-url", "origin", INTERLINKED_CLI_REPO_URL], repoRoot);
	} catch {
		/* non-fatal: pull below will surface any real git problem */
	}

	return repoRoot;
}

export function resolveSourceRepoRoot(cliRoot: string): string | null {
	const candidates = [cliRoot, dirname(cliRoot)];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, ".git")) && existsSync(join(cliRoot, "src", "index.ts"))) {
			return candidate;
		}
	}
	return null;
}
