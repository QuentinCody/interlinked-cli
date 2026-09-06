// ===========================================
// reload — the one-command dogfood loop
// ===========================================
// `interlinked reload` collapses `cd <cli-checkout> && npm run build &&
// interlinked enable && interlinked harness restart` into one command that
// works from ANY guarded repo and — unlike that chain — reports DELTAS:
// whether the built CLI actually changed (content hash over the two live
// artifacts), whether the current repo's hook script changed, and whether the
// daemon therefore needed a restart. Born from operator feedback (2026-07-06):
// the three-command chain built the WRONG project when run outside the CLI
// checkout, and its output never said whether anything was updated.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installAllHooks, writeHookScript } from "../lib/hooks.js";
import { isJsonObject } from "../lib/json-types.js";
import { detectClients } from "../lib/settings.js";
import { harnessRestartCommand } from "./harness.js";
import { refreshClientSkills } from "./skill-refresh.js";

/** Walk up from `startDir` to the interlinked-cli package root (the linked
 *  source checkout the `interlinked` binary runs from). Null when not found —
 *  e.g. a hypothetical registry install with no source tree. */
export function findCliRoot(startDir?: string): string | null {
	let dir = resolve(startDir ?? dirname(fileURLToPath(import.meta.url)));
	for (let hops = 0; hops < 12; hops++) {
		if (packageNameAt(join(dir, "package.json")) === "interlinked-cli") return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/** The manifest's name field, or null for a missing/malformed manifest (a
 *  mid-edit package.json must read as "not the CLI root", never throw). */
function packageNameAt(pkgPath: string): string | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
		if (!isJsonObject(parsed)) return null;
		return typeof parsed.name === "string" ? parsed.name : null;
	} catch {
		return null;
	}
}

/** Content identity of the built CLI: a short hash over the two artifacts the
 *  live system actually executes (daemon + hook entry). "absent" ⇒ never built. */
export function distBuildHash(cliRoot: string): string {
	const artifacts = [join(cliRoot, "dist", "harness", "server.js"), join(cliRoot, "dist", "hook-entry.js")];
	const h = createHash("sha256");
	let found = false;
	for (const p of artifacts) {
		if (!existsSync(p)) continue;
		found = true;
		h.update(readFileSync(p));
	}
	return found ? h.digest("hex").slice(0, 8) : "absent";
}

/** The daemon serves the OLD build until restarted; the hook script is read
 *  per-event but its generated content also embeds build-dependent chunks.
 *  `daemonStale` covers out-of-band builds: dist changed in some EARLIER run,
 *  so this run's before/after delta reads "unchanged" while the running
 *  daemon still predates it (operator-reported trust gap, 2026-07-06). */
export function shouldRestartDaemon(args: {
	buildChanged: boolean;
	hookChanged: boolean;
	force: boolean;
	daemonStale?: boolean;
}): boolean {
	return args.buildChanged || args.hookChanged || args.force || args.daemonStale === true;
}

/** Stale ⇔ the running daemon started before the current server artifact was
 *  written. Unknowable state (no pidfile, unreadable ps, missing artifact)
 *  reads as stale — a spurious restart is cheap; trusting a stale daemon is
 *  exactly the failure this exists to prevent. */
export function daemonIsStale(args: {
	serverMtimeMs: number | null;
	daemonStartMs: number | null;
}): boolean {
	if (args.serverMtimeMs === null || args.daemonStartMs === null) return true;
	return args.daemonStartMs < args.serverMtimeMs;
}

/** Start time (epoch ms) of the repo's running daemon, from its pidfile +
 *  `ps -o lstart=`. Null when there is no readable running daemon. */
function runningDaemonStartMs(cwd: string): number | null {
	try {
		const pid = Number.parseInt(
			readFileSync(join(cwd, ".interlinked", "harness.pid"), "utf-8"),
			10,
		);
		if (!Number.isFinite(pid) || pid <= 0) return null;
		const lstart = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf-8",
		}).trim();
		if (!lstart) return null;
		const parsed = Date.parse(lstart);
		return Number.isFinite(parsed) ? parsed : null;
	} catch {
		return null; // no pidfile / process gone / ps unavailable
	}
}

function serverArtifactMtimeMs(cliRoot: string): number | null {
	try {
		return statSync(join(cliRoot, "dist", "harness", "server.js")).mtimeMs;
	} catch {
		return null;
	}
}

/** Run `fn` with stdout (console.log) swallowed, always restoring the original.
 *  `reload --json` must emit its single JSON blob as the ONLY thing on stdout,
 *  but the daemon restart it triggers writes human "Harness started (PID …)"
 *  lines through console.log — which would interleave with, and corrupt, that
 *  JSON. Only stdout is muted; stderr (a restart FAILURE, via outputError) still
 *  surfaces and still sets a non-zero exit. */
async function withStdoutSuppressed<T>(fn: () => Promise<T>): Promise<T> {
	const original = console.log;
	console.log = (): void => {};
	try {
		return await fn();
	} finally {
		console.log = original;
	}
}

/** Step 3 — the restart decision + delta-honest report line. Restarts when
 *  something the daemon executes changed, when --force, or when the RUNNING
 *  daemon predates the current build (out-of-band build: this run's delta
 *  reads "unchanged" but the daemon is still stale). Returns whether it
 *  restarted. */
async function daemonStep(args: {
	cwd: string;
	cliRoot: string;
	after: string;
	buildChanged: boolean;
	hookChanged: boolean;
	force: boolean;
	/** reload's own output mode. In json mode the restart's human stdout is
	 *  swallowed so reload's JSON blob is the only thing on stdout. */
	json?: boolean;
	say: (line: string) => void;
}): Promise<boolean> {
	const daemonStale = daemonIsStale({
		serverMtimeMs: serverArtifactMtimeMs(args.cliRoot),
		daemonStartMs: runningDaemonStartMs(args.cwd),
	});
	const restart = shouldRestartDaemon({
		buildChanged: args.buildChanged,
		hookChanged: args.hookChanged,
		force: args.force,
		daemonStale,
	});
	if (!restart) {
		args.say(
			"  Daemon:      already current (running daemon postdates the build) — not restarted",
		);
		return false;
	}
	const why =
		daemonStale && !args.buildChanged && !args.hookChanged && !args.force
			? "was STALE (started before the current build) — "
			: "";
	// The restart runs in human mode (json:false) so the daemon-ready spinner
	// still shows in a normal reload; in reload's OWN json mode we swallow its
	// stdout so only reload's JSON blob reaches stdout (restart failures still
	// surface on stderr). daemon.restarted in the JSON reports the outcome.
	if (args.json) {
		await withStdoutSuppressed(() => harnessRestartCommand({ json: false }));
	} else {
		await harnessRestartCommand({ json: false });
	}
	args.say(`  Daemon:      ${why}restarted on build ${args.after}`);
	return true;
}

function hashFileSafe(path: string): string {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 8);
	} catch {
		return "absent";
	}
}

/** Human-readable diagnostics from a rejected `execFileSync(…, {stdio:"pipe"})`.
 *  The thrown error carries the child's captured stdout/stderr (Buffers under
 *  "pipe"), where tsup/tsc write the actual compiler errors; fall back to the
 *  error message when the child produced no captured output. Keeps a failed
 *  `npm run build` from surfacing as an opaque Node stack. */
function buildErrorText(err: unknown): string {
	const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
	const captured = [e.stdout, e.stderr]
		.map((stream) => (stream == null ? "" : String(stream)).trim())
		.filter((text) => text.length > 0);
	return captured.length > 0 ? captured.join("\n") : (e.message ?? String(err));
}

export interface ReloadOptions {
	cwd?: string;
	json?: boolean;
	force?: boolean;
	/** commander maps --no-build to build:false. */
	build?: boolean;
}

/** `resolveCliRoot` defaults to the real `findCliRoot` lookup — injectable
 *  only so a unit test can force the "no checkout found" branch without
 *  fabricating a package.json above the real repo (that branch has no other
 *  DI seam; see reload.test.ts). Every real caller omits it and gets the
 *  original behavior unchanged. */
export async function reloadCommand(
	opts: ReloadOptions,
	resolveCliRoot: () => string | null = findCliRoot,
): Promise<void> {
	const cwd = resolve(opts.cwd ?? process.cwd());
	const json = opts.json === true;
	const say = (line: string): void => {
		if (!json) console.log(line);
	};

	const cliRoot = resolveCliRoot();
	if (!cliRoot) {
		console.error(
			"reload: could not locate the interlinked-cli source checkout from the running binary — rebuild manually in the checkout, then run `interlinked enable && interlinked harness restart`.",
		);
		process.exitCode = 1;
		return;
	}

	// 1. Rebuild the CLI in ITS OWN checkout (never the current repo's build).
	const before = distBuildHash(cliRoot);
	let buildMs = 0;
	if (opts.build !== false) {
		const t0 = Date.now();
		try {
			execFileSync("npm", ["run", "build"], { cwd: cliRoot, stdio: "pipe" });
		} catch (err) {
			// A failed build throws with the tool's captured stdout/stderr — surface
			// the real compiler diagnostics + a non-zero exit instead of an opaque
			// Node stack, and stop (a stale/absent dist must not be wired in). Goes
			// to stderr so it never corrupts a --json run's stdout.
			console.error(
				`reload: CLI build failed in ${cliRoot}. Fix the errors below, then re-run.\n${buildErrorText(err)}`,
			);
			process.exitCode = 1;
			return;
		}
		buildMs = Date.now() - t0;
	}
	const after = distBuildHash(cliRoot);
	const buildChanged = before !== after;
	say(
		opts.build === false
			? `  CLI build:   skipped (--no-build) — dist ${after}`
			: `  CLI build:   ${buildChanged ? `CHANGED ${before} → ${after}` : `unchanged (${after})`} in ${(buildMs / 1000).toFixed(1)}s`,
	);

	// 2. Refresh the current repo's hook script + client wiring, delta-reported.
	const hookPath = join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs");
	const hookBefore = hashFileSafe(hookPath);
	writeHookScript(cwd);
	const hookAfter = hashFileSafe(hookPath);
	const hookChanged = hookBefore !== hookAfter;
	const clients = detectClients(cwd)
		.filter((c) => c.exists)
		.map((c) => c.name);
	if (clients.length > 0) installAllHooks(cwd, clients);
	const skillRefresh = refreshClientSkills(cwd, clients);
	say(
		`  Hook script: ${hookChanged ? `CHANGED ${hookBefore} → ${hookAfter}` : `unchanged (${hookAfter})`}${clients.length > 0 ? ` — wiring refreshed for ${clients.join(", ")}` : ""}`,
	);
	skillRefresh.outputLines.forEach(say);

	// TODO(statusline-refresh): `reload` should also regenerate the installed
	// statusline script. Found 2026-08-10: the installed copy had drifted two
	// weeks behind source, so segments shipped since (the "N blocked / N
	// caught" work segment, the caps segment) never rendered even though the
	// snapshot carried their data — a stale renderer looks exactly like an
	// absent feature. Deferred here because `writeStatuslineScript` writes
	// under the real HOME and this command's --json integrity tests sandbox it;
	// wiring it needs that function to create its own directory first. Manual
	// regeneration meanwhile: scratch/refresh-statusline.mts.

	const restart = await daemonStep({
		cwd,
		cliRoot,
		after,
		buildChanged,
		hookChanged,
		force: opts.force === true,
		json,
		say,
	});

	if (json) {
		console.log(
			JSON.stringify(
				{
					cli_root: cliRoot,
					build: { before, after, changed: buildChanged, ms: buildMs, skipped: opts.build === false },
					hook_script: { before: hookBefore, after: hookAfter, changed: hookChanged },
					clients,
					skills: skillRefresh.summary,
					daemon: { restarted: restart },
				},
				null,
				2,
			),
		);
	}
}
