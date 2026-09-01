// ===========================================
// Case-divergence detector (cross-file, conservative buckets)
// ===========================================
// Flags the same logical identifier declared in two different CASE STYLES
// across the codebase — `userId` here, `user_id` there — so it can be
// reconciled to one spelling. This is a *consistency* check, NOT a convention
// enforcer: it never says "use camelCase", only "you spelled one name two
// ways."
//
// Conservative-bucket semantics — chosen to keep false positives near zero on
// a well-maintained codebase, where camelCase values, PascalCase types, and
// SCREAMING_SNAKE constants are *deliberately* different cases:
//   • Role buckets — VALUE symbols (function/const/let/var) and TYPE symbols
//     (class/interface/type/enum) are compared separately, so the idiomatic
//     `class Foo` + `const foo` instance pair never fires.
//   • SCREAMING_SNAKE is its own family — a SCREAMING constant and a camelCase
//     value sharing a core (`MAX_LINES` / `maxLines`) is the intentional
//     constant-vs-variable distinction, not a divergence. Two SCREAMING
//     spellings that differ only by separator (`USERID` / `USER_ID`) still fire.
//   • Leading underscores are significant — `_userId` / `userId` differ by a
//     deliberate private/unused marker, not by case.
//   • Internal `_` / `-` ARE folded — `user_id` ≡ `userId` ≡ `userid`.
//   • Cores shorter than MIN_CORE_LEN are ignored (coincidental collisions).
//
// Verify-only, advisory (runs under `interlinked verify --all-checks`),
// mirroring `registry-parity.ts`. Uses the optional `typescript` lib for
// accurate top-level extraction and no-ops when it is absent.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, relative } from "node:path";
import type * as TS from "typescript";
import { parseTsSourceWith } from "./checks/cyclomatic-ast.js";

type TsModule = typeof TS;
type TsRequirer = () => TsModule;

const defaultTsRequirer: TsRequirer = () =>
	createRequire(import.meta.url)("typescript") as TsModule;

let tsRequirer: TsRequirer = defaultTsRequirer;
let tsModuleCache: TsModule | null | undefined;

/** Resolve `typescript` once, synchronously, treating absence as a non-error. */
function loadTs(): TsModule | null {
	if (tsModuleCache !== undefined) return tsModuleCache;
	try {
		tsModuleCache = tsRequirer();
	} catch {
		tsModuleCache = null;
	}
	return tsModuleCache;
}

/** True when the optional `typescript` dep is resolvable (→ check is active). */
export function caseDivergenceAvailable(): boolean {
	return loadTs() !== null;
}

/** Test-only cache reset so a suite can exercise the present/absent paths. */
export function __resetTsCacheForTesting(): void {
	tsModuleCache = undefined;
}

/** Test-only: swap how `typescript` is resolved (pass null to restore the
 *  default). Lets the suite exercise the dependency-absent degrade path. */
export function __setTsRequirerForTesting(requirer: TsRequirer | null): void {
	tsRequirer = requirer ?? defaultTsRequirer;
	tsModuleCache = undefined;
}

/** Cores shorter than this are skipped — short collisions are coincidental. */
export const MIN_CORE_LEN = 3;

const JS_TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

export type SymbolKind =
	| "function"
	| "class"
	| "type"
	| "interface"
	| "enum"
	| "const"
	| "let"
	| "var";

type SymbolRole = "value" | "type";

type CaseStyle =
	| "camelCase"
	| "snake_case"
	| "PascalCase"
	| "SCREAMING_SNAKE"
	| "kebab-case"
	| "flatcase"
	| "other";

const ROLE: Record<SymbolKind, SymbolRole> = {
	function: "value",
	const: "value",
	let: "value",
	var: "value",
	class: "type",
	interface: "type",
	type: "type",
	enum: "type",
};

export interface SymbolLoc {
	name: string;
	kind: SymbolKind;
	file: string;
	line: number;
}

interface SpellingEntry {
	name: string;
	style: CaseStyle;
	locs: Array<{ file: string; line: number; kind: SymbolKind }>;
}

export interface CaseDivergenceFinding {
	core: string;
	role: SymbolRole;
	spellings: SpellingEntry[];
	message: string;
	/** Every file a divergent spelling appears in — fed to `allFlaggedFiles`. */
	files: string[];
}

/** Split leading underscores (significant) from the case-folded core. */
export function normalizeCore(name: string): { lead: string; core: string } {
	const leadMatch = /^_+/.exec(name);
	const lead = leadMatch ? leadMatch[0] : "";
	const core = name.slice(lead.length).replace(/[_-]/g, "").toLowerCase();
	return { lead, core };
}

/** Classify the case style of a name (leading underscores ignored). */
export function classifyStyle(name: string): CaseStyle {
	const s = name.replace(/^_+/, "");
	if (s.length === 0) return "other";
	if (s.includes("-")) return "kebab-case";
	const hasUpper = /[A-Z]/.test(s);
	const hasLower = /[a-z]/.test(s);
	// All-caps (digits/underscores allowed) → constant style.
	if (hasUpper && !hasLower && /^[A-Z0-9_]+$/.test(s)) return "SCREAMING_SNAKE";
	if (s.includes("_")) {
		// lowercase/digit segments joined by single underscores → snake_case.
		const segs = s.split("_");
		const isSnake = segs.every((seg) => seg.length > 0 && /^[a-z0-9]+$/.test(seg));
		return isSnake ? "snake_case" : "other";
	}
	if (/^[A-Z]/.test(s)) return "PascalCase";
	if (hasUpper) return "camelCase";
	return "flatcase";
}

function variableKind(ts: TsModule, flags: TS.NodeFlags): SymbolKind {
	if ((flags & ts.NodeFlags.Const) !== 0) return "const";
	if ((flags & ts.NodeFlags.Let) !== 0) return "let";
	return "var";
}

/** Extract module-top-level declared symbols (functions, classes, types,
 *  interfaces, enums, and each `const`/`let`/`var` binding) from one file. */
export function extractTopLevelSymbols(
	ts: TsModule,
	content: string,
	file: string,
): SymbolLoc[] {
	const sf = parseTsSourceWith(ts, content, file);
	const out: SymbolLoc[] = [];
	const lineOf = (node: TS.Node): number =>
		sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

	for (const stmt of sf.statements) {
		if (ts.isFunctionDeclaration(stmt) && stmt.name) {
			out.push({ name: stmt.name.text, kind: "function", file, line: lineOf(stmt) });
		} else if (ts.isClassDeclaration(stmt) && stmt.name) {
			out.push({ name: stmt.name.text, kind: "class", file, line: lineOf(stmt) });
		} else if (ts.isTypeAliasDeclaration(stmt)) {
			out.push({ name: stmt.name.text, kind: "type", file, line: lineOf(stmt) });
		} else if (ts.isInterfaceDeclaration(stmt)) {
			out.push({ name: stmt.name.text, kind: "interface", file, line: lineOf(stmt) });
		} else if (ts.isEnumDeclaration(stmt)) {
			out.push({ name: stmt.name.text, kind: "enum", file, line: lineOf(stmt) });
		} else if (ts.isVariableStatement(stmt)) {
			const kind = variableKind(ts, stmt.declarationList.flags);
			for (const d of stmt.declarationList.declarations) {
				if (ts.isIdentifier(d.name)) {
					out.push({ name: d.name.text, kind, file, line: lineOf(d) });
				}
			}
		}
	}
	return out;
}

interface SymbolGroup {
	role: SymbolRole;
	core: string;
	spellings: Map<string, SymbolLoc[]>;
}

function buildMessage(role: SymbolRole, names: readonly string[]): string {
	const quoted = names.map((n) => `"${n}"`).join(" / ");
	return `${quoted} — same ${role} name in ${names.length} case spellings; reconcile to one`;
}

function toFinding(group: SymbolGroup): CaseDivergenceFinding | null {
	const { role, core, spellings } = group;
	if (spellings.size < 2) return null;
	const names = [...spellings.keys()];
	const screaming = names.filter((n) => classifyStyle(n) === "SCREAMING_SNAKE");
	const regular = names.filter((n) => classifyStyle(n) !== "SCREAMING_SNAKE");
	// Flag the constant family and the non-constant family independently: a lone
	// SCREAMING constant beside a lone camelCase value is the intended const/var
	// split, not a divergence.
	const flagged = [
		...(regular.length >= 2 ? regular : []),
		...(screaming.length >= 2 ? screaming : []),
	].sort();
	if (flagged.length < 2) return null;

	const spellingEntries: SpellingEntry[] = flagged.map((name) => {
		const locs = (spellings.get(name) ?? [])
			.map((s) => ({ file: s.file, line: s.line, kind: s.kind }))
			.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
		return { name, style: classifyStyle(name), locs };
	});
	const files = [...new Set(spellingEntries.flatMap((e) => e.locs.map((l) => l.file)))].sort();
	return { core, role, spellings: spellingEntries, message: buildMessage(role, flagged), files };
}

/** Group symbols by (role, leading-underscores, case-folded core) and flag any
 *  group whose distinct spellings represent a genuine case divergence. Pure —
 *  exported for unit tests. */
export function analyzeSymbols(symbols: readonly SymbolLoc[]): CaseDivergenceFinding[] {
	const groups = new Map<string, SymbolGroup>();
	for (const s of symbols) {
		const { lead, core } = normalizeCore(s.name);
		if (core.length < MIN_CORE_LEN) continue;
		const role = ROLE[s.kind];
		const gk = `${role} ${lead} ${core}`;
		let group = groups.get(gk);
		if (!group) {
			group = { role, core, spellings: new Map() };
			groups.set(gk, group);
		}
		const locs = group.spellings.get(s.name);
		if (locs) locs.push(s);
		else group.spellings.set(s.name, [s]);
	}

	const findings: CaseDivergenceFinding[] = [];
	for (const group of groups.values()) {
		const finding = toFinding(group);
		if (finding) findings.push(finding);
	}
	findings.sort((a, b) => a.role.localeCompare(b.role) || a.core.localeCompare(b.core));
	return findings;
}

/** Should this discovered path be excluded from the scan? Vendored/built code,
 *  declaration files, and test files are out of scope. */
function isExcludedPath(rel: string): boolean {
	const p = rel.replace(/\\/g, "/");
	if (p.endsWith(".d.ts")) return true;
	if (/(^|\/)(node_modules|dist|reference-repos|coverage|\.git)\//.test(p)) return true;
	if (/(^|\/)__(tests|fixtures|mocks|snapshots)__\//.test(p)) return true;
	if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return true;
	return false;
}

/**
 * Public API — consumed by `verify.ts`. Walk the discovered JS/TS files,
 * extract top-level symbols, and return case-divergence findings. Returns an
 * empty array when `typescript` is unavailable (no-op, surfaced via
 * {@link caseDivergenceAvailable}).
 */
export function runCaseDivergenceCheck(
	cwd: string,
	files: readonly string[],
): CaseDivergenceFinding[] {
	const ts = loadTs();
	if (!ts) return [];
	const symbols: SymbolLoc[] = [];
	for (const abs of files) {
		if (!JS_TS_EXTS.has(extname(abs).toLowerCase())) continue;
		const rel = relative(cwd, abs);
		if (isExcludedPath(rel)) continue;
		let content: string;
		try {
			content = readFileSync(abs, "utf-8");
		} catch {
			continue;
		}
		for (const s of extractTopLevelSymbols(ts, content, rel)) symbols.push(s);
	}
	return analyzeSymbols(symbols);
}
