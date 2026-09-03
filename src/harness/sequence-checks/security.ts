// Security-shape sequence detectors. Pre_block / pre_warn detectors that
// fire on suspicious shapes the per-call checks can't see: secret-then-
// network exfiltration, download-then-execute supply-chain shapes, and
// repetition-without-observation patterns.
//
// Detectors in this file:
//   - secret_read_then_network_call (§3.1, pre_block)
//   - download_then_execute (§3.2, pre_block)
//   - same_command_thrice_no_observe (§3.9, pre_warn)

import { isNetworkCommand } from "../taint-tracker.js";
import { CONFIDENTIAL_LEVELS, getCommand, isBashCandidate } from "./candidate-helpers.js";
import type { SequenceDetector } from "./types.js";

/** Test if the candidate Bash command targets localhost / loopback. */
const LOCALHOST_RE = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\b/;

// ============================================================
// §3.1 secret_read_then_network_call
// ============================================================

/** Fires when the session is at Confidential+ sensitivity AND the candidate
 *  is a Bash network call targeting a non-localhost destination. */
export const secretReadThenNetworkCall: SequenceDetector = {
	id: "secret_read_then_network_call",
	description: "Network call after sensitive read; potential exfiltration",
	family: "security-shape",
	phase: "pre_block",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory, candidate) => {
		if (!isBashCandidate(candidate.tool_name)) return [];
		const cmd = getCommand(candidate.tool_input);
		if (!cmd) return [];
		if (!isNetworkCommand(cmd)) return [];
		if (LOCALHOST_RE.test(cmd)) return [];
		if (!CONFIDENTIAL_LEVELS.has(trajectory.sensitivity_level)) return [];
		const sources = trajectory.taint_sources
			.filter((s) => CONFIDENTIAL_LEVELS.has(s.level))
			.slice(-3)
			.map((s) => s.file);
		return [
			{
				prior_event_count: sources.length,
				prior_summary: `read ${sources.length} confidential source(s) earlier`,
				message:
					`Outbound network call after reading confidential data (sensitivity=${trajectory.sensitivity_level}). ` +
					"This is the textbook secret-exfiltration shape. If the destination is legitimate, " +
					"acknowledge with `// interlinked: defer secret_read_then_network_call -- <reason>`.",
				evidence: sources,
			},
		];
	},
};

// ============================================================
// §3.2 download_then_execute
// ============================================================

/** Match `curl|wget|http <url> -o <path>` or `… > <path>` and capture <path>. */
const DOWNLOAD_RE =
	/\b(?:curl|wget|http|https)\b[^|;]*?(?:\s-o\s+([^\s]+)|\s>\s*([^\s|;]+))/i;

/** Redirection sinks that are not real downloaded artifacts. `curl -o /dev/null`
 *  discards the response body; treating it as a downloaded file produces false
 *  positives — any later command mentioning the sink path looks like
 *  "executing the download". `-` is curl's stdout sink. */
const NON_ARTIFACT_SINKS = new Set([
	"/dev/null",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/zero",
	"-",
]);

/** Match an execution of a specific path: `bash <path>`, `./<path>`,
 *  `python <path>`, `sh <path>`, or a bare path invoked as argv[0].
 *
 *  m2 requires the path to be in COMMAND position — the start of the line or
 *  immediately after a `;` / `|` / `&` segment delimiter — NOT merely an
 *  argument to some other command. `cat /tmp/x`, `jq . /tmp/x`, `rm /tmp/x`,
 *  `head /tmp/x` pass a path as an argument, which is not execution; only
 *  `/tmp/x` invoked directly is. The earlier `(?:^|\s|\|)` matched the
 *  argument case too and produced false download-then-execute positives on
 *  read-only inspectors (`cat downloaded.json`) and discarded-output curls. */
function findExecutedPath(cmd: string): string | null {
	// `bash <path>` / `sh <path>` / `python <path>` / `node <path>`
	const m1 =
		/\b(?:bash|sh|zsh|python3?|node|ruby|perl|php)\s+(\.?\/[^\s|;&]+)/i.exec(cmd);
	if (m1) return m1[1] ?? null;
	// `./<path>` or absolute `/<path>` invoked directly as argv[0].
	const m2 = /(?:^|[;|&])\s*((?:\.\/|\/)[^\s|;&]+)/.exec(cmd);
	if (m2) return m2[1] ?? null;
	return null;
}

export const downloadThenExecute: SequenceDetector = {
	id: "download_then_execute",
	description: "Recent download to a path, then execution of that path",
	family: "security-shape",
	phase: "pre_block",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory, candidate) => {
		if (!isBashCandidate(candidate.tool_name)) return [];
		const cmd = getCommand(candidate.tool_input);
		if (!cmd) return [];
		const executedPath = findExecutedPath(cmd);
		if (!executedPath) return [];
		const recent = trajectory.commands_run.slice(-10);
		for (const prior of recent) {
			const m = DOWNLOAD_RE.exec(prior);
			if (!m) continue;
			const downloadedPath = m[1] ?? m[2];
			if (!downloadedPath) continue;
			if (NON_ARTIFACT_SINKS.has(downloadedPath)) continue;
			if (executedPath === downloadedPath || executedPath.endsWith(downloadedPath)) {
				return [
					{
						prior_event_count: 1,
						prior_summary: `downloaded ${downloadedPath}`,
						message:
							`Candidate executes ${executedPath}, which was downloaded earlier this session ` +
							`(\`${prior.slice(0, 80)}…\`). Download-and-run is the textbook supply-chain ` +
							"compromise shape. Verify the artifact's integrity before executing.",
						evidence: [downloadedPath, executedPath],
					},
				];
			}
		}
		return [];
	},
};

// ============================================================
// §3.9 same_command_thrice_no_observe
// ============================================================

/** Normalize a command for repetition detection. Collapses runs of
 *  whitespace; preserves the rest exactly. */
function normalizeCmd(cmd: string): string {
	return cmd.replace(/\s+/g, " ").trim();
}

export const sameCommandThriceNoObserve: SequenceDetector = {
	id: "same_command_thrice_no_observe",
	description:
		"Third identical Bash command with no intervening Read of its output",
	family: "security-shape",
	phase: "pre_warn",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory, candidate) => {
		if (!isBashCandidate(candidate.tool_name)) return [];
		const cmd = getCommand(candidate.tool_input);
		if (!cmd) return [];
		const normCmd = normalizeCmd(cmd);
		const tail = trajectory.tool_sequence.slice(-2);
		if (tail.length < 2) return [];
		const allBash = tail.every((s) => s.startsWith("Bash:"));
		if (!allBash) return [];
		// Get the last two commands run; tool_sequence stores `Bash:<target>`
		// but `commands_run` stores raw command text. Compare on commands_run.
		const recentCmds = trajectory.commands_run.slice(-2).map(normalizeCmd);
		if (recentCmds.length < 2) return [];
		if (recentCmds[0] !== normCmd || recentCmds[1] !== normCmd) return [];
		return [
			{
				prior_event_count: 2,
				prior_summary: `same Bash command run 2 prior times`,
				message:
					`Same Bash command about to run for the third time: \`${normCmd.slice(0, 80)}…\`. ` +
					"No intervening file read between runs — agent is repeating without observing the result. " +
					"Read the output of the previous run before re-issuing, or rephrase the goal.",
				evidence: [normCmd],
			},
		];
	},
};

// ============================================================
// §3.7 env_modification_then_bash
// ============================================================

/** Library-injection env vars whose modification in a shell init file or
 *  via `export` is the textbook shim/preload shape. */
const DANGEROUS_ENV_VAR_RE =
	/\b(?:LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|PYTHONPATH|NODE_OPTIONS|RUBYOPT|PERL5OPT)\b/;

/** Shell init-file paths whose edit constitutes a session-scope env modification. */
const SHELL_INIT_RE =
	/(?:^|\/)(?:\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\.envrc|\.env|\.fish\/config\.fish)$/;

function priorCommandsMatchEnv(commands_run: ReadonlyArray<string>): boolean {
	for (const cmd of commands_run) {
		if (DANGEROUS_ENV_VAR_RE.test(cmd) && /\bexport\b/.test(cmd)) return true;
	}
	return false;
}

function priorWritesToShellInit(files_written: ReadonlySet<string>): boolean {
	for (const f of files_written) {
		if (SHELL_INIT_RE.test(f)) return true;
	}
	return false;
}

export const envModificationThenBash: SequenceDetector = {
	id: "env_modification_then_bash",
	description:
		"Bash candidate following an env-var modification of LD_PRELOAD / NODE_OPTIONS / similar shim hook",
	family: "security-shape",
	phase: "pre_warn",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory, candidate) => {
		if (!isBashCandidate(candidate.tool_name)) return [];
		const envExportSeen = priorCommandsMatchEnv(trajectory.commands_run);
		const shellInitEdited = priorWritesToShellInit(trajectory.files_written);
		if (!envExportSeen && !shellInitEdited) return [];
		const cmd = getCommand(candidate.tool_input);
		if (!cmd) return [];
		return [
			{
				prior_event_count: 1,
				prior_summary: envExportSeen
					? "dangerous env var exported earlier"
					: "shell init file edited earlier",
				message:
					"Bash candidate follows a session-scope env-var modification (LD_PRELOAD / " +
					"NODE_OPTIONS / shell init edit). Library-injection / shim shapes look exactly " +
					"like legitimate tool setup — confirm the command is run with the intended env, " +
					"or acknowledge with `// interlinked: defer env_modification_then_bash -- <reason>`.",
				evidence: [cmd.slice(0, 80)],
			},
		];
	},
};

// ============================================================
// §3.8 npm_run_then_curl_to_localhost
// ============================================================

const DEV_SERVER_RE =
	/\b(?:npm\s+run|pnpm|yarn(?:\s+\w+)?|bun(?:\s+run)?|vite|next\s+dev|nuxt\s+dev|astro\s+dev|django\s+runserver|rails\s+s|flask\s+run)\b/i;

const CURL_VERB_RE = /\b(?:curl|wget|http|https)\b/i;

export const npmRunThenCurlToLocalhost: SequenceDetector = {
	id: "npm_run_then_curl_to_localhost",
	description:
		"curl/wget against loopback after a dev-server-launching command — confirm probe vs scan",
	family: "security-shape",
	phase: "pre_warn",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory, candidate) => {
		if (!isBashCandidate(candidate.tool_name)) return [];
		const cmd = getCommand(candidate.tool_input);
		if (!cmd) return [];
		// Reuse the LOCALHOST_RE declared at the top of this file so the
		// loopback-host literals live in exactly one place.
		if (!CURL_VERB_RE.test(cmd) || !LOCALHOST_RE.test(cmd)) return [];
		const devServerLaunched = trajectory.commands_run.some((c) => DEV_SERVER_RE.test(c));
		if (!devServerLaunched) return [];
		return [
			{
				prior_event_count: 1,
				prior_summary: "dev-server-launching command earlier",
				message:
					"Loopback-host curl/wget after a dev-server launch — usually legitimate (testing " +
					"your work) but occasionally a vulnerability scan. Confirm the probe's purpose, " +
					"especially if hitting non-standard ports or unrelated paths.",
				evidence: [cmd.slice(0, 80)],
			},
		];
	},
};

// ============================================================
// §3.3 install_then_unauthored_execute (stop)
// ============================================================

/** Bash verbs that install packages (broad match — any package manager
 *  ecosystem). Used as a heuristic anchor for the "install happened this
 *  session" leg; the §3.3 install_then_unauthored_execute detector then
 *  asks whether a subsequent execution targets a file the agent never
 *  read or wrote. */
const INSTALL_VERB_RE =
	/\b(?:npm|pnpm|yarn|bun|pip|pip3|pipx|poetry|uv|cargo|gem|bundle|go|brew|apt|apt-get)\b\s+(?:install|add)\b/i;

/** Execution patterns that target a specific script path. */
const EXEC_PATH_RE =
	/(?:^|\s|\|)(?:bash|sh|zsh|python3?|node|ruby|perl|php)\s+([./][^\s|;&]+)/i;
const DIRECT_PATH_RE = /(?:^|\s|\|)((?:\.\/|\/)[^\s|;&]+)/;

function extractExecutedPath(cmd: string): string | null {
	const m1 = EXEC_PATH_RE.exec(cmd);
	if (m1) return m1[1] ?? null;
	const m2 = DIRECT_PATH_RE.exec(cmd);
	if (m2) return m2[1] ?? null;
	return null;
}

export const installThenUnauthoredExecute: SequenceDetector = {
	id: "install_then_unauthored_execute",
	description:
		"Package install earlier in session followed by execution of a file the agent never read or wrote",
	family: "security-shape",
	phase: "stop",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory) => {
		const sawInstall = trajectory.commands_run.some((c) => INSTALL_VERB_RE.test(c));
		if (!sawInstall) return [];
		const unauthored: string[] = [];
		for (const cmd of trajectory.commands_run) {
			const executedPath = extractExecutedPath(cmd);
			if (!executedPath) continue;
			// Skip obvious system binaries.
			if (executedPath.startsWith("/usr/") || executedPath.startsWith("/bin/")) continue;
			// "Unauthored" = neither read nor written by this session.
			if (trajectory.files_read.has(executedPath)) continue;
			if (trajectory.files_written.has(executedPath)) continue;
			unauthored.push(executedPath);
		}
		if (unauthored.length === 0) return [];
		return [
			{
				prior_event_count: unauthored.length,
				prior_summary: `package install earlier; ${unauthored.length} execution(s) of unread paths`,
				message:
					`After a package install this session, the agent executed ${unauthored.length} script ` +
					`path(s) without reading them first: ${unauthored.slice(0, 3).join(", ")}` +
					(unauthored.length > 3 ? ` (+${unauthored.length - 3} more)` : "") +
					". Post-install scripts often land on disk and are then invoked without inspection — " +
					"read the script(s) before running, or acknowledge with " +
					"`// interlinked: defer install_then_unauthored_execute -- <reason>`.",
				evidence: unauthored.slice(0, 3),
			},
		];
	},
};

export const SECURITY_DETECTORS: ReadonlyArray<SequenceDetector> = [
	secretReadThenNetworkCall,
	downloadThenExecute,
	sameCommandThriceNoObserve,
	envModificationThenBash,
	npmRunThenCurlToLocalhost,
	installThenUnauthoredExecute,
];
