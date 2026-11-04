// Semantic graph — relationship types. Reads `.interlinked/semantic-relationships.json`
// with a strict constructing parser (unknown keys rejected, every field validated,
// duplicate names refused) and carries the three seed types used when the file is
// absent. Contract: ./types.ts (never edited here).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import {
	type CandidateRule,
	RELATIONSHIPS_FILE,
	type RelationshipsFile,
	type RelationshipType,
	type ScopeConfig,
	type UnitKind,
} from "./types.js";

/** Candidates per source unit: the contract's 2..12 bound. */
export const K_MIN = 2;
export const K_MAX = 12;

const UNIT_KINDS: readonly UnitKind[] = ["function", "doc_comment", "test", "doc_section"];
const CANDIDATE_RULES: readonly CandidateRule[] = [
	"same_file",
	"import_edge",
	"name_match",
	"co_change",
	"companion",
];
const FILE_KEYS: ReadonlySet<string> = new Set(["version", "scope", "relationships"]);
const SCOPE_KEYS: ReadonlySet<string> = new Set(["include", "exclude"]);

/** Seed scope: product source plus the top-level docs; vendored, generated, and
 *  session-local trees are out (the first live run drew 109k units from
 *  `research/`, `scratch/` and `.claude/` markdown). */
export const DEFAULT_SCOPE: Required<ScopeConfig> = {
	include: ["src/**", "docs/*.md", "README.md", "CLAUDE.md"],
	exclude: ["**/node_modules/**", "dist/**", "scratch/**", "research/**", ".claude/**", ".interlinked/**"],
};
const TYPE_KEYS: ReadonlySet<string> = new Set([
	"name",
	"description",
	"source_kind",
	"target_kind",
	"question",
	"none_description",
	"candidate_rules",
	"k",
]);

/** Seed types: used verbatim when no relationships file exists. */
export const DEFAULT_RELATIONSHIPS: RelationshipsFile = {
	version: 1,
	scope: structuredClone(DEFAULT_SCOPE),
	relationships: [
		{
			name: "promises",
			description: "A documentation section promises a behaviour that a function implements.",
			source_kind: "doc_section",
			target_kind: "function",
			question: "Which function implements the behaviour this documentation section promises?",
			none_description: "No candidate function implements what the section promises.",
			candidate_rules: ["name_match", "co_change", "import_edge"],
			k: 8,
		},
		{
			name: "pins",
			description: "A test's assertions check the behaviour of a function.",
			source_kind: "test",
			target_kind: "function",
			question: "Which function's behaviour do this test's assertions check?",
			none_description: "The assertions check none of the candidate functions.",
			candidate_rules: ["companion", "name_match", "import_edge"],
			k: 8,
		},
		{
			name: "constrains",
			description: "Two functions enforce the same rule, limit, or invariant without one calling the other.",
			source_kind: "function",
			target_kind: "function",
			question:
				"Which other function enforces the same rule, limit, or invariant as this one, without calling it?",
			none_description: "No candidate shares a rule, limit, or invariant with this function.",
			candidate_rules: ["name_match", "co_change", "same_file"],
			k: 8,
		},
	],
};

function fail(path: string, message: string): never {
	throw new Error(`${path}: ${message}`);
}

function rejectUnknownKeys(
	row: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	where: string,
	path: string,
): void {
	for (const key of Object.keys(row)) {
		if (!allowed.has(key)) fail(path, `${where}: unknown key "${key}"`);
	}
}

function requireString(row: Record<string, unknown>, key: string, where: string, path: string): string {
	const value = row[key];
	if (typeof value !== "string" || value.trim() === "") {
		fail(path, `${where}: "${key}" must be a non-empty string`);
	}
	return value;
}

function parseKind(row: Record<string, unknown>, key: string, where: string, path: string): UnitKind {
	const value = requireString(row, key, where, path);
	const kind = UNIT_KINDS.find((candidate) => candidate === value);
	if (kind === undefined) fail(path, `${where}: "${key}" must be one of ${UNIT_KINDS.join(", ")}; got "${value}"`);
	return kind;
}

function parseRules(row: Record<string, unknown>, where: string, path: string): CandidateRule[] {
	const value = row.candidate_rules;
	if (!Array.isArray(value) || value.length === 0) {
		fail(path, `${where}: "candidate_rules" must be a non-empty array`);
	}
	const rules: CandidateRule[] = [];
	for (const entry of value) {
		const rule = CANDIDATE_RULES.find((candidate) => candidate === entry);
		if (rule === undefined) {
			fail(path, `${where}: "candidate_rules" entry ${JSON.stringify(entry)} is not one of ${CANDIDATE_RULES.join(", ")}`);
		}
		if (!rules.includes(rule)) rules.push(rule);
	}
	return rules;
}

function parseK(row: Record<string, unknown>, where: string, path: string): number {
	const value = row.k;
	if (typeof value !== "number" || !Number.isInteger(value) || value < K_MIN || value > K_MAX) {
		fail(path, `${where}: "k" must be an integer in ${K_MIN}..${K_MAX}; got ${JSON.stringify(value)}`);
	}
	return value;
}

function parseRelationship(raw: unknown, index: number, path: string): RelationshipType {
	const where = `relationships[${index}]`;
	if (!isJsonObject(raw)) fail(path, `${where}: must be an object`);
	rejectUnknownKeys(raw, TYPE_KEYS, where, path);
	return {
		name: requireString(raw, "name", where, path),
		description: requireString(raw, "description", where, path),
		source_kind: parseKind(raw, "source_kind", where, path),
		target_kind: parseKind(raw, "target_kind", where, path),
		question: requireString(raw, "question", where, path),
		none_description: requireString(raw, "none_description", where, path),
		candidate_rules: parseRules(raw, where, path),
		k: parseK(raw, where, path),
	};
}

function parseGlobList(row: Record<string, unknown>, key: string, path: string): string[] | undefined {
	const value = row[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((glob) => typeof glob === "string" && glob.trim() !== "")) {
		fail(path, `scope: "${key}" must be an array of non-empty strings`);
	}
	return value;
}

/** `scope` is optional and partial; each listed field must be a glob array. */
function parseScope(raw: unknown, path: string): ScopeConfig | undefined {
	if (raw === undefined) return undefined;
	if (!isJsonObject(raw)) fail(path, "scope: must be an object");
	rejectUnknownKeys(raw, SCOPE_KEYS, "scope", path);
	const include = parseGlobList(raw, "include", path);
	const exclude = parseGlobList(raw, "exclude", path);
	return { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
}

/** Strict constructing parser: every field validated, nothing unknown passes, names unique. */
export function parseRelationshipsFile(raw: unknown, path: string): RelationshipsFile {
	if (!isJsonObject(raw)) fail(path, "must be a JSON object");
	rejectUnknownKeys(raw, FILE_KEYS, "file", path);
	if (raw.version !== 1) fail(path, `"version" must be 1; got ${JSON.stringify(raw.version)}`);
	if (!Array.isArray(raw.relationships)) fail(path, `"relationships" must be an array`);
	const scope = parseScope(raw.scope, path);
	const seen = new Set<string>();
	const relationships = raw.relationships.map((entry, index) => {
		const type = parseRelationship(entry, index, path);
		if (seen.has(type.name)) fail(path, `duplicate relationship name "${type.name}"`);
		seen.add(type.name);
		return type;
	});
	return { version: 1, ...(scope ? { scope } : {}), relationships };
}

/** The effective scope of a file: each absent field takes the seed default. */
export function resolveScope(file: Pick<RelationshipsFile, "scope">): Required<ScopeConfig> {
	return {
		include: file.scope?.include ?? [...DEFAULT_SCOPE.include],
		exclude: file.scope?.exclude ?? [...DEFAULT_SCOPE.exclude],
	};
}

/** Reads the committed file, or returns the seed types when it is absent. A present but malformed file throws. */
export function loadRelationships(cwd: string): RelationshipsFile {
	const path = join(cwd, RELATIONSHIPS_FILE);
	if (!existsSync(path)) return structuredClone(DEFAULT_RELATIONSHIPS);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		// Wrapped because the parse error alone does not name the file the operator must fix.
		fail(path, `not valid JSON (${err instanceof Error ? err.message : String(err)})`);
	}
	return parseRelationshipsFile(raw, path);
}

/** Creates the seed file when none exists. Returns true when it wrote; an existing file is never touched. */
export function writeDefaultRelationships(cwd: string): boolean {
	const path = join(cwd, RELATIONSHIPS_FILE);
	if (existsSync(path)) return false;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(DEFAULT_RELATIONSHIPS, null, "\t")}\n`);
	return true;
}
