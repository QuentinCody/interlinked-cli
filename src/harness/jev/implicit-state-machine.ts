// Jev check — implicit state machines.
//
// FIRST MEASUREMENT (2026-11-03, this repo only, n = 23, ONE blind labeler —
// scratch/2026-11-03-prompts-eval/H-jev-eval.md): over every scope with ≥ 3
// lifecycle fields (firing or excluded), `one_lifecycle` separates the blind
// labels with AUROC 0.951 (11 machines / 12 not); at P ≥ 0.5 precision 10/11,
// recall 10/11. The selector's later exclusions (`few-multi-writer-fields`,
// `no-async-writer`) dropped 6 of the 11 labeled machines, so the selector alone
// is 5/6 precise and 5/11 complete. One repo and one labeler are NOT an
// operating point: nothing here thresholds a probability. Findings carry the
// raw `one_lifecycle` noul and the raw choice distribution, and every formatted
// line says so. `impossible_combination` chose `none` on 20/23 and is not a
// usable signal at this packet size. Internal runner only (`jev state-machines`),
// never in the registry or `interlinked verify` (feedback_harness_deterministic_only).
//
// Two layers (design: scratch/2026-11-03-prompts-eval/A-state-machines.md):
//   1. Deterministic SELECTOR (`implicit-state-machine-select.ts`): scopes with
//      ≥ 3 lifecycle fields, ≥ 2 multi-writer fields and an async writer. Plus
//      the deterministic stale-handle sub-check (`-stale.ts`), which needs no
//      model at all.
//   2. Jev packet + two questions per candidate — the semantic residue an AST
//      cannot decide: are these fields ONE lifecycle, and which combination does
//      the code's own documentation or naming rule out?
// Measured on this repo's tree (2026-11-03, builder-adjudicated, see
// scratch/2026-11-03-prompts-eval/G-selector-build.md): the strict selector
// flags 2 scopes, both report positives (recall 2/10); the `nullableSlots`
// variant flags 6, 5 of them report positives (recall 5/10).

import type { JevClient } from "./client.js";
import type { StateMachineCandidate } from "./implicit-state-machine-select.js";
import { type Combination, type LifecycleField, selectStateMachineCandidates } from "./implicit-state-machine-select.js";
import type { SelectOptions } from "./implicit-state-machine-model.js";
import type { StaleHandleFinding } from "./implicit-state-machine-stale.js";
import type { WriterSite } from "./implicit-state-machine-writes.js";
import type { JevChoiceQuestion, JevEntry, JevNoulQuestion, JevQuestion } from "./types.js";

export {
	type Combination,
	explainStateMachineScopes,
	type LifecycleField,
	type ScopeVerdict,
	selectStateMachineCandidates,
	type StateMachineCandidate,
	stateMachineSelectorAvailable,
} from "./implicit-state-machine-select.js";
export { detectStaleHandleHandlers, type StaleHandleFinding } from "./implicit-state-machine-stale.js";

/** Packet ceiling for one candidate (bytes of JSON). */
export const STATE_MACHINE_PACKET_MAX_BYTES = 4096;
/** Lines of each writer unit kept in the source excerpt. */
const MAX_UNIT_LINES = 14;

export interface StateMachineFinding {
	scope: string;
	scopeKind: StateMachineCandidate["scopeKind"];
	line: number;
	/** Raw probability that the fields encode one lifecycle. */
	oneLifecycle: number;
	impossible: {
		choice: string;
		/** The chosen combination as `field=value, …`; null for `none` or an unknown id. */
		combination: string | null;
		probabilities: Record<string, number>;
		confidence: number;
	};
}

const ONE_LIFECYCLE: JevNoulQuestion = {
	type: "noul",
	instructions: {
		question: "Do these fields encode ONE lifecycle, so that some combinations must never occur?",
		focus:
			"Fields that move together through one process (spawn, ready, closing, closed; idle, running, idle) are one lifecycle. Independent flags that only share a scope (a re-entrancy guard beside a stop latch, a debounce timer, a cached value) are not.",
	},
	criteria: {
		true: { what: "The fields are stages of one process; some value combinations contradict each other" },
		false: { what: "The fields are independent; every combination is a legal state" },
	},
};

const IMPOSSIBLE_COMBINATION: JevChoiceQuestion = {
	type: "choice",
	instructions: "Which combination does the code's own documentation or naming say is impossible?",
	criteria: { none: "No listed combination is ruled out by the code's comments or names" },
};

/** The two questions; `impossible_combination` gains one option per enumerated combination in `stateMachineQuestionsFor`. */
export const STATE_MACHINE_QUESTIONS: Record<string, JevQuestion> = {
	one_lifecycle: ONE_LIFECYCLE,
	impossible_combination: IMPOSSIBLE_COMBINATION,
};

export function describeCombination(c: Combination): string {
	return Object.entries(c.values)
		.map(([field, value]) => `${field}=${value}`)
		.join(", ");
}

export function stateMachineQuestionsFor(c: StateMachineCandidate): Record<string, JevQuestion> {
	const criteria: Record<string, JevEntry> = {};
	for (const combo of c.combinations) criteria[combo.id] = describeCombination(combo);
	return {
		one_lifecycle: ONE_LIFECYCLE,
		impossible_combination: { ...IMPOSSIBLE_COMBINATION, criteria: { ...criteria, ...IMPOSSIBLE_COMBINATION.criteria } },
	};
}

// ---- packet -----------------------------------------------------------------

function siteText(s: WriterSite): string {
	return `${s.unit}:${s.line}=${s.value}${s.async ? ` [${s.async}]` : ""}${s.via ? ` via ${s.via}` : ""}`;
}

function fieldRow(f: LifecycleField, writerCap: number): JevEntry {
	return { name: f.name, kind: f.kind, type: f.type, writers: f.writerSites.slice(0, writerCap).map(siteText), async_writer: f.asyncWriter, latch: f.latch };
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function packetBase(c: StateMachineCandidate, level: { writers: number; doc: number; assigned: number; fields: number }): Record<string, JevEntry> {
	return {
		file: c.file,
		scope: c.scope,
		scope_kind: c.scopeKind,
		line: c.line,
		doc: clip(c.doc ?? "", level.doc),
		fields: c.fields.slice(0, level.fields).map((f) => fieldRow(f, level.writers)),
		combinations: c.combinations.map((x) => {
			const by = x.assignedBy.slice(0, level.assigned);
			return `${x.id}: ${describeCombination(x)}${by.length > 0 ? ` (assigned by ${by.join(", ")})` : ""}`;
		}),
		omitted_from_combinations: c.omittedFromCombinations,
	};
}

/** Shrink writer lists and assignments before the doc: the doc is the evidence the second question reads. */
const PACKET_LEVELS = [
	{ writers: 8, doc: 800, assigned: 4, fields: 12 },
	{ writers: 4, doc: 800, assigned: 2, fields: 12 },
	{ writers: 2, doc: 600, assigned: 1, fields: 10 },
	{ writers: 1, doc: 400, assigned: 0, fields: 8 },
];

/** The richest base (no source yet) that leaves at least a quarter of the budget for the excerpt. */
function fitBase(c: StateMachineCandidate): Record<string, JevEntry> {
	for (const level of PACKET_LEVELS) {
		const base = packetBase(c, level);
		if (JSON.stringify(base).length <= STATE_MACHINE_PACKET_MAX_BYTES * 0.75) return base;
	}
	return packetBase(c, { writers: 0, doc: 200, assigned: 0, fields: 6 });
}

function sourceExcerpt(c: StateMachineCandidate, content: string): string {
	const lines = content.split("\n");
	const tidy = (l: string | undefined): string => (l ?? "").replace(/\t/g, "  ").trimEnd();
	const out = ["// lifecycle fields", ...new Set(c.fields.map((f) => tidy(lines[f.line - 1]).trim()))];
	for (const u of [...c.units].sort((a, b) => a.start - b.start)) {
		const end = Math.min(u.end, u.start + MAX_UNIT_LINES - 1);
		out.push(`// ${u.name} (L${u.start})`, ...lines.slice(u.start - 1, end).map(tidy));
		if (end < u.end) out.push("  // …");
	}
	return out.join("\n");
}

function fitText(text: string, room: number): string {
	let t = text;
	for (let i = 0; i < 8 && JSON.stringify(t).length > room; i++) {
		const ratio = room / JSON.stringify(t).length;
		t = `${t.slice(0, Math.max(0, Math.floor(t.length * ratio) - 8))}…`;
	}
	return JSON.stringify(t).length > room ? "" : t;
}

/** Deterministic Jev state for one candidate, ≤ STATE_MACHINE_PACKET_MAX_BYTES of JSON. */
export function buildStateMachinePacket(c: StateMachineCandidate, content: string): Record<string, JevEntry> {
	const base = fitBase(c);
	const room = STATE_MACHINE_PACKET_MAX_BYTES - JSON.stringify({ ...base, source: "" }).length;
	return { ...base, source: fitText(sourceExcerpt(c, content), room) };
}

// ---- scoring ----------------------------------------------------------------

async function scoreCandidate(client: JevClient, c: StateMachineCandidate, content: string): Promise<StateMachineFinding | null> {
	const res = await client.ask(buildStateMachinePacket(c, content), stateMachineQuestionsFor(c));
	const one = res?.answers.one_lifecycle;
	const imp = res?.answers.impossible_combination;
	if (!one || one.type !== "noul" || !imp || imp.type !== "choice") return null;
	const combo = c.combinations.find((x) => x.id === imp.choice);
	return {
		scope: c.scope,
		scopeKind: c.scopeKind,
		line: c.line,
		oneLifecycle: one.noul,
		impossible: { choice: imp.choice, combination: combo ? describeCombination(combo) : null, probabilities: imp.probabilities, confidence: imp.confidence },
	};
}

/** One Jev call per selected candidate (packets differ, so calls cannot batch). Raw answers; no threshold. */
export async function scoreStateMachines(client: JevClient, file: string, content: string, options: SelectOptions = {}): Promise<StateMachineFinding[]> {
	const findings: StateMachineFinding[] = [];
	for (const c of selectStateMachineCandidates(content, file, options)) {
		const f = await scoreCandidate(client, c, content);
		if (f) findings.push(f);
	}
	return findings;
}

// ---- formatting -------------------------------------------------------------

export function formatStateMachineFindings(file: string, findings: readonly StateMachineFinding[]): string[] {
	return findings.map((f) => {
		const choice = f.impossible.combination ? `${f.impossible.choice} (${f.impossible.combination})` : f.impossible.choice;
		return `[interlinked:jev-state-machine] [heuristic] ${file}:${f.line} ${f.scope} — one-lifecycle p=${f.oneLifecycle.toFixed(2)}; impossible: ${choice} @${f.impossible.confidence.toFixed(2)} (operating point UNMEASURED)`;
	});
}

export function formatStateMachineCandidates(file: string, candidates: readonly StateMachineCandidate[]): string[] {
	return candidates.map((c) => {
		const fields = c.fields.map((f) => `${f.name}(${f.kind}, ${f.writers} writer${f.writers === 1 ? "" : "s"}${f.asyncWriter ? ", async" : ""}${f.latch ? ", latch" : ""})`);
		return `[interlinked:state-machine-candidate] [heuristic] ${file}:${c.line} ${c.scopeKind} ${c.scope} — ${fields.join(", ")}; ${c.combinations.length} combination(s)`;
	});
}

export function formatStaleHandleFindings(file: string, findings: readonly StaleHandleFinding[]): string[] {
	return findings.map(
		(f) =>
			`[interlinked:stale-handle] [heuristic] ${file}:${f.line} ${f.scope} — \`${f.event}\` handler on \`${f.handle}\` writes ${f.writes.join(", ")} with no identity guard; \`${f.field}\` gets a new handle at :${f.reassignedAt.join(", :")}`,
	);
}
