// SQL schema checks — real implementations of three checks that shipped as
// registry stubs from v0.1.0 until 2026-08-09 (`compat-stubs.ts`, all bodies
// `return []`). The Check Evidence Contract exposed the gap: no honest
// MUST-FIRE case could be written for any of them.
//
// All three share one evidence source: schema declared IN THE SAME FILE.
// Firing always requires positive proof (a same-file CREATE TABLE whose
// column list demonstrably lacks the referenced column). Cross-file schemas
// yield silence, never guesses — that is what makes `migration_ordering`
// safe at pre_block.
//
//   migration_ordering        pre_block  CREATE INDEX on a column the same-file
//                                        CREATE TABLE does not declare. The
//                                        Durable Objects migration bug: CREATE
//                                        TABLE IF NOT EXISTS is a no-op for an
//                                        existing table, so a column added in a
//                                        later release is absent when the same
//                                        block's CREATE INDEX runs on a fresh
//                                        install. Declaring sources: CREATE
//                                        TABLE columns, ALTER TABLE ADD COLUMN,
//                                        addColumnIfNotExists("t","col",...).
//   sql_schema_consistency    pre_warn   INSERT column lists / UPDATE SET
//                                        targets naming columns the same-file
//                                        schema does not declare. Only the
//                                        unambiguous reference forms — no
//                                        SELECT/JOIN/alias resolution.
//   visibility_filter_missing pre_warn   SELECT from a table whose same-file
//                                        schema has a soft-delete column
//                                        (archived_at / deleted_at /
//                                        is_archived / is_deleted) with no
//                                        mention of that column in the
//                                        statement. Heuristic by design
//                                        (partially_deterministic).
//
// Suppression: the standard `// interlinked-ignore: <check> — reason`
// directive, honored at the gate layer for every check id. The detectors
// carry no suppression logic of their own.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isVendoredOrFixturePath,
	JS_TS_EXTS,
} from "./shared.js";

const MATCH_LIMIT = 10;

const SOFT_DELETE_COLUMNS = ["archived_at", "deleted_at", "is_archived", "is_deleted"];

/** Table-level constraint openers inside a CREATE TABLE column list. */
const TABLE_CONSTRAINT_KEYWORDS = new Set(["primary", "unique", "check", "foreign", "constraint"]);

/** True for files these checks read: JS/TS sources and raw .sql files. */
function isSqlBearingFile(filePath: string): boolean {
	const ext = getExtension(filePath);
	return JS_TS_EXTS.has(ext) || ext === ".sql";
}

/** Shared per-file gate: wrong file type, tests, and vendored trees are silent. */
function skipFile(filePath: string): boolean {
	return !isSqlBearingFile(filePath) || isTestFile(filePath) || isVendoredOrFixturePath(filePath);
}

/**
 * Blank out whole-line comments (`//`, `--`, `#`, `*`, `/*`) so commented-out
 * SQL never matches, while preserving line numbering. Inline trailing comments
 * are left alone — every finding also requires same-file schema proof, so a
 * stray mention in a trailing comment cannot fire on its own.
 */
function blankCommentLines(content: string): string {
	return content
		.split("\n")
		.map((line) => {
			const t = line.trimStart();
			const isComment =
				t.startsWith("//") ||
				t.startsWith("--") ||
				t.startsWith("#") ||
				t.startsWith("*") ||
				t.startsWith("/*");
			return isComment ? "" : line;
		})
		.join("\n");
}

/** Strip SQL/JS identifier quoting: `"col"`, `` `col` ``, `[col]`. */
function unquoteIdentifier(raw: string): string {
	return raw.replace(/^[`"[]+/, "").replace(/[`"\]]+$/, "");
}

/** 1-based line number of a character offset. */
function lineOfOffset(content: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < content.length; i++) {
		if (content.charCodeAt(i) === 10) line++;
	}
	return line;
}

/** Split a CREATE TABLE body on commas at paren depth zero. */
function topLevelSegments(body: string): string[] {
	const segments: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "," && depth === 0) {
			segments.push(body.slice(start, i));
			start = i + 1;
		}
	}
	segments.push(body.slice(start));
	return segments;
}

/** The column a CREATE TABLE segment declares, or null for table constraints. */
function segmentColumnName(segment: string): string | null {
	const m = /^\s*([`"[]?[A-Za-z_][\w$]*[`"\]]?)/.exec(segment);
	if (!m?.[1]) return null;
	const name = unquoteIdentifier(m[1]).toLowerCase();
	return TABLE_CONSTRAINT_KEYWORDS.has(name) ? null : name;
}

/** Body of the paren group opening at `openIdx`, or null when unbalanced. */
function parenGroupBody(text: string, openIdx: number): string | null {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return text.slice(openIdx + 1, i);
		}
	}
	return null;
}

/** Same-file schema evidence: declared columns per table, and created tables. */
interface FileSchema {
	/** table (lowercase) → declared columns (lowercase), from all sources. */
	columns: Map<string, Set<string>>;
	/** Tables with a literal CREATE TABLE in this file. */
	created: Set<string>;
}

function declare(schema: FileSchema, table: string, column: string): void {
	const set = schema.columns.get(table) ?? new Set<string>();
	set.add(column);
	schema.columns.set(table, set);
}

const CREATE_TABLE_RE =
	/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([`"[]?[A-Za-z_][\w$]*[`"\]]?)\s*\(/gi;
const ALTER_ADD_RE =
	/\balter\s+table\s+([`"[]?[A-Za-z_][\w$]*[`"\]]?)\s+add\s+(?:column\s+)?([`"[]?[A-Za-z_][\w$]*[`"\]]?)/gi;
const ADD_COLUMN_HELPER_RE =
	/\baddColumnIfNotExists\s*\(\s*(['"`])([\w$]+)\1\s*,\s*(['"`])([\w$]+)\3/g;

/** Record every CREATE TABLE (name + column list) into the schema. */
function collectCreateTables(text: string, schema: FileSchema): void {
	for (const m of text.matchAll(CREATE_TABLE_RE)) {
		const table = unquoteIdentifier(m[1] ?? "").toLowerCase();
		const body = parenGroupBody(text, m.index + m[0].length - 1);
		if (!table || body === null) continue;
		schema.created.add(table);
		for (const segment of topLevelSegments(body)) {
			const column = segmentColumnName(segment);
			if (column) declare(schema, table, column);
		}
	}
}

/** Record ALTER TABLE ... ADD COLUMN and addColumnIfNotExists() declarations. */
function collectColumnAdditions(text: string, schema: FileSchema): void {
	for (const m of text.matchAll(ALTER_ADD_RE)) {
		const table = unquoteIdentifier(m[1] ?? "").toLowerCase();
		const column = unquoteIdentifier(m[2] ?? "").toLowerCase();
		if (table && column && column !== "constraint") declare(schema, table, column);
	}
	for (const m of text.matchAll(ADD_COLUMN_HELPER_RE)) {
		declare(schema, (m[2] ?? "").toLowerCase(), (m[4] ?? "").toLowerCase());
	}
}

/** Collect every column-declaring construct in the (comment-blanked) content. */
function buildFileSchema(text: string): FileSchema {
	const schema: FileSchema = { columns: new Map(), created: new Set() };
	collectCreateTables(text, schema);
	collectColumnAdditions(text, schema);
	return schema;
}

/**
 * Push one finding, bounded by the match cap. Suppression is NOT handled here:
 * the standard `// interlinked-ignore: <check> — reason` directive is honored
 * at the gate layer for every check id, so detectors stay suppression-free.
 */
function pushFinding(matches: InlineMatch[], originalLines: string[], line: number): void {
	if (matches.length >= MATCH_LIMIT) return;
	const original = originalLines[line - 1] ?? "";
	matches.push({ line, text: original.trim().slice(0, 150) });
}

const CREATE_INDEX_RE =
	/\bcreate\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?[`"[]?[\w$]+[`"\]]?\s+on\s+([`"[]?[A-Za-z_][\w$]*[`"\]]?)\s*\(([^()]*)\)/gi;

/**
 * `migration_ordering` — CREATE INDEX on a column the same-file CREATE TABLE
 * does not declare (and no ALTER / addColumnIfNotExists declares either).
 * Expression indexes (parens in the column list) never fire. pre_block / error.
 */
export function checkMigrationOrdering(content: string, filePath: string): InlineMatch[] {
	if (skipFile(filePath)) return [];
	const text = blankCommentLines(content);
	const schema = buildFileSchema(text);
	if (schema.created.size === 0) return [];
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (const m of text.matchAll(CREATE_INDEX_RE)) {
		const table = unquoteIdentifier(m[1] ?? "").toLowerCase();
		if (!schema.created.has(table)) continue;
		const declared = schema.columns.get(table) ?? new Set<string>();
		const referenced = (m[2] ?? "")
			.split(",")
			.map((c) => unquoteIdentifier(c.trim().split(/\s+/)[0] ?? "").toLowerCase())
			.filter((c) => c.length > 0);
		if (referenced.length === 0) continue;
		if (referenced.every((c) => declared.has(c))) continue;
		pushFinding(matches, originalLines, lineOfOffset(text, m.index));
	}
	return matches;
}

const INSERT_RE =
	/\binsert\s+(?:or\s+\w+\s+)?into\s+([`"[]?[A-Za-z_][\w$]*[`"\]]?)\s*\(([^()]*)\)/gi;
const UPDATE_RE = /\bupdate\s+([`"[]?[A-Za-z_][\w$]*[`"\]]?)\s+set\s+/gi;
const SET_TARGET_RE = /(?:^|,)\s*[`"[]?([A-Za-z_][\w$]*)[`"\]]?\s*=/g;

/** SET-clause text: from after SET to the first WHERE / `;` / backtick. */
function setClauseText(text: string, from: number): string {
	const rest = text.slice(from);
	const end = rest.search(/\bwhere\b|;|`/i);
	return end === -1 ? rest : rest.slice(0, end);
}

/** INSERT statements whose column list names an undeclared column. */
function insertViolations(text: string, schema: FileSchema): number[] {
	const offsets: number[] = [];
	for (const m of text.matchAll(INSERT_RE)) {
		const table = unquoteIdentifier(m[1] ?? "").toLowerCase();
		if (!schema.created.has(table)) continue;
		const declared = schema.columns.get(table) ?? new Set<string>();
		const listed = (m[2] ?? "")
			.split(",")
			.map((c) => unquoteIdentifier(c.trim()).toLowerCase())
			.filter((c) => /^[a-z_][\w$]*$/.test(c));
		if (listed.length === 0 || listed.every((c) => declared.has(c))) continue;
		offsets.push(m.index);
	}
	return offsets;
}

/** UPDATE statements whose SET targets include an undeclared column. */
function updateViolations(text: string, schema: FileSchema): number[] {
	const offsets: number[] = [];
	for (const m of text.matchAll(UPDATE_RE)) {
		const table = unquoteIdentifier(m[1] ?? "").toLowerCase();
		if (!schema.created.has(table)) continue;
		const declared = schema.columns.get(table) ?? new Set<string>();
		const clause = setClauseText(text, m.index + m[0].length);
		const targets = [...clause.matchAll(SET_TARGET_RE)]
			.map((t) => (t[1] ?? "").toLowerCase())
			.filter((t) => t.length > 0);
		if (targets.length === 0 || targets.every((t) => declared.has(t))) continue;
		offsets.push(m.index);
	}
	return offsets;
}

/**
 * `sql_schema_consistency` — INSERT column lists and UPDATE SET targets naming
 * columns absent from the same-file schema. Deliberately narrow: only the
 * forms where every referenced name is a literal column. pre_warn / warning.
 */
export function checkSqlSchemaConsistency(content: string, filePath: string): InlineMatch[] {
	if (skipFile(filePath)) return [];
	const text = blankCommentLines(content);
	const schema = buildFileSchema(text);
	if (schema.created.size === 0) return [];
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const offsets = [...insertViolations(text, schema), ...updateViolations(text, schema)].sort(
		(a, b) => a - b,
	);
	for (const offset of offsets) {
		pushFinding(matches, originalLines, lineOfOffset(text, offset));
	}
	return matches;
}

const SELECT_FROM_RE = /\bselect\b[^;`]*?\bfrom\s+([`"[]?[A-Za-z_][\w$]*[`"\]]?)/gi;

/** Statement extent for filter search: to the first `;` / backtick, capped. */
function statementExtent(text: string, from: number): string {
	const rest = text.slice(from, from + 600);
	const end = rest.search(/;|`/);
	return end === -1 ? rest : rest.slice(0, end);
}

/**
 * `visibility_filter_missing` — SELECT from a table whose same-file schema
 * declares a soft-delete column, with no mention of any soft-delete column in
 * the statement. Heuristic: an intentional include-archived query is expected
 * to name the column (or suppress with interlinked-ignore). pre_warn / warning.
 */
export function checkVisibilityFilterMissing(content: string, filePath: string): InlineMatch[] {
	if (skipFile(filePath)) return [];
	const text = blankCommentLines(content);
	const schema = buildFileSchema(text);
	if (schema.created.size === 0) return [];
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (const m of text.matchAll(SELECT_FROM_RE)) {
		const table = unquoteIdentifier(m[1] ?? "").toLowerCase();
		if (!schema.created.has(table)) continue;
		const declared = schema.columns.get(table) ?? new Set<string>();
		if (!SOFT_DELETE_COLUMNS.some((c) => declared.has(c))) continue;
		const statement = statementExtent(text, m.index).toLowerCase();
		if (SOFT_DELETE_COLUMNS.some((c) => statement.includes(c))) continue;
		pushFinding(matches, originalLines, lineOfOffset(text, m.index));
	}
	return matches;
}
