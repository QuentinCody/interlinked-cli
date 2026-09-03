// ===========================================
// Graph-prediction parser
// ===========================================
// Extracts `graph_prediction:` blocks from agent response text. The
// schema is fixed (see `docs/design/graph-prediction-protocol.md §6`),
// so we parse directly into the typed shape rather than going through
// a generic YAML library — interlinked-cli has no YAML dependency and
// the format is restricted enough that a focused parser is shorter and
// more reliable than the YAML-then-validate path.
//
// Format-validation rules (§6.3): predictions exceeding 50 entries per
// list-typed section are format violations and surface back to the
// agent as "narrow your top-K or use `unknown` for the long tail."

import { nonNull } from "../lib/non-null.js";
import {
	flowQuote,
	type KeyValueLine,
	type ListItemLine,
	parseCount,
	parseInlineValue,
	parseRisk,
	parseScalar,
	tokenizeKeyValue,
	tokenizeListItem,
} from "./graph-prediction-parser-scalars.js";

const FENCE_RE = /^```(?:ya?ml)?\s*$/;
const FENCE_END_RE = /^```\s*$/;

/** The literal sentinel agents use to express "I'm not asserting this
 *  field." Distinct from an empty list (`[]`), which asserts absence. */
const UNKNOWN_SENTINEL = "unknown" as const;
const TOP_LEVEL_KEY = "graph_prediction" as const;

type ParseStatus = "ok" | "format_violation" | "parse_failed";

export interface PredictionDeps {
	imports: string[] | "unknown";
	imported_by: string[] | "unknown";
}

export interface PredictionCalls {
	callers: string[] | "unknown";
	callees: string[] | "unknown";
}

export interface PredictionImpact {
	risk: "low" | "medium" | "high" | "unknown";
	domains: string[] | "unknown";
	direct: number | "unknown";
	transitive: number | "unknown";
	affects: string[] | "unknown";
}

export interface ParsedGraphPrediction {
	file: string;
	deps: PredictionDeps | null;
	calls: PredictionCalls | null;
	impact: PredictionImpact | null;
	parse_status: ParseStatus;
	parse_error?: string;
}

interface FenceBlock {
	body: string;
}

function extractFences(text: string): FenceBlock[] {
	const lines = text.split("\n");
	const blocks: FenceBlock[] = [];
	let i = 0;
	while (i < lines.length) {
		if (FENCE_RE.test(nonNull(lines[i]))) {
			const startIdx = i + 1;
			i++;
			while (i < lines.length && !FENCE_END_RE.test(nonNull(lines[i]))) i++;
			blocks.push({ body: lines.slice(startIdx, i).join("\n") });
			i++;
		} else {
			i++;
		}
	}
	return blocks;
}

function isPredictionBlock(body: string): boolean {
	return /^graph_prediction:\s*$/m.test(body);
}

interface SectionParse {
	value: string[] | "unknown";
	formatViolation: boolean;
}

function parseSection(rest: string, _blockLines: KeyValueLine[], _cursorIndent: number): SectionParse {
	if (rest === UNKNOWN_SENTINEL) return { value: UNKNOWN_SENTINEL, formatViolation: false };
	const inline = parseInlineValue(rest);
	if (Array.isArray(inline.value)) {
		return { value: inline.value, formatViolation: inline.formatViolation };
	}
	if (inline.value === UNKNOWN_SENTINEL) {
		return { value: UNKNOWN_SENTINEL, formatViolation: false };
	}
	return { value: [], formatViolation: false };
}

/** Parse a single graph_prediction block from bare YAML (no fences).
 *  Used by the sentinel-path submission flow where the agent writes the
 *  YAML directly as the content of a file — fences would be syntactic
 *  noise in a `.yaml` file. */
export function parseBarePrediction(yamlBody: string): ParsedGraphPrediction {
	return parseSinglePrediction(yamlBody);
}

/** Top-level parser entry. Returns one ParsedGraphPrediction per
 *  graph_prediction block found in the input text. Each result carries
 *  a `parse_status` so callers can distinguish ok / format_violation /
 *  parse_failed without exception handling. */
export function parseGraphPredictionsFromText(text: string): ParsedGraphPrediction[] {
	const fences = extractFences(text);
	const results: ParsedGraphPrediction[] = [];
	for (const fence of fences) {
		if (!isPredictionBlock(fence.body)) continue;
		results.push(parseSinglePrediction(fence.body));
	}
	return results;
}

interface ParserAccumulator {
	out: ParsedGraphPrediction;
	formatViolation: boolean;
	parseFailure: string | null;
}

function newAccumulator(): ParserAccumulator {
	return {
		out: { file: "", deps: null, calls: null, impact: null, parse_status: "ok" },
		formatViolation: false,
		parseFailure: null,
	};
}

interface TopLevelDispatchArgs {
	tokens: KeyValueLine[];
	idx: number;
	childIndent: number;
	acc: ParserAccumulator;
}

type TopLevelFieldParser = (args: TopLevelDispatchArgs) => number;

const FIELD_FILE = "file" as const;
const FIELD_DEPS = "deps" as const;
const FIELD_CALLS = "calls" as const;
const FIELD_IMPACT = "impact" as const;

const TOP_LEVEL_FIELD_PARSERS: ReadonlyMap<string, TopLevelFieldParser> = new Map([
	[
		FIELD_FILE,
		({ tokens, idx, acc }) => {
			const value = parseScalar(nonNull(tokens[idx]).rest);
			if (typeof value !== "string" || value === "") {
				acc.parseFailure = "file field missing or non-string";
			} else {
				acc.out.file = value;
			}
			return idx + 1;
		},
	],
	[
		FIELD_DEPS,
		({ tokens, idx, childIndent, acc }) =>
			applySubsection(parseDeps(tokens, idx, childIndent), acc, FIELD_DEPS),
	],
	[
		FIELD_CALLS,
		({ tokens, idx, childIndent, acc }) =>
			applySubsection(parseCalls(tokens, idx, childIndent), acc, FIELD_CALLS),
	],
	[
		FIELD_IMPACT,
		({ tokens, idx, childIndent, acc }) =>
			applySubsection(parseImpact(tokens, idx, childIndent), acc, FIELD_IMPACT),
	],
]);

function applySubsection(
	parsed: DepsParse | CallsParse | ImpactParse,
	acc: ParserAccumulator,
	field: typeof FIELD_DEPS | typeof FIELD_CALLS | typeof FIELD_IMPACT,
): number {
	if (field === FIELD_DEPS && FIELD_DEPS in parsed) acc.out.deps = parsed.deps;
	if (field === FIELD_CALLS && FIELD_CALLS in parsed) acc.out.calls = parsed.calls;
	if (field === FIELD_IMPACT && FIELD_IMPACT in parsed) acc.out.impact = parsed.impact;
	if (parsed.formatViolation) acc.formatViolation = true;
	return parsed.nextIndex;
}

function attachListItem(
	tokens: KeyValueLine[],
	item: ListItemLine,
): { ok: boolean; error?: string } {
	// Walk backwards looking for the parent in YAML block-style semantics:
	//   - First ancestor (indent < item.indent) with empty rest is the parent.
	//   - A key at the same indent as the item is a structural sibling, not a
	//     parent — reject (covers both "orphan dash" and "dash at same indent
	//     as a key:" ambiguities).
	//   - Deeper descendants (indent > item.indent) are skipped; they're valid
	//     intermediate state when a deeper section's children sit between us
	//     and our parent.
	for (let i = tokens.length - 1; i >= 0; i--) {
		const candidate = tokens[i];
		if (nonNull(candidate).indent === item.indent) {
			return {
				ok: false,
				error: `list item "${item.value}" at same indent as preceding key "${nonNull(candidate).key}"`,
			};
		}
		if (nonNull(candidate).indent < item.indent) {
			if (nonNull(candidate).rest !== "") {
				return {
					ok: false,
					error: `list item "${item.value}" under "${nonNull(candidate).key}" which already has a scalar value`,
				};
			}
			if (!nonNull(candidate).blockItems) nonNull(candidate).blockItems = [];
			nonNull(nonNull(candidate).blockItems).push(item.value);
			return { ok: true };
		}
	}
	return { ok: false, error: `orphan list item "${item.value}" — no parent key found` };
}

/** Tokenizes one raw source line into `tokens`, mutating it in place.
 *  Returns an error message if the line is malformed or can't attach
 *  to a parent, or `null` on success (including blank/comment lines,
 *  which are simply skipped). */
function tokenizeBodyLine(raw: string, tokens: KeyValueLine[]): string | null {
	if (raw.trim() === "" || raw.trim().startsWith("#")) return null;
	const kv = tokenizeKeyValue(raw);
	if (kv) {
		tokens.push(kv);
		return null;
	}
	const li = tokenizeListItem(raw);
	if (li) {
		const result = attachListItem(tokens, li);
		return result.ok ? null : (result.error ?? "list item attach failed");
	}
	return `malformed line: ${raw.trim().slice(0, 80)}`;
}

function tokenizeBody(body: string): { tokens: KeyValueLine[]; error: string | null } {
	const lines = body.split("\n");
	const tokens: KeyValueLine[] = [];
	for (const raw of lines) {
		const error = tokenizeBodyLine(raw, tokens);
		if (error) return { tokens, error };
	}
	// Post-process: synthesize a flow-list `rest` for any token with collected
	// blockItems so parseInlineValue treats both YAML forms uniformly.
	for (const tok of tokens) {
		if (tok.blockItems && tok.rest === "") {
			tok.rest = `[${tok.blockItems.map(flowQuote).join(", ")}]`;
		}
	}
	return { tokens, error: null };
}

function finalize(acc: ParserAccumulator): ParsedGraphPrediction {
	if (acc.parseFailure) {
		acc.out.parse_status = "parse_failed";
		acc.out.parse_error = acc.parseFailure;
		return acc.out;
	}
	if (acc.out.file === "") {
		acc.out.parse_status = "parse_failed";
		acc.out.parse_error = "file field missing";
		return acc.out;
	}
	if (acc.formatViolation) acc.out.parse_status = "format_violation";
	return acc.out;
}

function extractFilePartial(tokens: KeyValueLine[]): string {
	// Best-effort `file:` lookup over partial tokens. Lets parse_failed
	// predictions retain attribution so the fallback in pre-tool.ts can
	// match them back to a target and surface the error.
	for (const tok of tokens) {
		if (tok.key !== FIELD_FILE) continue;
		const value = parseScalar(tok.rest);
		if (typeof value === "string" && value !== "") return value;
	}
	return "";
}

function parseSinglePrediction(body: string): ParsedGraphPrediction {
	const { tokens, error } = tokenizeBody(body);
	if (error) {
		const file = extractFilePartial(tokens);
		return { ...failed(error), file };
	}
	if (tokens.length === 0 || nonNull(tokens[0]).key !== TOP_LEVEL_KEY) {
		return { ...failed(`missing ${TOP_LEVEL_KEY}: header`), file: extractFilePartial(tokens) };
	}
	const topIndent = nonNull(tokens[0]).indent;
	const childIndent = inferChildIndent(tokens, topIndent);
	if (childIndent === null) return failed(`no fields under ${TOP_LEVEL_KEY}`);

	const acc = newAccumulator();
	let i = 1;
	while (i < tokens.length) {
		const tok = tokens[i];
		if (nonNull(tok).indent !== childIndent) {
			i++;
			continue;
		}
		const parser = TOP_LEVEL_FIELD_PARSERS.get(nonNull(tok).key);
		i = parser ? parser({ tokens, idx: i, childIndent, acc }) : i + 1;
	}
	return finalize(acc);
}

function failed(reason: string): ParsedGraphPrediction {
	return {
		file: "",
		deps: null,
		calls: null,
		impact: null,
		parse_status: "parse_failed",
		parse_error: reason,
	};
}

function inferChildIndent(tokens: KeyValueLine[], topIndent: number): number | null {
	for (let i = 1; i < tokens.length; i++) {
		if (nonNull(tokens[i]).indent > topIndent) return nonNull(tokens[i]).indent;
	}
	return null;
}

interface DepsParse {
	deps: PredictionDeps;
	formatViolation: boolean;
	nextIndex: number;
}

interface SubFieldArgs<T> {
	state: T;
	rest: string;
	tokens: KeyValueLine[];
	indent: number;
}

type SubFieldApplier<T> = (args: SubFieldArgs<T>) => boolean;

interface SubsectionWalk<T> {
	state: T;
	formatViolation: boolean;
	nextIndex: number;
}

interface WalkSubsectionArgs<T> {
	tokens: KeyValueLine[];
	sectionIdx: number;
	parentIndent: number;
	initial: T;
	subfields: ReadonlyMap<string, SubFieldApplier<T>>;
}

function walkSubsection<T>(args: WalkSubsectionArgs<T>): SubsectionWalk<T> {
	const { tokens, sectionIdx, parentIndent, initial, subfields } = args;
	const childIndent = parentIndent + 2;
	let formatViolation = false;
	let i = sectionIdx + 1;
	while (i < tokens.length) {
		const tok = tokens[i];
		if (nonNull(tok).indent <= parentIndent) break;
		if (nonNull(tok).indent === childIndent) {
			const apply = subfields.get(nonNull(tok).key);
			if (apply) {
				const violated = apply({ state: initial, rest: nonNull(tok).rest, tokens, indent: childIndent });
				if (violated) formatViolation = true;
			}
		}
		i++;
	}
	return { state: initial, formatViolation, nextIndex: i };
}

/** Helper to keep the per-subfield closures small: take a list-shaped
 *  field and assign the parsed value, returning the format-violation
 *  flag in one expression. */
function assignListField<T>(
	state: T,
	args: SubFieldArgs<T>,
	assign: (s: T, value: string[] | typeof UNKNOWN_SENTINEL) => void,
): boolean {
	const r = parseSection(args.rest, args.tokens, args.indent);
	assign(state, r.value);
	return r.formatViolation;
}

const DEPS_SUBFIELDS: ReadonlyMap<string, SubFieldApplier<PredictionDeps>> = new Map([
	["imports", (a) => assignListField(a.state, a, (s, v) => { s.imports = v; })],
	["imported_by", (a) => assignListField(a.state, a, (s, v) => { s.imported_by = v; })],
]);

function parseDeps(tokens: KeyValueLine[], depsIdx: number, parentIndent: number): DepsParse {
	const r = walkSubsection<PredictionDeps>({
		tokens,
		sectionIdx: depsIdx,
		parentIndent,
		initial: { imports: [], imported_by: [] },
		subfields: DEPS_SUBFIELDS,
	});
	return { deps: r.state, formatViolation: r.formatViolation, nextIndex: r.nextIndex };
}

interface CallsParse {
	calls: PredictionCalls;
	formatViolation: boolean;
	nextIndex: number;
}

const CALLS_SUBFIELDS: ReadonlyMap<string, SubFieldApplier<PredictionCalls>> = new Map([
	["callers", (a) => assignListField(a.state, a, (s, v) => { s.callers = v; })],
	["callees", (a) => assignListField(a.state, a, (s, v) => { s.callees = v; })],
]);

function parseCalls(tokens: KeyValueLine[], callsIdx: number, parentIndent: number): CallsParse {
	const r = walkSubsection<PredictionCalls>({
		tokens,
		sectionIdx: callsIdx,
		parentIndent,
		initial: { callers: [], callees: [] },
		subfields: CALLS_SUBFIELDS,
	});
	return { calls: r.state, formatViolation: r.formatViolation, nextIndex: r.nextIndex };
}

interface ImpactParse {
	impact: PredictionImpact;
	formatViolation: boolean;
	nextIndex: number;
}

const IMPACT_SUBFIELDS: ReadonlyMap<string, SubFieldApplier<PredictionImpact>> = new Map([
	["risk", (a) => { a.state.risk = parseRisk(a.rest); return false; }],
	["domains", (a) => assignListField(a.state, a, (s, v) => { s.domains = v; })],
	["direct", (a) => { a.state.direct = parseCount(a.rest); return false; }],
	["transitive", (a) => { a.state.transitive = parseCount(a.rest); return false; }],
	["affects", (a) => assignListField(a.state, a, (s, v) => { s.affects = v; })],
]);

function parseImpact(
	tokens: KeyValueLine[],
	impactIdx: number,
	parentIndent: number,
): ImpactParse {
	const r = walkSubsection<PredictionImpact>({
		tokens,
		sectionIdx: impactIdx,
		parentIndent,
		initial: {
			risk: UNKNOWN_SENTINEL,
			domains: [],
			direct: UNKNOWN_SENTINEL,
			transitive: UNKNOWN_SENTINEL,
			affects: [],
		},
		subfields: IMPACT_SUBFIELDS,
	});
	return { impact: r.state, formatViolation: r.formatViolation, nextIndex: r.nextIndex };
}
