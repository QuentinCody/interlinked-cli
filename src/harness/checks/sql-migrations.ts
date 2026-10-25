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

import { nonNull } from "../../lib/non-null.js";
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
 * A `/* … *\/` block comment. The opener counts only when a space, newline or
 * `*` follows it, so a glob such as `src/**\/*.ts` or a route `/api/*` inside a
 * string never opens one (the H2 audit's rest-of-file-vanishes misread).
 */
const BLOCK_COMMENT_RE = /\/\*(?=[\s*])[\s\S]*?\*\//g;

/** A trailing `-- …` SQL comment. Needs whitespace before it: `i--` is a decrement. */
const TRAILING_SQL_COMMENT_RE = /(^|\s)--.*$/;

/**
 * Blank out comments so commented-out SQL never matches, while preserving line
 * numbering: whole comment lines (`//`, `--`, `#`, `*`, `/*`), block comments
 * (same-length spaces, newlines kept) and trailing `-- …` comments. Trailing
 * comments matter inside a CREATE TABLE body: a comma in one split the column
 * list and a `)` in one closed it, so the column after the comment read as
 * undeclared (adversarial review 2026-10-21, N3 / N8 / N10 / N4).
 */
function blankCommentLines(content: string): string {
	return content
		.replace(BLOCK_COMMENT_RE, (comment) => comment.replace(/[^\n]/g, " "))
		.split("\n")
		.map((line) => {
			const t = line.trimStart();
			const isComment =
				t.startsWith("//") ||
				t.startsWith("--") ||
				t.startsWith("#") ||
				t.startsWith("*") ||
				t.startsWith("/*");
			return isComment ? "" : line.replace(TRAILING_SQL_COMMENT_RE, "$1");
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
const ALTER_TABLE_RE =
	/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([`"[]?[A-Za-z_][\w$]*[`"\]]?)/gi;
/**
 * One ADD clause: `ADD [COLUMN] [IF NOT EXISTS] col` or the MySQL/Oracle
 * `ADD [COLUMN] (a T, b T)` list. Group 1 is the COLUMN keyword, 2 the list, 3 the name.
 */
const ADD_CLAUSE_RE =
	/\badd\s+(column\s+)?(?:if\s+not\s+exists\s+)?(?:\(([^()]*(?:\([^()]*\)[^()]*)*)\)|([`"[]?[A-Za-z_][\w$]*[`"\]]?))/gi;
/** `RENAME TO new` — a table rename; the new name carries the old table's columns. */
const RENAME_TABLE_RE = /^\s*rename\s+to\s+([`"[]?[A-Za-z_][\w$]*[`"\]]?)/i;
/** `RENAME [COLUMN] old TO new` — the new name is a declared column from then on. */
const RENAME_COLUMN_RE =
	/\brename\s+(?:column\s+)?[`"[]?[A-Za-z_][\w$]*[`"\]]?\s+to\s+([`"[]?[A-Za-z_][\w$]*[`"\]]?)/gi;
/**
 * A column helper call such as `addColumnIfNotExists("t", "col", …)`,
 * `ensureColumn(sql, "t", "col")` or `add_column(db, 't', 'col')`: any callee
 * whose name contains "column", with an optional leading handle argument.
 * Group 1 is the argument text after the handle.
 */
const ADD_COLUMN_HELPER_RE =
	/\b[A-Za-z_$][\w$]*column[\w$]*\s*\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?((['"`])[\w$]+\2[^)]*)\)/gi;
/** Identifier-shaped string literals in a helper's argument text. */
const HELPER_LITERAL_RE = /(['"`])([\w$]+)\1/g;
/** `ADD <keyword> …` forms that add a constraint or index, not a column. */
const NON_COLUMN_ADD_TARGETS = new Set([
	"constraint",
	"index",
	"key",
	"unique",
	"primary",
	"foreign",
	"check",
	"fulltext",
	"spatial",
]);
/** Postgres copies columns the file cannot see: `(LIKE parent …)` and `… INHERITS (parent)`. */
const LIKE_SEGMENT_RE = /^\s*like\b/i;
const INHERITS_SUFFIX_RE = /^\)\s*inherits\b/i;

/** True when the CREATE TABLE body cannot prove a column absent. */
function isIncompleteTableBody(text: string, openIdx: number, body: string): boolean {
	// Interpolated columns are unknown, not demonstrably absent.
	if (body.includes("${")) return true;
	// A body built by string concatenation (`"(" + COLS.join(", ") + ")"`) is unknown too.
	if (/["'`]\s*\+|\+\s*["'`]/.test(body)) return true;
	if (topLevelSegments(body).some((segment) => LIKE_SEGMENT_RE.test(segment))) return true;
	const closeIdx = openIdx + 1 + body.length;
	return INHERITS_SUFFIX_RE.test(text.slice(closeIdx, closeIdx + 24));
}

/** Record every CREATE TABLE (name + column list) into the schema. */
function collectCreateTables(text: string, schema: FileSchema): void {
	const incomplete = new Set<string>();
	for (const m of text.matchAll(CREATE_TABLE_RE)) {
		const table = unquoteIdentifier(m[1] ?? "").toLowerCase();
		const openIdx = m.index + m[0].length - 1;
		const body = parenGroupBody(text, openIdx);
		if (!table || body === null) continue;
		if (isIncompleteTableBody(text, openIdx, body)) {
			incomplete.add(table);
			continue;
		}
		schema.created.add(table);
		for (const segment of topLevelSegments(body)) {
			const column = segmentColumnName(segment);
			if (column) declare(schema, table, column);
		}
	}
	for (const table of incomplete) {
		schema.created.delete(table);
		schema.columns.delete(table);
	}
}

/**
 * One ALTER TABLE statement's clause text: to `;`, a statement keyword, or
 * 2000 chars. `ON DELETE` / `ON UPDATE` are foreign-key actions, not statements.
 */
function alterClauseText(text: string, from: number): string {
	const rest = text.slice(from, from + 2000);
	const end = rest.search(/;|\b(?:create|alter|insert|select)\b|(?<!\bon\s+)\b(?:update|delete)\b/i);
	return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The column a single-name ADD clause adds, or null for `ADD CONSTRAINT|INDEX|KEY …`.
 * A quoted name is always a column. After the COLUMN keyword only the reserved
 * constraint openers stay excluded, so non-reserved `key` / `index` are column names.
 */
function addClauseColumn(hasColumnKeyword: boolean, raw: string): string | null {
	const column = unquoteIdentifier(raw).toLowerCase();
	if (raw !== unquoteIdentifier(raw)) return column;
	const excluded = hasColumnKeyword ? TABLE_CONSTRAINT_KEYWORDS : NON_COLUMN_ADD_TARGETS;
	return excluded.has(column) ? null : column;
}

/** Every column an ALTER TABLE statement adds or renames to. Multi-ADD and paren lists included. */
function alterDeclaredColumns(clause: string): string[] {
	const columns: string[] = [];
	for (const add of clause.matchAll(ADD_CLAUSE_RE)) {
		if (add[2] !== undefined) {
			for (const segment of topLevelSegments(add[2])) {
				const column = segmentColumnName(segment);
				if (column) columns.push(column);
			}
			continue;
		}
		const column = addClauseColumn(add[1] !== undefined, nonNull(add[3]));
		if (column) columns.push(column);
	}
	for (const rename of clause.matchAll(RENAME_COLUMN_RE)) {
		const column = unquoteIdentifier(rename[1] ?? "").toLowerCase();
		if (column) columns.push(column);
	}
	return columns;
}

/** Forget a table's columns: the file can no longer prove any of them absent. */
function markUnknown(schema: FileSchema, table: string): void {
	schema.created.delete(table);
	schema.columns.delete(table);
}

/** `ALTER TABLE old RENAME TO table`: the new name carries the old columns, or becomes unknown. */
function applyTableRename(schema: FileSchema, from: string, to: string): void {
	if (!schema.created.has(from)) {
		markUnknown(schema, to);
		return;
	}
	for (const column of schema.columns.get(from) ?? []) declare(schema, to, column);
}

/** Record ALTER TABLE ADD / RENAME and column-helper declarations. */
function collectColumnAdditions(text: string, schema: FileSchema): void {
	const unknown = new Set<string>();
	for (const m of text.matchAll(ALTER_TABLE_RE)) {
		const table = unquoteIdentifier(nonNull(m[1])).toLowerCase();
		const clause = alterClauseText(text, m.index + m[0].length);
		// An interpolated clause (`ADD COLUMN ${name} ${type}`) adds columns the file cannot name.
		if (clause.includes("${")) unknown.add(table);
		const renamed = RENAME_TABLE_RE.exec(clause)?.[1];
		if (renamed) applyTableRename(schema, table, unquoteIdentifier(renamed).toLowerCase());
		for (const column of alterDeclaredColumns(clause)) declare(schema, table, column);
	}
	for (const m of text.matchAll(ADD_COLUMN_HELPER_RE)) {
		const [table, ...columns] = [...(m[1] ?? "").matchAll(HELPER_LITERAL_RE)].map((l) => (l[2] ?? "").toLowerCase());
		for (const column of columns) if (table) declare(schema, table, column);
	}
	for (const table of unknown) markUnknown(schema, table);
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
		// An interpolated column list is unknown, not demonstrably absent.
		if ((m[2] ?? "").includes("${")) continue;
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
