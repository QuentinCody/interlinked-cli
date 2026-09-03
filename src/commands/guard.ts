// ===========================================
// interlinked guard — File reservation enforcement via git hooks
// ===========================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, readLocalConfig, updateLocalConfig } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { getGitToplevel, getStagedFiles, isGitRepo } from "../lib/git-utils.js";
import { patternsOverlap } from "../lib/glob-overlap.js";
import {
	GUARD_CACHE_FILE,
	getGuardHookStatus,
	installGuardHook,
	uninstallGuardHook,
} from "../lib/guard-hooks.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

// ===========================================
// Types
// ===========================================

interface Conflict {
	file: string;
	reservation_pattern: string;
	reserved_by: string;
	expires_at?: string | undefined;
}

interface GuardCheckResult {
	conflicts: Conflict[];
	clean: boolean;
	mode: string;
	cached: boolean;
	cache_age_seconds?: number | undefined;
	files_checked: number;
}

interface Reservation {
	agent_name: string;
	/** Server returns path_pattern; we normalize to this field */
	path_pattern: string;
	expires_at?: string | undefined;
}

// ===========================================
// guard install
// ===========================================

export async function guardInstallCommand(opts: {
	mode?: string;
	prePush?: boolean;
	json?: boolean;
}): Promise<void> {
	const outputMode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		if (!isGitRepo(cwd)) {
			throw new Error("Not a git repository. Run this command from within a git repo.");
		}

		const guardMode = opts.mode === "block" ? "block" : "warn";
		updateLocalConfig({ guard_mode: guardMode });

		const gitRoot = getGitToplevel(cwd) || cwd;
		const preCommitResult = installGuardHook(gitRoot, "pre-commit");

		let prePushResult: { installed: boolean; backed_up?: string } | undefined;
		if (opts.prePush) {
			prePushResult = installGuardHook(gitRoot, "pre-push");
		}

		const result = {
			mode: guardMode,
			pre_commit: preCommitResult,
			pre_push: prePushResult,
			config_dir: getConfigDir(cwd),
		};

		output(outputMode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Guard Installed"));
				lines.push(
					kvLine("Mode", guardMode === "block" ? c.red("block") : c.yellow("warn")),
				);
				lines.push(
					kvLine(
						"pre-commit",
						preCommitResult.installed
							? c.green("installed")
							: c.dim("already installed"),
					),
				);
				if (preCommitResult.backed_up) {
					lines.push(kvLine("Backup", preCommitResult.backed_up));
				}
				if (prePushResult) {
					lines.push(
						kvLine(
							"pre-push",
							prePushResult.installed
								? c.green("installed")
								: c.dim("already installed"),
						),
					);
				}
				lines.push("");
				lines.push(c.dim("  Guard will check staged files against active reservations."));
				lines.push(
					c.dim(
						guardMode === "block"
							? "  Commits with conflicts will be blocked."
							: "  Conflicts will show warnings but allow commits.",
					),
				);
				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(outputMode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// guard check
// ===========================================

export async function guardCheckCommand(opts: { files?: string[]; json?: boolean }): Promise<void> {
	const outputMode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		if (!isGitRepo(cwd)) {
			throw new Error("Not a git repository. Run this command from within a git repo.");
		}

		// Determine files to check
		const files = opts.files && opts.files.length > 0 ? opts.files : getStagedFiles(cwd);

		if (files.length === 0) {
			const result: GuardCheckResult = {
				conflicts: [],
				clean: true,
				mode: getGuardMode(),
				cached: false,
				files_checked: 0,
			};
			output(outputMode, result, {
				json: () => result,
				normal: () => c.dim("No files to check (no staged files)."),
			});
			return;
		}

		// Get reservations (try server, fallback to cache)
		const { reservations, cached, cacheAgeSeconds } = await getReservations(cwd);
		const agentName = readLocalConfig()?.agent_name;
		const guardMode = getGuardMode();

		// Find conflicts
		const conflicts = findReservationConflicts(files, reservations, agentName);

		const result: GuardCheckResult = {
			conflicts,
			clean: conflicts.length === 0,
			mode: guardMode,
			cached,
			cache_age_seconds: cacheAgeSeconds,
			files_checked: files.length,
		};

		output(outputMode, result, {
			json: () => result,
			normal: () => {
				if (result.clean) {
					return c.green(
						`No reservation conflicts (${result.files_checked} files checked).`,
					);
				}

				const lines: string[] = [];
				lines.push(
					c.yellow(
						`${result.conflicts.length} reservation conflict${result.conflicts.length === 1 ? "" : "s"} found:`,
					),
				);
				lines.push("");
				for (const conflict of result.conflicts) {
					lines.push(
						`  ${c.red(conflict.file)} ${c.dim("reserved by")} ${c.bold(conflict.reserved_by)}`,
					);
					lines.push(
						`    ${c.dim("pattern:")} ${conflict.reservation_pattern}${conflict.expires_at ? c.dim(` (expires ${conflict.expires_at})`) : ""}`,
					);
				}
				if (cached) {
					lines.push("");
					lines.push(
						c.dim(
							`  (using cached reservations${cacheAgeSeconds ? `, ${cacheAgeSeconds}s old` : ""})`,
						),
					);
				}
				return lines.join("\n");
			},
		});

		// In block mode, exit non-zero on conflicts
		if (!result.clean && guardMode === "block") {
			process.exitCode = 1;
		}
	} catch (err) {
		outputError(outputMode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// guard status
// ===========================================

export async function guardStatusCommand(opts: { json?: boolean }): Promise<void> {
	const outputMode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		const gitRoot = isGitRepo(cwd) ? getGitToplevel(cwd) || cwd : null;
		const guardMode = getGuardMode();
		const hookStatus = gitRoot
			? getGuardHookStatus(gitRoot)
			: { pre_commit: false, pre_push: false };
		const cache = readGuardCache(cwd);

		const result = {
			mode: guardMode,
			hooks: hookStatus,
			cache: cache
				? {
						reservation_count: cache.reservations.length,
						fetched_at: cache.fetched_at,
						age_seconds: Math.floor(
							(Date.now() - new Date(cache.fetched_at).getTime()) / MS_PER_SECOND,
						),
					}
				: null,
			git_repo: gitRoot !== null,
		};

		output(outputMode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Guard Status"));
				lines.push(
					kvLine(
						"Mode",
						guardMode === "off"
							? c.dim("off")
							: guardMode === "block"
								? c.red("block")
								: c.yellow("warn"),
					),
				);
				lines.push(kvLine("Git repo", gitRoot ? c.green("yes") : c.red("no")));
				lines.push(
					kvLine(
						"pre-commit",
						hookStatus.pre_commit ? c.green("installed") : c.dim("not installed"),
					),
				);
				lines.push(
					kvLine(
						"pre-push",
						hookStatus.pre_push ? c.green("installed") : c.dim("not installed"),
					),
				);

				if (result.cache) {
					lines.push(
						kvLine(
							"Cache",
							`${result.cache.reservation_count} reservations (${result.cache.age_seconds}s old)`,
						),
					);
				} else {
					lines.push(kvLine("Cache", c.dim("empty")));
				}

				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(outputMode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// guard uninstall
// ===========================================

export async function guardUninstallCommand(opts: { json?: boolean }): Promise<void> {
	const outputMode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		if (!isGitRepo(cwd)) {
			throw new Error("Not a git repository.");
		}

		const gitRoot = getGitToplevel(cwd) || cwd;
		const preCommitResult = uninstallGuardHook(gitRoot, "pre-commit");
		const prePushResult = uninstallGuardHook(gitRoot, "pre-push");

		updateLocalConfig({ guard_mode: "off" });

		const result = {
			pre_commit: preCommitResult,
			pre_push: prePushResult,
			mode: "off",
		};

		output(outputMode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Guard Uninstalled"));
				lines.push(
					kvLine(
						"pre-commit",
						preCommitResult.removed ? c.green("removed") : c.dim("not found"),
					),
				);
				if (preCommitResult.restored) {
					lines.push(kvLine("Restored", preCommitResult.restored));
				}
				lines.push(
					kvLine(
						"pre-push",
						prePushResult.removed ? c.green("removed") : c.dim("not found"),
					),
				);
				if (prePushResult.restored) {
					lines.push(kvLine("Restored", prePushResult.restored));
				}
				lines.push(kvLine("Mode", c.dim("off")));
				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(outputMode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// Helpers
// ===========================================

/** Every (file, other agent's reservation) pair whose pattern covers the file. */
function findReservationConflicts(
	files: string[],
	reservations: Reservation[],
	agentName: string | undefined,
): Conflict[] {
	const conflicts: Conflict[] = [];
	for (const file of files) {
		for (const reservation of reservations) {
			// Skip own reservations
			if (agentName && reservation.agent_name === agentName) {
				continue;
			}
			if (patternsOverlap(file, reservation.path_pattern)) {
				conflicts.push({
					file,
					reservation_pattern: reservation.path_pattern,
					reserved_by: reservation.agent_name,
					expires_at: reservation.expires_at,
				});
			}
		}
	}
	return conflicts;
}

function getGuardMode(): string {
	const local = readLocalConfig();
	return local?.guard_mode || "off";
}

const MS_PER_SECOND = 1000;
const CACHE_TTL_MS = 5 * 60 * MS_PER_SECOND; // 5 minutes

interface GuardCache {
	reservations: Reservation[];
	fetched_at: string;
}

function readGuardCache(cwd: string): GuardCache | null {
	const cachePath = join(getConfigDir(cwd), GUARD_CACHE_FILE);
	if (!existsSync(cachePath)) return null;
	try {
		return JSON.parse(readFileSync(cachePath, "utf-8")) as GuardCache;
	} catch {
		return null;
	}
}

function writeGuardCache(cwd: string, reservations: Reservation[]): void {
	const cachePath = join(getConfigDir(cwd), GUARD_CACHE_FILE);
	const dir = join(getConfigDir(cwd));
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(
		cachePath,
		JSON.stringify({ reservations, fetched_at: new Date().toISOString() }, null, 2),
	);
}

async function getReservations(
	cwd: string,
): Promise<{ reservations: Reservation[]; cached: boolean; cacheAgeSeconds?: number }> {
	// Try fetching from server
	try {
		const { getClient } = await import("../lib/api-client.js");
		const client = getClient();
		const result = await client.callTool<{
			reservations?: Array<{
				agent_name: string;
				path_pattern: string;
				exclusive?: boolean;
				expires_at?: string;
			}>;
		} | null>("list_file_reservations", { brief: true });

		const reservations: Reservation[] = (result?.reservations || []).map((r) => ({
			agent_name: r.agent_name,
			path_pattern: r.path_pattern,
			expires_at: r.expires_at,
		}));

		// Update cache
		writeGuardCache(cwd, reservations);

		return { reservations, cached: false };
	} catch {
		// Fallback to cache
		const cache = readGuardCache(cwd);
		if (cache) {
			const ageMs = Date.now() - new Date(cache.fetched_at).getTime();
			const stale = ageMs > CACHE_TTL_MS;
			if (stale) {
				// Warn but still use stale cache
				console.error(
					c.yellow(
						"Warning: reservation cache is stale (server unreachable). Results may be outdated.",
					),
				);
			}
			return {
				reservations: cache.reservations,
				cached: true,
				cacheAgeSeconds: Math.floor(ageMs / MS_PER_SECOND),
			};
		}

		// No cache available
		console.error(c.yellow("Warning: could not fetch reservations and no cache available."));
		return { reservations: [], cached: false };
	}
}
