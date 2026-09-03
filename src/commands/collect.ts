// ===========================================
// interlinked collect — sync external model sessions into the unified timeline
// ===========================================
// Folds OpenAI Codex session transcripts (~/.codex/sessions/) into the repo's
// normalized `.interlinked/timeline.jsonl` (schema timeline.v1), the SAME store
// the daemon fills live from Claude Code transcripts. One place for every
// model's input+output — cross-model analysis, distillation, fine-tuning
// (project ask 2026-07-18). Claude sessions are already captured live/backfill;
// this closes the Codex gap. Idempotent — safe to re-run or schedule.

import type { Command } from "commander";
import { codexSessionsDir, collectCodexSessions } from "../harness/codex-collect.js";
import { parseDuration } from "../lib/activity-utils.js";

interface CollectOpts {
	provider: string;
	since?: string;
	dir?: string;
	dryRun?: boolean;
	json?: boolean;
	cwd?: string;
}

/** Report a fatal CLI error (json envelope or stderr) and set the exit code. Shared by every early-exit path below. */
function reportCollectError(json: boolean | undefined, message: string): void {
	if (json) console.log(JSON.stringify({ ok: false, error: message }));
	else console.error(message);
	process.exitCode = 2;
}

/** True (and already reported) when the requested provider isn't codex. Extracted to drop a nesting level from the action callback. */
function handleUnsupportedProvider(json: boolean | undefined, provider: string): boolean {
	if (provider !== "codex") {
		const msg =
			provider === "claude" || provider === "claude-code"
				? "Claude sessions are already captured live by the daemon (and rebuildable via the timeline backfill) — `collect` covers the external-provider gap. Only `--provider codex` is supported today."
				: `Unknown provider "${provider}". Supported: codex.`;
		reportCollectError(json, msg);
		return true;
	}
	return false;
}

/** Resolves --since into a cutoff timestamp, reporting a parse failure itself. Extracted to drop a nesting level from the action callback. */
function resolveSinceMs(
	json: boolean | undefined,
	since: string | undefined,
): { sinceMs?: number; failed: boolean } {
	if (!since) return { failed: false };
	try {
		return { sinceMs: Date.now() - parseDuration(since), failed: false };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		reportCollectError(json, msg);
		return { failed: true };
	}
}

function tryCollectCodexSessions(
	opts: CollectOpts,
	cwd: string,
	sinceMs: number | undefined,
): ReturnType<typeof collectCodexSessions> | null {
	try {
		return collectCodexSessions({
			cwd,
			dir: opts.dir ?? codexSessionsDir(),
			...(sinceMs !== undefined ? { sinceMs } : {}),
			dryRun: opts.dryRun === true,
		});
	} catch (error) {
		reportCollectError(
			opts.json,
			error instanceof Error ? error.message : String(error),
		);
		return null;
	}
}

export function registerCollectCommand(program: Command): void {
	program
		.command("collect")
		.description("Sync external model sessions (Codex) into .interlinked/timeline.jsonl")
		.option("--provider <name>", "model provider to collect", "codex")
		.option("--since <duration>", "only sessions modified within this window (e.g. 24h, 7d)")
		.option("--dir <path>", "override the source sessions directory")
		.option("--dry-run", "report counts without writing")
		.option("--json", "machine-readable output")
		.option("--cwd <path>", "working directory whose .interlinked/timeline.jsonl receives the records")
		.action((opts: CollectOpts) => {
			const cwd = opts.cwd ?? process.cwd();
			const provider = opts.provider.toLowerCase();
			if (handleUnsupportedProvider(opts.json, provider)) return;

			const sinceResult = resolveSinceMs(opts.json, opts.since);
			if (sinceResult.failed) return;

			const result = tryCollectCodexSessions(opts, cwd, sinceResult.sinceMs);
			if (result === null) return;

			if (opts.json) {
				console.log(JSON.stringify({ ok: true, provider, dryRun: opts.dryRun === true, ...result }));
				return;
			}
			const verb = opts.dryRun ? "would add" : "added";
			console.log(
				`codex: scanned ${result.files} rollout file(s) across ${result.sessions} session(s); ` +
					`${verb} ${result.added} new record(s) to .interlinked/timeline.jsonl (parsed ${result.parsed}).`,
			);
			if (result.added === 0 && !opts.dryRun) {
				console.log("timeline already up to date.");
			}
		});
}
