// ===========================================
// interlinked enable — Install hooks + create .interlinked/ config
// ===========================================
// Sets up the .interlinked/ directory, writes the hook script,
// installs hooks into detected AI coding clients, and manages
// .gitignore entries. Supports --dry-run for preview.

import {
	getConfigDir,
	hasLegacyConfig,
	initConfig,
	isConfigured,
	migrateLegacyConfig,
	resolveConfig,
	updateLocalConfig,
} from "../lib/config.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../harness/adapters/index.js";
import { TrigramIndex } from "../harness/trigram-index.js";
import { type StructureMode, VALID_MODES } from "../harness/structure/types.js";
import { c } from "../lib/formatter.js";
import { clearGuardDisable } from "../lib/guard-state.js";
import {
	detectHookManagers,
	ensureGitignore,
	getHookScriptPath,
	installAllHooks,
	installStatusLine,
	writeHookScript,
} from "../lib/hooks.js";
import { type ClientName, CLIENT_TO_RUNNER, detectClients } from "../lib/settings.js";
import { installSkills } from "../lib/skill-installers.js";
import { harnessStartCommand, isHarnessRunning } from "./harness.js";

interface EnableOptions {
	server?: string | undefined;
	agent?: string | undefined;
	clients?: string | undefined;
	syncMode?: string | undefined;
	dataDir?: string | undefined;
	dryRun?: boolean | undefined;
	structure?: string | undefined;
}

const VALID_SYNC_MODES = ["realtime", "local", "manual"] as const;
type SyncMode = (typeof VALID_SYNC_MODES)[number];

// Clients that ship a `statusLine.command` hook. Codex CLI does not document
// a statusLine equivalent (as of 2026-04); revisit when one lands.
const STATUS_LINE_CLIENTS: readonly ClientName[] = ["claude", "copilot"] as const;

// All known clients in canonical detection order. Driver for "not detected"
// hints + the dry-run printer; keep in sync with the registry in
// `src/lib/hooks.ts` and `CLIENT_CONFIGS` in `src/lib/settings.ts`.
const ALL_CLIENTS: readonly ClientName[] = [
	"claude",
	"copilot",
	"gemini",
	"codex",
	"cursor",
	"opencode",
	"opencode2",
	"pi",
] as const;

interface ClientSummary {
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
	opencode2: ".opencode/plugins/interlinked-opencode2.ts",
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
function clientSummary(client: ClientName): ClientSummary | null {
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

export async function enableCommand(options: EnableOptions): Promise<void> {
	const clientSelection = parseRequestedClients(options.clients);
	if (clientSelection.unknown.length > 0) {
		reportUnknownClients(clientSelection.unknown);
		return;
	}
	if (options.syncMode !== undefined && !isSyncMode(options.syncMode)) {
		reportInvalidExplicitValue("sync", options.syncMode, VALID_SYNC_MODES);
		return;
	}
	if (options.structure !== undefined && !isStructureMode(options.structure)) {
		reportInvalidExplicitValue("structure", options.structure, VALID_MODES);
		return;
	}
	const cwd = process.cwd();
	const requestedClients = clientSelection.requested;

	if (options.dryRun) {
		printDryRun(cwd, options, requestedClients);
		return;
	}

	console.log(c.bold("Interlinked CLI — Enable Hook Management"));
	console.log(c.dim("─".repeat(40)));

	announceConfigState(cwd);
	maybeMigrateLegacyConfig(cwd);
	ensureConfigPresent(cwd, options.server);
	// Re-arm: `interlinked enable` clears any stand-down marker so the guard
	// guards again (symmetric with `interlinked disable`).
	clearGuardDisable(getConfigDir(cwd));
	applyOptionFlags(cwd, options);
	announceHookManagers(cwd);

	const hookScriptPath = writeHookScript(cwd);
	const relativeHookPath = hookScriptPath.replace(`${cwd}/`, "");
	console.log(`\n${c.green("Wrote")} hook script: ${c.dim(relativeHookPath)}`);

	const detectedNames = detectClients(cwd)
		.filter((d) => d.exists)
		.map((d) => d.name);
	const targetClients = resolveTargetClients(requestedClients, detectedNames);

	console.log(`\n${c.bold("Installing hooks:")}`);
	const results = installAllHooks(cwd, targetClients);
	const installedCount = printInstallResults(results, detectedNames);

	if (ensureGitignore(cwd)) {
		console.log(`\n${c.green("Updated")} .gitignore with Interlinked CLI local paths`);
	}

	configureStatusLine(targetClients);
	installSkillsForClients(cwd, targetClients);
	ensureIndexBuilt(cwd);
	await startHarnessIfNeeded(cwd);
	noteUndetectedClients(detectedNames, targetClients, requestedClients);
	await maybeScaffoldStructure(options.structure);
	printSummary(cwd, relativeHookPath, installedCount, targetClients);
}

function installSkillsForClients(cwd: string, targetClients: ClientName[]): void {
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
function parseRequestedClients(raw: string | undefined): ClientSelection {
	if (raw === undefined) return { requested: null, unknown: [] };
	const normalized = raw.split(",").map((part) => part.trim().toLowerCase());
	return {
		requested: [...new Set(normalized.filter(isClientName))],
		unknown: normalized.filter((value) => !isClientName(value)).map(displayClientId),
	};
}

function reportUnknownClients(unknown: string[]): void {
	const noun = unknown.length === 1 ? "client" : "clients";
	console.error(
		`${c.red("Error:")} Unknown ${noun}: ${unknown.join(", ")}. No files or processes were changed. Supported clients: ${ALL_CLIENTS.join(",")}.`,
	);
	process.exitCode = 1;
}

function isSyncMode(value: string): value is SyncMode {
	return VALID_SYNC_MODES.some((mode) => mode === value);
}

function reportInvalidExplicitValue(
	kind: "sync" | "structure",
	value: string,
	allowed: readonly string[],
): void {
	console.error(
		`${c.red("Error:")} Invalid ${kind} mode ${JSON.stringify(value)}. No files or processes were changed. Must be one of: ${allowed.join(", ")}.`,
	);
	process.exitCode = 1;
}

function isStructureMode(value: string): value is StructureMode {
	return VALID_MODES.some((mode) => mode === value);
}

function announceConfigState(cwd: string): void {
	if (!isConfigured(cwd)) return;
	console.log(`\n${c.yellow("Already enabled.")} Config exists at ${c.dim(getConfigDir(cwd))}`);
	console.log(c.dim("Updating hooks and config..."));
}

function maybeMigrateLegacyConfig(cwd: string): void {
	if (!hasLegacyConfig(cwd)) return;
	console.log(`\n${c.yellow("Legacy config detected:")} .claude/interlinked-session.json`);
	const migrated = migrateLegacyConfig(cwd);
	if (migrated) {
		console.log(`  ${c.green("Migrated")} to .interlinked/config.json + config.local.json`);
	} else {
		console.log(`  ${c.dim("Migration skipped (could not read legacy config)")}`);
	}
}

function ensureConfigPresent(cwd: string, serverFlag: string | undefined): void {
	if (!isConfigured(cwd)) {
		initConfig(serverFlag ? { serverUrl: serverFlag } : {}, cwd);
		console.log(`\n${c.green("Created")} .interlinked/config.json`);
		return;
	}
	if (!serverFlag) return;
	const config = resolveConfig(cwd);
	if (config.server_url === serverFlag) return;
	initConfig({ serverUrl: serverFlag }, cwd);
	console.log(`\n${c.green("Updated")} Server URL to ${c.cyan(serverFlag)}`);
}

function applyOptionFlags(cwd: string, options: EnableOptions): void {
	if (options.agent) {
		updateLocalConfig({ agent_name: options.agent }, cwd);
		console.log(`  ${c.green("Set")} agent name: ${c.cyan(options.agent)}`);
	}
	if (options.syncMode && isSyncMode(options.syncMode)) {
		updateLocalConfig({ sync_mode: options.syncMode }, cwd);
		console.log(`  ${c.green("Set")} sync mode: ${c.cyan(options.syncMode)}`);
	}
	if (options.dataDir) {
		updateLocalConfig({ data_dir: options.dataDir }, cwd);
		console.log(`  ${c.green("Set")} data dir: ${c.cyan(options.dataDir)}`);
	}
}

function announceHookManagers(cwd: string): void {
	const managers = detectHookManagers(cwd);
	for (const mgr of managers) {
		console.log(
			`\n${c.yellow("Detected")} ${c.bold(mgr.name)} at ${c.dim(mgr.detected_at)}. Interlinked CLI hooks will coexist but check for conflicts.`,
		);
	}
}

function resolveTargetClients(
	requested: ClientName[] | null,
	detected: ClientName[],
): ClientName[] {
	if (requested) return requested;
	if (detected.length > 0) return detected;
	return ["claude"];
}

interface InstallResultLike {
	client: ClientName;
	installed: boolean;
	events: string[];
	error?: string;
}

function printInstallResults(results: InstallResultLike[], detected: ClientName[]): number {
	for (const result of results) {
		if (result.installed) {
			console.log(
				`  ${c.green("+")} ${c.bold(result.client)} — ${result.events.length} event(s): ${c.dim(result.events.join(", "))}`,
			);
		} else if (result.error) {
			console.log(`  ${c.red("x")} ${c.bold(result.client)} — ${c.red(result.error)}`);
		} else {
			console.log(`  ${c.dim("-")} ${c.bold(result.client)} — no changes needed`);
		}
	}
	const installedCount = results.filter((r) => r.installed).length;
	if (installedCount === 0) {
		console.log(`\n${c.yellow("Warning:")} No hooks were installed.`);
		if (detected.length === 0) {
			console.log(
				c.dim(
					"  No client directories (.claude/, .github/hooks/, .gemini/, .codex/, .cursor/, .opencode/, .pi/) found.",
				),
			);
			console.log(
				c.dim(
					"  Use --clients claude,copilot,gemini,codex,cursor,opencode,opencode2,pi to force installation.",
				),
			);
		}
	}
	return installedCount;
}

function configureStatusLine(targetClients: ClientName[]): void {
	const statusLineClients = targetClients.filter((client) =>
		STATUS_LINE_CLIENTS.includes(client),
	);
	if (statusLineClients.length === 0) return;
	const statusLinePath = installStatusLine(statusLineClients);
	if (statusLinePath) {
		console.log(
			`\n${c.green("Configured")} status line for ${statusLineClients.join(", ")}: ${c.dim(statusLinePath)}`,
		);
	}
}

/** Build the trigram index when absent (2026-08-17) so grep acceleration
 *  works from the first session instead of waiting for a separate
 *  `interlinked index build` nobody was told about. Skips silently when an
 *  index exists (adopt and the daemon keep it fresh incrementally); a build
 *  failure warns and continues — search still works without the index, just
 *  unaccelerated. Runs BEFORE the daemon start so the fresh daemon loads it. */
function ensureIndexBuilt(cwd: string): void {
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

async function startHarnessIfNeeded(cwd: string): Promise<void> {
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

function noteUndetectedClients(
	detected: ClientName[],
	target: ClientName[],
	requested: ClientName[] | null,
): void {
	if (requested) return;
	const undetected = ALL_CLIENTS.filter(
		(name) => !detected.includes(name) && !target.includes(name),
	);
	if (undetected.length === 0) return;
	console.log(
		`\n${c.dim("Not detected:")} ${undetected.join(", ")} ${c.dim("(add with --clients)")}`,
	);
}

async function maybeScaffoldStructure(mode: string | undefined): Promise<void> {
	if (!mode || !isStructureMode(mode)) return;
	const structureOpts = { mode, write: true };
	try {
		const { structureInitCommand } = await import("./structure.js");
		await structureInitCommand(structureOpts);
	} catch (err) {
		console.log(
			`\n${c.yellow("!")} Structure scaffolding failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function printSummary(
	cwd: string,
	relativeHookPath: string,
	installedCount: number,
	targetClients: ClientName[],
): void {
	const config = resolveConfig(cwd);
	console.log(`\n${c.bold("Configuration:")}`);
	console.log(`  ${c.dim("Server:")}    ${config.server_url}`);
	console.log(`  ${c.dim("Config:")}    ${getConfigDir(cwd)}/`);
	console.log(`  ${c.dim("Hook:")}      ${relativeHookPath}`);
	if (config.agent_name) {
		console.log(`  ${c.dim("Agent:")}     ${config.agent_name}`);
	}
	console.log(`  ${c.dim("Sync:")}      ${config.sync_mode}`);

	if (config.access_token) {
		console.log(`  ${c.dim("Auth:")}      ${c.green("Authenticated")}`);
	} else {
		console.log(
			`  ${c.dim("Auth:")}      ${c.yellow("Not logged in")} — run ${c.cyan("interlinked login")}`,
		);
	}

	if (installedCount > 0) {
		console.log(
			`\n${c.green("Hooks are active.")} Agent activity is logged to ${c.cyan(".interlinked/activity.jsonl")}.`,
		);
		for (const note of buildPostEnableNotes(targetClients)) {
			console.log(`  ${c.dim(note)}`);
		}
	} else {
		console.log(
			`\n${c.yellow("Hooks are not active.")} No hook entries were installed. Re-run with ${c.cyan("--clients claude,copilot,gemini,codex,cursor,opencode,opencode2,pi")} or check client settings paths.`,
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
	if (targetClients.includes("opencode") || targetClients.includes("opencode2")) {
		notes.push("Restart OpenCode or open a new OpenCode session to load the Interlinked plugin.");
	}
	if (targetClients.includes("pi")) {
		notes.push(
			"Run `/reload` in Pi (or restart it) and trust the Interlinked project extension when prompted.",
		);
	}
	return notes;
}

// ===========================================
// Dry Run Output
// ===========================================

function printDryRun(
	cwd: string,
	options: EnableOptions,
	requestedClients: ClientName[] | null,
): void {
	console.log(c.bold("Interlinked CLI — Enable (dry run)"));
	console.log(c.dim("─".repeat(40)));
	console.log(c.dim("No files will be modified.\n"));

	if (isConfigured(cwd)) {
		console.log(`${c.dim("Config:")}     Already exists at ${getConfigDir(cwd)}/`);
	} else {
		console.log(`${c.green("Create:")}     ${getConfigDir(cwd)}/config.json`);
	}

	if (hasLegacyConfig(cwd)) {
		console.log(`${c.yellow("Migrate:")}    .claude/interlinked-session.json -> .interlinked/`);
	}

	const hookPath = getHookScriptPath(cwd).replace(`${cwd}/`, "");
	console.log(`${c.green("Write:")}      ${hookPath}`);

	const detected = detectClients(cwd);
	const detectedNames = detected.filter((d) => d.exists).map((d) => d.name);
	const targetClients = resolveTargetClients(requestedClients, detectedNames);

	console.log(`\n${c.bold("Would install hooks for:")}`);
	for (const client of targetClients) {
		const isDetected = detectedNames.includes(client);
		const suffix = isDetected ? c.dim(" (detected)") : c.dim(" (forced)");
		const summary = clientSummary(client);
		if (summary) {
			console.log(`  ${c.bold(summary.label)} — ${summary.eventCountText}${suffix}`);
		}
	}

	console.log(`\n${c.bold("Would update .gitignore with:")}`);
	console.log("  .interlinked/config.local.json");
	console.log("  .interlinked/sessions/");

	const serverUrl = options.server || "http://localhost:8787";
	console.log(`\n${c.dim("Server:")} ${serverUrl}`);
	if (options.agent) {
		console.log(`${c.dim("Agent:")}  ${options.agent}`);
	}

	console.log(`\n${c.dim("Run without --dry-run to apply.")}`);
}
