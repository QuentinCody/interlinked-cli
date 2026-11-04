// Internal semantic-graph actions, invoked only by scripts/internal/jev.mjs
// (`semantic-graph build|refresh|confirm`). They send unit text to TypeSafe
// (Jev) or spawn Haiku, so they are not on the public CLI and not invoked by
// the harness. The read-only views are public (`semantic-graph.ts`).

import { createJevClient, type JevClient } from "../harness/jev/client.js";
import { type BuildDeps, type BuildReport, buildSemanticGraph, type TypeBuildCounts } from "../harness/semantic-graph/build.js";
import type { HaikuRunner } from "../harness/semantic-graph/confirm.js";
import { runConfirmation } from "../harness/semantic-graph/confirm-run.js";
import { type RefreshReport, refreshSemanticGraph } from "../harness/semantic-graph/refresh.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_UNAVAILABLE = 2;
export const DEFAULT_BUILD_MAX_USD = 0.25;
export const DEFAULT_CONFIRM_MAX_CALLS = 20;
/** Packets carry up to twelve candidate texts; the client default (5 s) is sized for one-paragraph asks. */
const BUILD_TIMEOUT_MS = 20_000;

export interface SemanticGraphBuildOptions {
	/** Injected in tests; resolved from config + key otherwise. `null` = Jev unavailable. */
	client?: JevClient | null;
	cwd?: string;
	json?: boolean;
	maxUsd?: string;
	/** Comma-separated relationship type names. */
	types?: string;
	since?: string;
	/** Per type, the most packets asked after the unchanged skip. */
	maxPackets?: string;
	/** Injected in tests so no git or project graph is touched. */
	deps?: BuildDeps;
}

export interface SemanticGraphConfirmOptions {
	runner?: HaikuRunner;
	cwd?: string;
	json?: boolean;
	maxCalls?: string;
	fraction?: string;
}

function explainUnavailable(): number {
	process.stderr.write(
		"Internal Jev evaluation requires TYPESAFE_API_KEY in the environment or .interlinked/config.local.json.\n",
	);
	return EXIT_UNAVAILABLE;
}

/** A finite non-negative number, or null with the flag named on stderr. */
function parseNonNegative(raw: string | undefined, flag: string, fallback: number): number | null {
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		process.stderr.write(`${flag} must be a non-negative number; got ${JSON.stringify(raw)}\n`);
		return null;
	}
	return parsed;
}

function resolveClient(opts: SemanticGraphBuildOptions, maxUsd: number): JevClient | null {
	if (opts.client !== undefined) return opts.client;
	return createJevClient({ enabled: true, max_spend_usd: maxUsd, timeout_ms: BUILD_TIMEOUT_MS });
}

function splitTypes(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	const names = raw.split(",").map((name) => name.trim()).filter((name) => name !== "");
	return names.length > 0 ? names : undefined;
}

function formatTypeCounts(counts: TypeBuildCounts): string {
	return `${counts.type}: ${counts.sources} sources, ${counts.packets} packets (${counts.unchanged} unchanged, ${counts.no_candidates} without candidates), ${counts.judged} judged, ${counts.none_chosen} none, ${counts.failures} failed, ${counts.budget_skipped} over budget, ${counts.cap_skipped} over the packet cap, ${counts.edges} edges`;
}

function formatBuild(report: BuildReport): string[] {
	const lines = report.types.map(formatTypeCounts);
	if (report.unknown_types.length > 0) lines.push(`unknown types: ${report.unknown_types.join(", ")}`);
	lines.push(
		`${report.units} units; model ${report.model}; spend $${report.spend.usd.toFixed(4)} (${report.spend.calls} call(s), ${report.spend.failures} failure(s))`,
	);
	return lines;
}

function emit(json: boolean | undefined, data: unknown, lines: string[]): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(data)}\n`);
		return;
	}
	for (const line of lines) process.stdout.write(`${line}\n`);
}

interface ResolvedBuild {
	client: JevClient;
	maxUsd: number;
	types: string[] | undefined;
	maxPackets: number | undefined;
}

/** Shared argument resolution for build and refresh; a numeric code when the run cannot start. */
function resolveBuild(opts: SemanticGraphBuildOptions): ResolvedBuild | number {
	const maxUsd = parseNonNegative(opts.maxUsd, "--max-usd", DEFAULT_BUILD_MAX_USD);
	const maxPackets = parseNonNegative(opts.maxPackets, "--max-packets", -1);
	if (maxUsd === null || maxPackets === null) return EXIT_ERROR;
	const client = resolveClient(opts, maxUsd);
	if (!client) return explainUnavailable();
	return { client, maxUsd, types: splitTypes(opts.types), maxPackets: maxPackets >= 0 ? Math.floor(maxPackets) : undefined };
}

function buildOptions(resolved: ResolvedBuild, opts: SemanticGraphBuildOptions) {
	return {
		client: resolved.client,
		maxUsd: resolved.maxUsd,
		...(resolved.types ? { types: resolved.types } : {}),
		...(resolved.maxPackets !== undefined ? { maxPackets: resolved.maxPackets } : {}),
		...(opts.since !== undefined ? { since: opts.since } : {}),
		...(opts.deps ? { deps: opts.deps } : {}),
		log: (line: string) => {
			if (!opts.json) process.stderr.write(`${line}\n`);
		},
	};
}

/** `semantic-graph build`: judge every packet without a live judgment, under `--max-usd`. */
export async function semanticGraphBuildAction(opts: SemanticGraphBuildOptions = {}): Promise<number> {
	const resolved = resolveBuild(opts);
	if (typeof resolved === "number") return resolved;
	const report = await buildSemanticGraph(opts.cwd ?? process.cwd(), buildOptions(resolved, opts));
	emit(opts.json, report, formatBuild(report));
	return EXIT_OK;
}

function formatRefresh(report: RefreshReport): string[] {
	return [`${report.stale} edge(s) marked stale`, ...formatBuild(report.build)];
}

/** `semantic-graph refresh`: mark changed sources stale, then build. */
export async function semanticGraphRefreshAction(opts: SemanticGraphBuildOptions = {}): Promise<number> {
	const resolved = resolveBuild(opts);
	if (typeof resolved === "number") return resolved;
	const report = await refreshSemanticGraph(opts.cwd ?? process.cwd(), buildOptions(resolved, opts));
	emit(opts.json, report, formatRefresh(report));
	return EXIT_OK;
}

/** `semantic-graph confirm`: Haiku over the top slice of proposed edges, at most `--max-calls` spawns. */
export async function semanticGraphConfirmAction(opts: SemanticGraphConfirmOptions = {}): Promise<number> {
	const maxCalls = parseNonNegative(opts.maxCalls, "--max-calls", DEFAULT_CONFIRM_MAX_CALLS);
	const fraction = parseNonNegative(opts.fraction, "--fraction", -1);
	if (maxCalls === null || fraction === null) return EXIT_ERROR;
	const report = await runConfirmation(opts.cwd ?? process.cwd(), {
		maxCalls: Math.floor(maxCalls),
		...(opts.runner ? { runner: opts.runner } : {}),
		...(fraction >= 0 ? { fraction } : {}),
	});
	emit(opts.json, report, [
		`${report.selected} selected of ${report.candidates} proposed; ${report.calls} call(s), ${report.skipped} skipped`,
		`${report.confirmed} confirmed, ${report.contradicted} contradicted, ${report.undecided} undecided; ${report.appended} row(s) appended; ${report.units} units`,
	]);
	return EXIT_OK;
}
