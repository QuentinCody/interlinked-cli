// ===========================================
// interlinked enable — per-client summary, skill install, index/harness bootstrap
// ===========================================
// Split out of enable.ts (2026-09) to keep the parent under the per-file line
// cap. Holds the parts of `enable` that describe or bootstrap ONE client's
// footprint: the dry-run event-count summary, skill installation reporting,
// requested-client parsing/validation, the trigram index build, harness
// autostart, and the post-enable per-client follow-up notes.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../harness/adapters/index.js";
import { TrigramIndex } from "../harness/trigram-index.js";
import { c } from "../lib/formatter.js";
import { type ClientName, CLIENT_TO_RUNNER } from "../lib/settings.js";
import { installSkills } from "../lib/skill-installers.js";
import { harnessStartCommand, isHarnessRunning } from "./harness.js";

export interface ClientSummary {
	label: string;
	eventCountText: string;
}

/** Where each client's hooks land, and what else the install touches. The
 *  COUNT is deliberately absent — see `clientSummary`. */
const CLIENT_DESTINATIONS: Record<ClientName, string> = {
	claude: ".claude/settings.json",
	copilot: ".github/hooks/hooks.json",
	gemini: ".gemini/settings.json",
	codex: ".codex/hooks.json + [features] hooks=true flag",
	cursor: ".cursor/hooks.json",
	opencode: ".opencode/plugins/interlinked.ts",
	pi: ".pi/extensions/interlinked.js",
};

/**
 * Describe what `enable` will install for one client.
 *
 * The event count is COMPUTED from the adapter that performs the install, never
 * written down here. The hardcoded numbers this replaces (claude 13, gemini 8,
 * cursor 15) had drifted from what the adapters actually register (12, 4, 18
 * as of 2026-08-28 — REGISTERED events; the parsers handle more):
 * a dry run promised one thing and the install did another, which is the worst
 * failure mode for a preview flag. Same drift class the repo's own
 * `duplicated_policy_constant` check exists to catch — the cure is one source
 * of truth, so a new event in an adapter updates this line for free.
 */
export function clientSummary(client: ClientName): ClientSummary | null {
	const destination = CLIENT_DESTINATIONS[client];
	if (!destination) return null;
	const adapter = getAdapter(CLIENT_TO_RUNNER[client]);
	if (!adapter) return null;
	const count = adapter.nativeEventNames.length;
	return {
		label: client,
		eventCountText: `${count} event${count === 1 ? "" : "s"} (${destination})`,
	};
}

export function installSkillsForClients(cwd: string, targetClients: ClientName[]): void {
	if (targetClients.length === 0) return;
	const results = installSkills(cwd, targetClients);
	printSkillInstallResults(results);
}

function printSkillInstallResults(results: ReturnType<typeof installSkills>): void {
	const installed = results.filter((r) => r.installed);
	const errors = results.filter((r) => r.error !== undefined);
	if (installed.length === 0) {
		const firstErr = errors[0]?.error;
		if (firstErr) {
			console.log(`\n${c.dim("Interlinked skills: not installed —")} ${c.yellow(firstErr)}`);
		}
		errors.slice(1).forEach((result) => {
			console.log(c.yellow(`  ${result.skill}/${result.client}: ${result.error}`));
		});
		return;
	}
	console.log(
		`\n${c.green("Installed")} Interlinked skills for ${[...new Set(installed.map((r) => r.client))].join(", ")}`,
	);
	console.log(
		c.dim(
			"  Load /enforce plus the interlinked-* skills on demand from your agent",
		),
	);
	errors.forEach((result) => {
		console.log(c.yellow(`  Skill warning (${result.skill}/${result.client}): ${result.error}`));
	});
}

interface ClientSelection {
	requested: ClientName[] | null;
	unknown: string[];
}

function isClientName(value: string): value is ClientName {
	return Object.hasOwn(CLIENT_TO_RUNNER, value);
}

function displayClientId(value: string): string {
	return value.length > 0 ? value : "<empty>";
}

/** Parse the explicit client list before enable performs its first write.
 * Invalid ids must not degrade into a successful-looking partial setup: the
 * old cast accepted arbitrary strings, then created config, installed only the
 * canonical skill cache, started a daemon, and exited 0 with no hooks active. */
export function parseRequestedClients(raw: string | undefined): ClientSelection {
	if (raw === undefined) return { requested: null, unknown: [] };
	const normalized = raw.split(",").map((part) => part.trim().toLowerCase());
	return {
		requested: [...new Set(normalized.filter(isClientName))],
		unknown: normalized.filter((value) => !isClientName(value)).map(displayClientId),
	};
}

export function reportInvalidExplicitValue(
	kind: "sync" | "structure",
	value: string,
	allowed: readonly string[],
): void {
	console.error(
		`${c.red("Error:")} Invalid ${kind} mode ${JSON.stringify(value)}. No files or processes were changed. Must be one of: ${allowed.join(", ")}.`,
	);
	process.exitCode = 1;
}

/** Build the trigram index when absent (2026-08-17) so grep acceleration
 *  works from the first session instead of waiting for a separate
 *  `interlinked index build` nobody was told about. Skips silently when an
 *  index exists (adopt and the daemon keep it fresh incrementally); a build
 *  failure warns and continues — search still works without the index, just
 *  unaccelerated. Runs BEFORE the daemon start so the fresh daemon loads it. */
export function ensureIndexBuilt(cwd: string): void {
	if (existsSync(join(cwd, ".interlinked", "index", "trigram.lookup"))) return;
	try {
		const index = TrigramIndex.build({ cwd });
		index.save(join(cwd, ".interlinked"));
		console.log(
			`\n${c.green("Built")} trigram search index (${index.stats().fileCount} files) — grep acceleration on`,
		);
	} catch (err) {
		console.log(
			`\n${c.yellow("!")} Trigram index build failed (${err instanceof Error ? err.message : String(err)}). Run: ${c.cyan("interlinked index build")}`,
		);
	}
}

export async function startHarnessIfNeeded(cwd: string): Promise<void> {
	if (isHarnessRunning(cwd).running) return;
	const harnessOpts = { daemon: true };
	try {
		await harnessStartCommand(harnessOpts);
	} catch {
		console.log(
			`\n${c.yellow("!")} Failed to start harness. Run: ${c.cyan("interlinked harness start --verbose")}`,
		);
	}
}

export function buildPostEnableNotes(targetClients: readonly ClientName[]): string[] {
	const notes: string[] = [];
	if (targetClients.includes("copilot")) {
		notes.push("Run `/skills reload` or restart Copilot CLI to load the newly installed repository skill.");
	}
	if (targetClients.includes("codex")) {
		notes.push("Restart Codex or open a new Codex session to load updated hooks.");
	}
	if (targetClients.includes("opencode")) {
		notes.push("Restart OpenCode or open a new OpenCode session to load the Interlinked plugin.");
	}
	if (targetClients.includes("pi")) {
		notes.push(
			"Run `/reload` in Pi (or restart it) and trust the Interlinked project extension when prompted.",
		);
	}
	return notes;
}
