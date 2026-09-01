// ===========================================
// Named sources for `interlinked query`
// ===========================================
// Each source names a .interlinked JSONL log, the identity filter that defines
// it (always ANDed with user --where clauses), default display fields, and a
// usage hint. The table productizes the eight INDEX.md query recipes — and
// gives previously reader-less logs (reservation-events.jsonl) a surface.
// Field lists follow live row shapes, which drift; the engine tolerates absent
// fields, so a schema change degrades display, never correctness.

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getDataDir } from "../../lib/config.js";

interface QuerySource {
	name: string;
	file: string;
	/** Identity filter — what makes a record part of this source. */
	where: string[];
	/** Default display columns (dot paths; ts is always shown first). */
	fields: string[];
	hint: string;
}

export const QUERY_SOURCES: QuerySource[] = [
	{
		name: "blocks",
		file: "activity.jsonl",
		where: ["type=guard_block"],
		fields: ["tool", "guard_rule_id", "summary"],
		hint: "what the guard refused, with rule ids",
	},
	{
		name: "guards",
		file: "activity.jsonl",
		where: ["type~=guard_"],
		fields: ["type", "tool", "guard_rule_id", "summary"],
		hint: "every guard verdict (block/warn/allow)",
	},
	{
		name: "checks",
		file: "check-results.jsonl",
		where: [],
		fields: ["tool", "decision", "checks.id"],
		hint: "per-edit check outcomes (try --by checks.id)",
	},
	{
		name: "recurrences",
		file: "recurrences.jsonl",
		where: [],
		fields: ["kind", "check_id", "file"],
		hint: "repeating catches (try --by check_id)",
	},
	{
		name: "costs",
		file: "costs.jsonl",
		where: [],
		fields: ["session_id", "model", "output_tokens"],
		hint: "token spend (try --by session_id --sum output_tokens)",
	},
	{
		name: "events",
		file: "collection.jsonl",
		where: ["kind=tool_event"],
		fields: ["phase", "provider", "provider_tool"],
		hint: "canonical cross-runner tool events",
	},
	{
		name: "agents",
		file: "collection.jsonl",
		where: ["kind=agent_event"],
		fields: ["agent_name", "action"],
		hint: "subagent lifecycle + captured results",
	},
	{
		name: "thinking",
		file: "timeline.jsonl",
		where: ["category=agent_thinking"],
		fields: ["text"],
		hint: "captured agent reasoning",
	},
	{
		name: "messages",
		file: "timeline.jsonl",
		where: ["category=agent_message"],
		fields: ["text"],
		hint: "agent-emitted messages",
	},
	{
		name: "tests",
		file: "tests.jsonl",
		where: [],
		fields: ["kind", "ok", "command"],
		hint: "verification runs (vitest/tsc/lint/build)",
	},
	{
		name: "reservations",
		file: "reservation-events.jsonl",
		where: [],
		fields: ["action", "file", "agent_name"],
		hint: "multi-agent file leases (grant/release/conflict)",
	},
	{
		name: "suggestions",
		file: "suggestion-telemetry.jsonl",
		where: [],
		fields: ["check", "file", "score", "shown"],
		hint: "scored advisory findings",
	},
];

export interface ResolvedTarget {
	file: string;
	label: string;
	source?: QuerySource;
}

/**
 * Resolve the query target: --file wins, then a known source name, then a
 * .jsonl path (cwd-relative first, then inside the data dir). No target →
 * undefined (caller prints the catalog).
 */
export function resolveTarget(
	target: string | undefined,
	fileOpt: string | undefined,
	cwd: string,
): ResolvedTarget | undefined {
	if (fileOpt !== undefined && fileOpt !== "") {
		return { file: isAbsolute(fileOpt) ? fileOpt : resolve(cwd, fileOpt), label: fileOpt };
	}
	if (target === undefined || target === "") return undefined;

	const source = QUERY_SOURCES.find((s) => s.name === target);
	if (source) {
		return { file: join(getDataDir(cwd), source.file), label: source.name, source };
	}

	if (target.endsWith(".jsonl")) {
		const direct = isAbsolute(target) ? target : resolve(cwd, target);
		if (existsSync(direct)) return { file: direct, label: target };
		const inDataDir = join(getDataDir(cwd), target);
		if (existsSync(inDataDir)) return { file: inDataDir, label: target };
		throw new Error(`No such file: ${target} (looked at ${direct} and ${inDataDir})`);
	}

	const known = QUERY_SOURCES.map((s) => s.name).join(", ");
	throw new Error(`Unknown source "${target}". Known sources: ${known} — or pass a .jsonl path`);
}
