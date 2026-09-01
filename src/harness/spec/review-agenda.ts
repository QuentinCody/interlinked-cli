// Review agenda generation (docs/design/spec-audit-runtime-checks.md
// §7.2/§7.3, spikes 10+11): the deterministic layer does an audit's
// DISCOVERY — which entities are constrained from multiple distant places,
// which artifact kinds are missing standard concerns, what drift and open
// findings remain — and hands the agenda to whatever reasoning capacity is
// present: the coding agent, a Tier-3 run, or the next external audit.
// Questions and joins only; never verdicts.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpecLedger } from "./ledger.js";
import type { HeadingInfo, SpecFacts } from "./types.js";

/** One agenda item: a pointed question with its provenance. */
interface AgendaItem {
	kind: "compose_check" | "coverage_gap" | "outstanding_drift";
	title: string;
	detail: string;
	sites: string[];
}

// ---------------------------------------------------------------------------
// Contract templates (§7.2): audits ask the same questions per artifact KIND.
// Kind detection reads the defining heading's vocabulary; the checklist scans
// the heading's section for each concern's vocabulary. Missing concern =
// coverage-gap obligation, never a verdict.
// ---------------------------------------------------------------------------

interface KindTemplate {
	kind: string;
	headingVocab: RegExp;
	concerns: Array<{ name: string; vocab: RegExp }>;
}

const KIND_TEMPLATES: KindTemplate[] = [
	{
		kind: "format",
		headingVocab: /\b(?:format|layout|encoding|serialization|wire|on-disk|record|frame)\b/i,
		concerns: [
			{ name: "versioning/migration", vocab: /\b(?:version|migrat|upgrade|backward)/i },
			{ name: "endianness", vocab: /\b(?:endian|byte order)/i },
			{ name: "torn-write/partial-tail", vocab: /\b(?:torn|partial|truncat|tail|crash)/i },
			{ name: "checksum/integrity", vocab: /\b(?:checksum|crc|integrity|corrupt)/i },
		],
	},
	{
		kind: "protocol",
		headingVocab: /\b(?:protocol|handshake|rpc|request|session|stream)\b/i,
		concerns: [
			{ name: "timeout/retry", vocab: /\b(?:timeout|retry|retries|deadline)/i },
			{ name: "idempotency", vocab: /\b(?:idempoten|duplicate|dedup|exactly|at-least)/i },
			{ name: "error taxonomy", vocab: /\b(?:error|fatal|retryable|failure mode)/i },
			{ name: "resumption/reconnect", vocab: /\b(?:resum|reconnect|recovery|restart)/i },
		],
	},
	{
		kind: "consensus/replication",
		headingVocab: /\b(?:raft|paxos|consensus|replicat|quorum|leader)\b/i,
		concerns: [
			{ name: "leader change", vocab: /\b(?:leader (?:change|election|failover)|takeover)/i },
			{ name: "unknown-outcome", vocab: /\b(?:unknown|ambiguous|in-doubt|COMMIT_UNKNOWN)/i },
			{ name: "fencing", vocab: /\b(?:fenc|epoch|stale (?:writer|leader))/i },
			{ name: "payload availability", vocab: /\b(?:availab|durab|recover)/i },
		],
	},
	{
		kind: "derived-state",
		headingVocab: /\b(?:cache|index|view|materialized|derived|projection)\b/i,
		concerns: [
			{ name: "invalidation", vocab: /\b(?:invalidat|staleness|refresh|evict)/i },
			{ name: "rebuild authority", vocab: /\b(?:rebuild|authoritative|source of truth|discard)/i },
		],
	},
	{
		kind: "crypto-keys",
		headingVocab: /\b(?:encrypt|key management|signing|kms|kek|dek)\b/i,
		concerns: [
			{ name: "rotation", vocab: /\brotat/i },
			{ name: "revocation", vocab: /\b(?:revocat|revoke)/i },
			{ name: "escrow/backup keys", vocab: /\b(?:escrow|backup key|recovery key)/i },
		],
	},
	{
		// The design's required identifier template (round-2 #30).
		kind: "identifier",
		headingVocab: /\b(?:identifier|\bid\b|object id|objectid|primary key|uuid|handle)\b/i,
		concerns: [
			{ name: "uniqueness scope", vocab: /\b(?:uniqu|scope|namespace|per-)/i },
			{ name: "collision handling", vocab: /\bcollision/i },
			{ name: "truncation", vocab: /\btruncat/i },
			{ name: "reuse/recycling", vocab: /\b(?:reuse|recycl|wrap|generation)/i },
		],
	},
];

/** Section text for a heading (to the next same-or-higher heading). */
function sectionText(facts: SpecFacts, heading: HeadingInfo, lines: string[]): string {
	let end = lines.length;
	for (const h of facts.headings) {
		if (h.line > heading.line && h.level <= heading.level) {
			end = h.line - 1;
			break;
		}
	}
	return lines.slice(heading.line - 1, end).join("\n");
}

/** Coverage-gap items for one file (§7.2). Needs the raw content to scan
 *  section bodies — the ledger stores facts, not text. */
export function coverageGaps(
	facts: SpecFacts,
	content: string,
	file: string,
): AgendaItem[] {
	const out: AgendaItem[] = [];
	const lines = content.split("\n");
	for (const heading of facts.headings) {
		const template = KIND_TEMPLATES.find((t) => t.headingVocab.test(heading.text));
		if (!template) continue;
		const body = sectionText(facts, heading, lines);
		if (body.length < 400) continue; // stubs/sketches don't get the checklist yet
		const missing = template.concerns
			.filter((c) => !c.vocab.test(body))
			.map((c) => c.name);
		if (missing.length === 0) continue;
		out.push({
			kind: "coverage_gap",
			title: `"${heading.text}" (${template.kind}): no coverage found for {${missing.join(", ")}}`,
			detail: `A ${template.kind} spec usually must address these. State each where the artifact is defined, or note explicitly why it does not apply.`,
			sites: [`${file}:${heading.line}`],
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Compose-checks (§7.3): an entity (ID namespace or declared fact) bound
// from two or more files is a join the author must verify composes.
// ---------------------------------------------------------------------------

/** Compose-check items across the ledger's files. */
function composeChecks(
	filesFacts: Array<{ file: string; facts: SpecFacts }>,
): AgendaItem[] {
	const sitesByEntity = new Map<string, Set<string>>();
	for (const { file, facts } of filesFacts) {
		for (const ns of facts.namespaces) {
			const first = ns.ids[0]?.sites[0] ?? 1;
			addSite(sitesByEntity, `namespace ${ns.prefix}`, `${file}:${first}`);
		}
		for (const fact of facts.declaredFacts) {
			addSite(sitesByEntity, `fact:${fact.name}`, `${file}:${fact.line}`);
		}
	}
	const out: AgendaItem[] = [];
	for (const [entity, sites] of sitesByEntity) {
		const files = new Set([...sites].map((s) => s.split(":")[0]));
		if (files.size < 2) continue;
		out.push({
			kind: "compose_check",
			title: `${entity} is constrained from ${files.size} files — verify the constraints compose`,
			detail:
				"Each site was written against its own local picture. Read them together and confirm no pair contradicts (ordering, counts, ownership, retention).",
			sites: [...sites].slice(0, 6),
		});
	}
	return out;
}

function addSite(map: Map<string, Set<string>>, key: string, site: string): void {
	const set = map.get(key);
	if (set) set.add(site);
	else map.set(key, new Set([site]));
}

// ---------------------------------------------------------------------------
// Assembly + rendering
// ---------------------------------------------------------------------------

interface AgendaInput {
	ledger: SpecLedger;
	/** file → raw content, for section-body scans. */
	contents: Map<string, string>;
	/** Open review findings, already formatted as "file:line — message". */
	openFindings: string[];
}

/** Build the full agenda: joins, coverage gaps, drift, open findings. */
export function buildAgenda(input: AgendaInput): AgendaItem[] {
	const filesFacts: Array<{ file: string; facts: SpecFacts }> = [];
	const gaps: AgendaItem[] = [];
	for (const [file, content] of input.contents) {
		const facts = input.ledger.factsOf(file);
		if (!facts) continue;
		filesFacts.push({ file, facts });
		gaps.push(...coverageGaps(facts, content, file));
	}
	const drift: AgendaItem[] = input.ledger.computeDrift().map((f) => ({
		kind: "outstanding_drift" as const,
		title: f.message.slice(0, 160),
		detail: "Deterministic cross-file drift — resolve before the next review round.",
		sites: [`${f.file}:${f.line}`, ...f.relatedFiles.slice(0, 3)],
	}));
	return [...composeChecks(filesFacts), ...gaps, ...drift];
}

/** Render + write .interlinked/review-agenda.md. Returns the path. */
export function writeReviewAgenda(
	cwd: string,
	items: AgendaItem[],
	openFindings: string[],
): string {
	const path = join(cwd, ".interlinked", "review-agenda.md");
	// Create the .interlinked dir — a fresh repo has none yet (round-2 #31).
	mkdirSync(dirname(path), { recursive: true });
	const sections: string[] = [
		"# Review agenda (generated — do not edit)",
		"",
		"Deterministic discovery for the next reviewer (agent, Tier-3 run, or",
		"external audit): verify each item, or ack it with a reason. Questions,",
		"not verdicts — generated by `interlinked spec agenda`.",
		"",
	];
	const byKind: Array<[AgendaItem["kind"], string]> = [
		["compose_check", "## Compose-checks (multi-file constraints)"],
		["coverage_gap", "## Coverage gaps (contract templates)"],
		["outstanding_drift", "## Outstanding deterministic drift"],
	];
	for (const [kind, header] of byKind) {
		const rows = items.filter((i) => i.kind === kind);
		if (rows.length === 0) continue;
		sections.push(header, "");
		for (const item of rows) {
			sections.push(`- **${item.title}**`, `  ${item.detail}`, `  Sites: ${item.sites.join(", ")}`);
		}
		sections.push("");
	}
	if (openFindings.length > 0) {
		sections.push("## Open review findings (ingested, unreconciled)", "");
		for (const f of openFindings) sections.push(`- ${f}`);
		sections.push("");
	}
	writeFileSync(path, sections.join("\n"));
	return path;
}
