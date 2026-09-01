// ===========================================
// interlinked disable — stand the harness down for this project
// ===========================================
// Default: a soft, RECORDED stand-down (the consent primitive). Hooks and
// config stay; a marker tells every layer (cold gate, self-heal) to stand down
// here, the choice is written to an audit log, and the daemon is stopped so
// guarding actually ceases now. Re-arm with `interlinked enable`.
//
// `--uninstall`: the destructive teardown — remove hooks from every client,
// delete the hook script + /enforce skill, and (unless --keep-config) delete
// the .interlinked/ directory. This was the historical behavior of `disable`;
// it now lives behind an explicit flag so the bare command is non-destructive.

import { parseDuration } from "../lib/activity-utils.js";
import { getConfigDir, isConfigured, readLocalConfig } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import { writeGuardDisable } from "../lib/guard-state.js";
import { deleteConfigDir, deleteHookScript, uninstallAllHooks } from "../lib/hooks.js";
import type { ClientName } from "../lib/settings.js";
import { uninstallSkills } from "../lib/skill-installers.js";
import { harnessStopCommand, isHarnessRunning } from "./harness.js";

interface DisableOptions {
	/** Destructive teardown (remove hooks + delete config) instead of a stand-down. */
	uninstall?: boolean;
	/** With --uninstall: preserve .interlinked/ config files. */
	keepConfig?: boolean;
	/** Write a committed (team-shared) marker instead of a personal one. */
	team?: boolean;
	/** Justification, recorded on the marker + audit log. */
	reason?: string;
	/** Auto-expire the stand-down (e.g. "30m", "2h", "1d"). */
	until?: string;
	/** Who is standing it down (defaults to agent name / $USER). */
	by?: string;
}

const ALL_CLIENTS: ClientName[] = [
	"claude",
	"copilot",
	"gemini",
	"codex",
	"cursor",
	"opencode",
	"opencode2",
	"pi",
];

export async function disableCommand(options: DisableOptions): Promise<void> {
	if (options.uninstall) {
		await uninstallEverything(process.cwd(), options);
		return;
	}
	await standDown(process.cwd(), options);
}

// ── Soft stand-down (default) ────────────────────────────────────────────────

async function standDown(cwd: string, options: DisableOptions): Promise<void> {
	console.log(c.bold("Interlinked CLI — Disable (stand down)"));
	console.log(c.dim("─".repeat(40)));

	if (!isConfigured(cwd)) {
		console.log(`\n${c.yellow("Not enabled here.")} No .interlinked/ config found.`);
		console.log(
			c.dim(
				"Run `interlinked enable` first, or `interlinked disable --uninstall` to remove stray hooks.",
			),
		);
		return;
	}

	const interlinkedDir = getConfigDir(cwd);
	const team = options.team === true;
	const expiresAt = resolveExpiry(options.until);
	const record = writeGuardDisable(
		interlinkedDir,
		{
			by: resolveActor(cwd, options.by),
			...(options.reason !== undefined ? { reason: options.reason } : {}),
			...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
		},
		team,
	);

	const markerFile = team ? "guard-disabled.json" : "guard-disabled.local.json";
	// The marker is the recorded, auditable consent — it is now written. Whether
	// guarding actually STOPS depends on the daemon being down (below), so report
	// the recording as fact and the effective state separately.
	console.log(`\n${c.green("Stand-down recorded")} (${team ? "team" : "personal"}).`);
	console.log(`  ${c.dim("Marker:")}  ${interlinkedDir.replace(`${cwd}/`, "")}/${markerFile}`);
	if (record.reason) console.log(`  ${c.dim("Reason:")}  ${record.reason}`);
	console.log(`  ${c.dim("By:")}      ${record.by ?? "unknown"}`);
	if (record.expires_at) console.log(`  ${c.dim("Until:")}   ${record.expires_at}`);
	if (team) {
		console.log(
			c.dim("  Committed marker — it shows up in your PR diff, so the stand-down is reviewable."),
		);
	}

	// Stop the running daemon so guarding ceases now. The LIVE daemon does NOT
	// consult the marker — only the cold/hook gates honor it, once it is down — so
	// the stand-down is NOT in effect until the daemon is confirmed stopped. Never
	// claim success while it survives (finding 2026-06, round 8): a daemon that
	// ignored SIGTERM keeps guarding despite the recorded disable, and the
	// non-zero exit lets scripts detect the incomplete stand-down.
	await harnessStopCommand({});
	const stillGuarding = isHarnessRunning(cwd).running;
	process.exitCode = stillGuarding ? 1 : 0;
	console.log(
		stillGuarding
			? `\n${c.red("Not fully stood down.")} The harness daemon is still running and will keep ` +
					"guarding this project — the live daemon does not read the stand-down marker.\n" +
					`  ${c.dim("Finish the stand-down by stopping it:")} ${c.cyan("interlinked harness stop")}`
			: `\n${c.green("Stood down")} — the harness will not guard this project.\n` +
					`${c.dim("Re-arm with")} ${c.cyan("interlinked enable")}${c.dim(".")}`,
	);
}

function resolveActor(cwd: string, byFlag: string | undefined): string {
	return byFlag ?? readLocalConfig(cwd)?.agent_name ?? process.env.USER ?? "unknown";
}

function resolveExpiry(until: string | undefined): string | undefined {
	if (!until) return undefined;
	try {
		return new Date(Date.now() + parseDuration(until)).toISOString();
	} catch (err) {
		console.log(`\n${c.red("Error:")} ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

// ── Destructive teardown (--uninstall) ───────────────────────────────────────

function reportHookRemovalResults(results: ReturnType<typeof uninstallAllHooks>): {
	removedCount: number;
	failed: boolean;
} {
	let removedCount = 0;
	let failed = false;
	for (const result of results) {
		if (result.events.length > 0) {
			console.log(`  ${c.red("-")} ${c.bold(result.client)} — removed ${result.events.length} hook event(s)`);
			removedCount++;
		} else if (result.error) {
			console.log(`  ${c.red("x")} ${c.bold(result.client)} — ${c.red(result.error)}`);
			failed = true;
		} else {
			console.log(`  ${c.dim("-")} ${c.bold(result.client)} — no hooks found`);
		}
	}
	return { removedCount, failed };
}

async function uninstallEverything(cwd: string, options: DisableOptions): Promise<void> {
	console.log(c.bold("Interlinked CLI — Disable (uninstall)"));
	console.log(c.dim("─".repeat(40)));

	if (!isConfigured(cwd)) {
		console.log(`\n${c.dim("Not enabled.")} No .interlinked/ config found.`);
		console.log(c.dim("Checking for hooks to remove anyway...\n"));
	}

	console.log(c.bold("Removing hooks:"));
	const results = uninstallAllHooks(cwd, ALL_CLIENTS);
	const { removedCount, failed: uninstallFailed } = reportHookRemovalResults(results);

	if (deleteHookScript(cwd)) console.log(`\n${c.red("Deleted")} hook script`);
	if (uninstallSkills(cwd, ALL_CLIENTS)) {
		console.log(`${c.red("Removed")} Interlinked skills from ${ALL_CLIENTS.join(", ")}`);
	}

	if (options.keepConfig || uninstallFailed) {
		const reason = uninstallFailed
			? "because at least one hook could not be safely removed"
			: "(--keep-config)";
		console.log(`\n${c.dim("Kept")} .interlinked/ config ${reason}`);
	} else {
		const configDir = getConfigDir(cwd);
		if (deleteConfigDir(cwd)) {
			console.log(`\n${c.red("Deleted")} ${configDir.replace(`${cwd}/`, "")}/`);
		}
	}

	if (removedCount > 0) {
		console.log(`\n${c.green("Done.")} Removed hooks from ${removedCount} client(s).`);
	} else {
		console.log(`\n${c.dim("Done.")} No hooks were found to remove.`);
	}
	if (uninstallFailed) {
		process.exitCode = 1;
		console.log(c.yellow("Some hooks remain active; resolve the errors above, then run disable --uninstall again."));
		return;
	}
	console.log(c.dim("Agent activity will no longer be captured."));
	if (options.keepConfig) {
		console.log(c.dim("Config preserved. Run 'interlinked enable' to re-install hooks."));
	} else {
		console.log(c.dim("Run 'interlinked enable' to re-enable."));
	}
}
