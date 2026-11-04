// Semantic graph — Haiku confirmation of the top slice of proposed edges.
//
// Jev ranks; a generative model with the two texts in front of it reads the
// top few percent and says whether the relationship holds. Haiku 5.5 at low
// effort is the ONLY LLM arm this module may name (campaign rule; Opus and
// Astra adjudicate only). The runner is injected so tests never spawn a
// process; `defaultHaikuRunner` shells to `claude -p`.
//
// Verdict discipline: the reply must quote one of the two texts VERBATIM. A
// quote that is not a substring of either text downgrades the verdict to
// `undecided` while the quote is kept for audit. This is the tool-free
// adjudicator weakness from the nomination-repair study
// (research/semantic-factory, Funcy nomination-to-repair): a model with no
// tool to re-read the text paraphrases, and a paraphrase cannot be checked
// against the source, so it earns no verdict.

import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Confirmation, Edge, EdgeState, RelationshipType, Unit } from "./types.js";

export const HAIKU_MODEL = "claude-haiku-5-5";
/** Characters of each text placed in the prompt. */
export const CONFIRM_TEXT_CAP = 3_000;
export const HAIKU_TIMEOUT_MS = 120_000;
export const HAIKU_MAX_BUFFER = 8 * 1024 * 1024;
export const DEFAULT_CONFIRM_CONCURRENCY = 2;
export const DEFAULT_CONFIRM_FRACTION = 0.05;
export const DEFAULT_CONFIRM_MIN = 5;

export type HaikuRunner = (prompt: string) => Promise<string>;

export type ConfirmVerdict = Confirmation["verdict"];

const VERDICTS: ReadonlySet<string> = new Set<ConfirmVerdict>(["supported", "contradicted", "undecided"]);

/** The `--output-format json` envelope's `result` string; "" on any other shape. */
export function parseHaikuEnvelope(stdout: string): string {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "";
		const result = (parsed as { result?: unknown }).result;
		return typeof result === "string" ? result : "";
	} catch {
		return "";
	}
}

export const HAIKU_ARGS: readonly string[] = ["-p", "--model", HAIKU_MODEL, "--effort", "low", "--output-format", "json"];

let emptyCwd: string | null = null;

/**
 * The working directory `claude -p` is spawned in: a private empty temp
 * directory, created once per process. `claude -p` loads every CLAUDE.md
 * reachable from its cwd into the system prompt, so spawning from a repo root
 * bills that prose on EVERY call (measured 2026-10-27 in interlinked-cli: ~94k
 * cached tokens, $0.095 per call, against $0.006 from an empty directory —
 * unit F2, research/semantic-factory/semantic-graph-v1/F2-REPORT.md).
 */
export function haikuRunnerCwd(): string {
	emptyCwd ??= mkdtempSync(join(tmpdir(), "interlinked-haiku-"));
	return emptyCwd;
}

/** Spawn `claude -p` on Haiku with the prompt on stdin, from `haikuRunnerCwd()`. Any failure is "" (undecided downstream). */
export const defaultHaikuRunner: HaikuRunner = (prompt) =>
	new Promise((resolve) => {
		const options = { cwd: haikuRunnerCwd(), timeout: HAIKU_TIMEOUT_MS, maxBuffer: HAIKU_MAX_BUFFER, encoding: "utf8" as const };
		const child = execFile("claude", [...HAIKU_ARGS], options, (err, stdout) => {
			resolve(err ? "" : parseHaikuEnvelope(stdout));
		});
		child.on("error", () => resolve(""));
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(prompt);
	});

function cap(text: string): string {
	return text.length > CONFIRM_TEXT_CAP ? text.slice(0, CONFIRM_TEXT_CAP) : text;
}

export function buildConfirmPrompt(type: RelationshipType, source: Unit, target: Unit): string {
	return [
		`Relationship type "${type.name}": ${type.description}`,
		`Question: ${type.question}`,
		`A decision model proposed that the SOURCE (${source.kind}) has this relationship to the TARGET (${target.kind}).`,
		"Decide whether the two texts support that, contradict it, or leave it undecided.",
		"",
		`SOURCE ${source.id}:`,
		"<<<",
		cap(source.text),
		">>>",
		"",
		`TARGET ${target.id}:`,
		"<<<",
		cap(target.text),
		">>>",
		"",
		"Answer with ONE JSON object and nothing else:",
		'{"verdict":"supported"|"contradicted"|"undecided","evidence":"<verbatim quote from one of the two texts>"}',
		"The evidence must be copied character-for-character from the SOURCE or the TARGET text; a paraphrase is not evidence.",
	].join("\n");
}

interface ConfirmReply {
	verdict: ConfirmVerdict;
	evidence: string;
}

/** Constructing parser for the model's reply; tolerates prose around the first `{...}` object. */
export function parseConfirmationReply(raw: string): ConfirmReply | null {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const { verdict, evidence } = parsed as { verdict?: unknown; evidence?: unknown };
	if (typeof verdict !== "string" || !VERDICTS.has(verdict) || typeof evidence !== "string") return null;
	return { verdict: verdict as ConfirmVerdict, evidence };
}

function isVerbatim(evidence: string, source: Unit, target: Unit): boolean {
	return evidence.length > 0 && (source.text.includes(evidence) || target.text.includes(evidence));
}

async function runSafely(runner: HaikuRunner, prompt: string): Promise<string> {
	try {
		return await runner(prompt);
	} catch {
		return "";
	}
}

/** Ask Haiku once about one edge. Never throws; an unusable reply is `undecided`. */
export async function confirmEdge(
	runner: HaikuRunner,
	_edge: Edge,
	source: Unit,
	target: Unit,
	type: RelationshipType,
	now: () => string,
): Promise<Confirmation> {
	const reply = parseConfirmationReply(await runSafely(runner, buildConfirmPrompt(type, source, target)));
	const evidence = reply?.evidence ?? "";
	// A verdict stands only on a quote that can be re-read in the texts (see header).
	const verdict: ConfirmVerdict = reply && isVerbatim(evidence, source, target) ? reply.verdict : "undecided";
	return { model: HAIKU_MODEL, verdict, evidence, confirmed_at: now() };
}

/**
 * The top slice by `p` among proposed edges with a target: `max(min,
 * ceil(fraction * n))` edges, never more than are eligible.
 */
export function selectForConfirmation(edges: readonly Edge[], fraction = DEFAULT_CONFIRM_FRACTION, min = DEFAULT_CONFIRM_MIN): Edge[] {
	const eligible = edges.filter((e) => e.state === "proposed" && e.target !== null).sort((a, b) => b.p - a.p);
	const take = Math.min(eligible.length, Math.max(min, Math.ceil(fraction * eligible.length)));
	return eligible.slice(0, take);
}

export interface ConfirmManyOptions {
	/** Parallel runner invocations; default 2. */
	concurrency?: number;
	/** Hard ceiling on runner calls; edges beyond it are returned unchanged. */
	maxCalls: number;
}

export interface ConfirmManyResult {
	/** Same order as the input; confirmed edges carry `confirmation` and a new state. */
	edges: Edge[];
	calls: number;
	/** Edges returned unchanged: unresolved units or type, or over `maxCalls`. */
	skipped: number;
}

const STATE_FOR_VERDICT: Record<ConfirmVerdict, EdgeState> = {
	supported: "confirmed",
	contradicted: "contradicted",
	undecided: "proposed",
};

interface ResolvedEdge {
	source: Unit;
	target: Unit;
	type: RelationshipType;
}

function resolve(edge: Edge, lookup: (id: string) => Unit | undefined, types: ReadonlyMap<string, RelationshipType>): ResolvedEdge | null {
	if (edge.target === null) return null;
	const source = lookup(edge.source);
	const target = lookup(edge.target);
	const type = types.get(edge.type);
	return source && target && type ? { source, target, type } : null;
}

/** Confirm a selected slice with bounded concurrency and a call ceiling; input edges are not mutated. */
export async function confirmMany(
	runner: HaikuRunner,
	selected: readonly Edge[],
	lookup: (id: string) => Unit | undefined,
	types: readonly RelationshipType[],
	opts: ConfirmManyOptions,
	now: () => string = () => new Date().toISOString(),
): Promise<ConfirmManyResult> {
	const byName = new Map(types.map((t) => [t.name, t]));
	const out: Edge[] = selected.map((e) => ({ ...e }));
	let next = 0;
	let calls = 0;
	let skipped = 0;
	const worker = async (): Promise<void> => {
		while (next < out.length) {
			const i = next++;
			const edge = out[i];
			const resolved = edge ? resolve(edge, lookup, byName) : null;
			if (!edge || !resolved || calls >= opts.maxCalls) {
				skipped++;
				continue;
			}
			calls++;
			const confirmation = await confirmEdge(runner, edge, resolved.source, resolved.target, resolved.type, now);
			out[i] = { ...edge, confirmation, state: STATE_FOR_VERDICT[confirmation.verdict] };
		}
	};
	const width = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONFIRM_CONCURRENCY, out.length));
	await Promise.all(Array.from({ length: width }, worker));
	return { edges: out, calls, skipped };
}
