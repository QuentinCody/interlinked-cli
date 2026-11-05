// ===========================================
// Kill proof — test cases as the SOURCE declares them
// ===========================================
// The Stop check and the PostToolUse nudge must name the cases an edit ADDED to a
// mutation-directed test file, in the form vitest will report them, so a receipt
// can be asked "did every new case kill?". A regex over the source text could not
// do that (kill-proof review round 4, M4/M5/M6/M7): it read `/re/.test("…")` as a
// case, stopped at the first `)` of an `it.each` table, kept source escapes that
// vitest resolves, saw a `%i` format string as a literal title, and could not tell
// a rename from a swap. This module walks the TypeScript AST instead:
//
//   - a case is a CALL whose callee chain starts at a bare `it` / `test`
//     identifier (never a property of something else, so `.test(` is not one),
//     optionally through `.only` / `.skip` / `.todo` / `.concurrent` / … and the
//     configuring calls `.each(...)`, `.each\`…\``, `.for(...)`, `.skipIf(...)`,
//     `.runIf(...)`, `.extend(...)`; an alias `const t = test.extend(...)` counts;
//   - `describe` / `suite` ancestors contribute their titles, joined with spaces,
//     exactly as vitest's `fullName`;
//   - a string title is its COOKED value (`"says \"max\""` is `says "max"`); an
//     identifier bound once to a string literal in the file resolves to it;
//   - an `.each` title with a `%i` / `%s` / `$n` placeholder, or a template with
//     substitutions, is a PREFIX FAMILY: the literal text before the first
//     placeholder. A family is certified only when every recorded case under that
//     prefix killed and at least one exists — a residual limit: the family also
//     covers an old case that happens to share the prefix;
//   - anything else (a computed title, a non-literal describe) is UNRESOLVABLE:
//     it is counted as a case and can never be certified by name, so the file
//     stays flagged until the title is literal;
//   - every case carries a BODY HASH (its table and callback text, whitespace
//     collapsed). A case whose title is new but whose body equals a removed
//     case's is a RENAME and makes no new claim; a new title with a new body is
//     a new case even when the file did not grow (review M6).
//
// Without `typescript` installed the walk degrades to a literal-title regex
// (callee head only, `.test(` excluded, no ancestors, no body hashes) and says
// nothing more precise than it can.

import { createHash } from "node:crypto";
import type * as TS from "typescript";
import { getExtension } from "../checks/shared.js";
import { loadTsModule, type TsModule } from "../mutation/differential-fuzz-deps.js";
import type { CaseVerdict } from "./types.js";

/** What a receipt must show for one case the source declares. */
export type CaseRequirement =
	| { kind: "exact"; name: string }
	| { kind: "prefix"; prefix: string; source: string }
	| { kind: "unresolvable"; source: string };

export interface SourceCase {
	requirement: CaseRequirement;
	/** sha256 over the configuring table (if any) and the callback text, whitespace collapsed; "" when neither exists. */
	bodyHash: string;
	line: number;
}

const TEST_HEADS = new Set(["it", "test"]);
const DESCRIBE_HEADS = new Set(["describe", "suite"]);
const MODIFIERS = new Set(["only", "skip", "todo", "concurrent", "sequential", "fails", "shuffle"]);
/** A call on the chain that configures the opener; the opener is the call AFTER it. */
const CONFIGURING = new Set(["each", "for", "skipIf", "runIf", "extend"]);
/** vitest's `%` placeholders (`%%` is a literal percent) and `$prop` object-row interpolation. */
const PLACEHOLDER_RE = /%[sdifjo#]|\$[A-Za-z_$]/;

export function requirementLabel(req: CaseRequirement): string {
	if (req.kind === "exact") return req.name;
	if (req.kind === "prefix") return `${req.source} (every case named "${req.prefix}…")`;
	return `${req.source} (title is not a literal)`;
}

/** Stable identity of a requirement for before/after matching. */
function requirementKey(req: CaseRequirement): string {
	return req.kind === "exact" ? `=${req.name}` : req.kind === "prefix" ? `^${req.prefix}\u0000${req.source}` : `?${req.source}`;
}

/**
 * Does the receipt's case list cover this requirement? Exact: every recorded row with
 * that full name is killed (a weak duplicate of a strong case is not certified, review
 * M3) and one exists. Prefix: the same over every row that starts with the prefix.
 * Unresolvable: never.
 */
export function requirementCovered(req: CaseRequirement, rows: ReadonlyArray<{ name: string; verdict: CaseVerdict }>): boolean {
	if (req.kind === "unresolvable") return false;
	const matching = req.kind === "exact" ? rows.filter(row => row.name === req.name) : rows.filter(row => row.name.startsWith(req.prefix));
	return matching.length > 0 && matching.every(row => row.verdict === "killed");
}

const hashBody = (parts: readonly string[]): string => (parts.length === 0 ? "" : createHash("sha256").update(parts.map(part => part.replace(/\s+/g, " ").trim()).join("\u0000")).digest("hex"));

// ---- AST walk ----

interface Head { root: string; modifiers: string[]; configured: boolean; tables: TS.Node[] }

/** The callee chain of a call, or null when it does not start at a bare identifier. */
function resolveHead(ts: TsModule, expr: TS.Expression): Head | null {
	if (ts.isIdentifier(expr)) return { root: expr.text, modifiers: [], configured: false, tables: [] };
	if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
		const inner = resolveHead(ts, expr.expression);
		return inner === null ? null : { ...inner, modifiers: [...inner.modifiers, expr.name.text] };
	}
	if (ts.isCallExpression(expr)) {
		const inner = resolveHead(ts, expr.expression);
		if (inner === null || !CONFIGURING.has(inner.modifiers[inner.modifiers.length - 1] ?? "")) return null;
		return { ...inner, configured: true, tables: [...inner.tables, ...expr.arguments] };
	}
	if (ts.isTaggedTemplateExpression(expr)) {
		const inner = resolveHead(ts, expr.tag);
		if (inner === null || inner.modifiers[inner.modifiers.length - 1] !== "each") return null;
		return { ...inner, configured: true, tables: [...inner.tables, expr.template] };
	}
	return null;
}

/** Whether `call` OPENS a block (test or describe) — not a configuring call on the way to one. */
function openerKind(ts: TsModule, call: TS.CallExpression, aliases: ReadonlySet<string>): { kind: "test" | "describe"; head: Head } | null {
	const head = resolveHead(ts, call.expression);
	if (head === null) return null;
	const last = head.modifiers[head.modifiers.length - 1];
	// `it.each([...])` itself, `it.skipIf(c)` itself: the opener is the call around it.
	if (!head.configured && last !== undefined && CONFIGURING.has(last)) return null;
	if (head.modifiers.some(name => !MODIFIERS.has(name) && !CONFIGURING.has(name))) return null;
	if (TEST_HEADS.has(head.root) || (aliases.has(head.root) && head.modifiers.length === 0)) return { kind: "test", head };
	if (DESCRIBE_HEADS.has(head.root)) return { kind: "describe", head };
	return null;
}

type Title = { kind: "literal"; text: string } | { kind: "template"; prefix: string; source: string } | { kind: "unresolvable"; source: string };

function resolveTitle(ts: TsModule, sf: TS.SourceFile, node: TS.Expression | undefined, consts: ReadonlyMap<string, string | null>): Title {
	if (node === undefined) return { kind: "unresolvable", source: "(no title)" };
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: "literal", text: node.text };
	if (ts.isTemplateExpression(node)) return { kind: "template", prefix: node.head.text, source: node.getText(sf) };
	if (ts.isIdentifier(node)) {
		const bound = consts.get(node.text);
		if (typeof bound === "string") return { kind: "literal", text: bound };
	}
	return { kind: "unresolvable", source: node.getText(sf) };
}

/** `%%` before the first placeholder is a literal percent in vitest's formatting. */
const literalPercent = (text: string): string => text.replace(/%%/g, "%");

function requirementFor(title: Title, ancestors: ReadonlyArray<string | null>, each: boolean): CaseRequirement {
	if (ancestors.some(name => name === null)) return { kind: "unresolvable", source: title.kind === "literal" ? title.text : title.source };
	const names = ancestors.filter((name): name is string => name !== null);
	const join = (tail: string): string => [...names, tail].join(" ");
	if (title.kind === "unresolvable") return { kind: "unresolvable", source: title.source };
	if (title.kind === "template") return title.prefix.length === 0 ? { kind: "unresolvable", source: title.source } : { kind: "prefix", prefix: join(title.prefix), source: title.source };
	if (each) {
		const match = PLACEHOLDER_RE.exec(title.text);
		if (match !== null) {
			const prefix = literalPercent(title.text.slice(0, match.index));
			return prefix.length === 0 ? { kind: "unresolvable", source: title.text } : { kind: "prefix", prefix: join(prefix), source: title.text };
		}
		return { kind: "exact", name: join(literalPercent(title.text)) };
	}
	return { kind: "exact", name: join(title.text) };
}

/** Identifiers bound exactly once to a string literal anywhere in the file (null = bound more than once, ambiguous). */
function stringConsts(ts: TsModule, sf: TS.SourceFile): Map<string, string | null> {
	const out = new Map<string, string | null>();
	const visit = (node: TS.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			const init = node.initializer;
			const value = init !== undefined && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) ? init.text : null;
			out.set(node.name.text, out.has(node.name.text) ? null : value);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

/** `const t = test.extend({...})` / `it.extend(...)`: `t(...)` opens a case. */
function extendAliases(ts: TsModule, sf: TS.SourceFile): Set<string> {
	const out = new Set<string>();
	const visit = (node: TS.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && ts.isCallExpression(node.initializer)) {
			const head = resolveHead(ts, node.initializer.expression);
			if (head !== null && TEST_HEADS.has(head.root) && head.modifiers[head.modifiers.length - 1] === "extend") out.add(node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

function scriptKind(ts: TsModule, filePath: string): TS.ScriptKind {
	const ext = getExtension(filePath);
	if (ext === ".tsx") return ts.ScriptKind.TSX;
	if (ext === ".jsx") return ts.ScriptKind.JSX;
	return ext.startsWith(".ts") || ext === ".mts" || ext === ".cts" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function walkCases(ts: TsModule, sf: TS.SourceFile): SourceCase[] {
	const consts = stringConsts(ts, sf), aliases = extendAliases(ts, sf), out: SourceCase[] = [];
	const visit = (node: TS.Node, ancestors: ReadonlyArray<string | null>): void => {
		if (ts.isCallExpression(node)) {
			const opener = openerKind(ts, node, aliases);
			if (opener !== null) {
				const title = resolveTitle(ts, sf, node.arguments[0], consts);
				const each = opener.head.modifiers.includes("each") || opener.head.modifiers.includes("for");
				if (opener.kind === "describe") {
					// A `describe.each` title is formatted per row: its cases cannot be named from the source.
					const name = title.kind === "literal" && !each ? title.text : null;
					ts.forEachChild(node, child => visit(child, [...ancestors, name]));
					return;
				}
				const body = node.arguments[1];
				const parts = [...opener.head.tables.map(table => table.getText(sf)), ...(body === undefined ? [] : [body.getText(sf)])];
				out.push({ requirement: requirementFor(title, ancestors, each), bodyHash: hashBody(parts), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
			}
		}
		ts.forEachChild(node, child => visit(child, ancestors));
	};
	visit(sf, []);
	return out;
}

// ---- degraded route (no typescript) ----

const FALLBACK_RE = /(?<![.\w$])(?:it|test)(?:\.(?:only|skip|todo|concurrent|sequential|fails))*\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

function cookedLiteral(raw: string, quote: string): string {
	if (quote === "`") return raw;
	try {
		return JSON.parse(`"${raw.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string;
	} catch {
		return raw;
	}
}

function fallbackCases(text: string): SourceCase[] {
	const out: SourceCase[] = [];
	for (const match of text.matchAll(FALLBACK_RE)) {
		const title = cookedLiteral(match[2] ?? "", match[1] ?? '"');
		if (title.length === 0) continue;
		out.push({ requirement: { kind: "exact", name: title }, bodyHash: "", line: text.slice(0, match.index).split("\n").length });
	}
	return out;
}

/** Every case the file declares, in source order. */
export function sourceCases(text: string, filePath: string): SourceCase[] {
	const ts = loadTsModule();
	if (ts === null) return fallbackCases(text);
	const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true, scriptKind(ts, filePath));
	return walkCases(ts, sf);
}

export interface NewCases {
	/** Cases present now that make a NEW claim (not in the baseline by identity, and not a rename). */
	added: SourceCase[];
	/** Cases whose title changed but whose body equals a removed case's: no new claim. */
	renamed: number;
}

/**
 * The cases `current` adds over `baseline` (review M6: the Stop check and the nudge
 * share this one rule). Identity is the requirement (full name / prefix family /
 * title source) as a MULTISET, so a duplicated title is one more case; a leftover
 * case whose body hash equals a removed case's is a rename.
 */
export function newCases(current: string, baseline: string, filePath: string): NewCases {
	const before = new Map<string, number>();
	const removed: SourceCase[] = [];
	const baseCases = sourceCases(baseline, filePath);
	for (const item of baseCases) before.set(requirementKey(item.requirement), (before.get(requirementKey(item.requirement)) ?? 0) + 1);
	const candidates: SourceCase[] = [];
	for (const item of sourceCases(current, filePath)) {
		const key = requirementKey(item.requirement), left = before.get(key) ?? 0;
		if (left > 0) before.set(key, left - 1);
		else candidates.push(item);
	}
	for (const item of baseCases) {
		const key = requirementKey(item.requirement), left = before.get(key) ?? 0;
		if (left > 0) {
			before.set(key, left - 1);
			removed.push(item);
		}
	}
	const added: SourceCase[] = [];
	let renamed = 0;
	for (const item of candidates) {
		const twin = item.bodyHash === "" ? -1 : removed.findIndex(old => old.bodyHash === item.bodyHash);
		if (twin >= 0) {
			removed.splice(twin, 1);
			renamed++;
		} else added.push(item);
	}
	return { added, renamed };
}
