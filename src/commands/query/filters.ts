// ===========================================
// Where-clause + time-bound predicates for `interlinked query`
// ===========================================
// Grammar (one clause per --where value): key=value | key!=value |
// key~=substr | key>n | key<n | key>=n | key<=n. Keys are dot paths; a path
// segment that lands on an array fans out over its elements, so
// `checks.id=floating_promises` matches a record whose checks[] contains an
// entry with that id. Multiple clauses AND together.

import { parseDuration } from "../../lib/activity-utils.js";

type WhereOp = "=" | "!=" | "~=" | ">" | "<" | ">=" | "<=";

export interface WhereClause {
	path: string;
	op: WhereOp;
	value: string;
}

// Two-char operators must be tried before their one-char prefixes.
const OP_ORDER: WhereOp[] = ["!=", ">=", "<=", "~=", "=", ">", "<"];

export function parseWhereClause(expr: string): WhereClause {
	for (const op of OP_ORDER) {
		const idx = expr.indexOf(op);
		if (idx > 0) {
			return { path: expr.slice(0, idx).trim(), op, value: expr.slice(idx + op.length).trim() };
		}
	}
	throw new Error(
		`Invalid --where clause "${expr}" — expected key=value, key!=value, key~=substr, or key>n`,
	);
}

/** Resolve a dot path to its value(s); arrays along the path fan out. */
export function getPath(record: unknown, path: string): unknown[] {
	let current: unknown[] = [record];
	for (const segment of path.split(".")) {
		const next: unknown[] = [];
		for (const value of current) {
			next.push(...stepInto(value, segment));
		}
		current = next;
	}
	return current.filter((v) => v !== undefined);
}

function stepInto(value: unknown, segment: string): unknown[] {
	if (Array.isArray(value)) return value.flatMap((element) => stepInto(element, segment));
	if (typeof value === "object" && value !== null) {
		return [(value as Record<string, unknown>)[segment]];
	}
	return [];
}

export function stringifyValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null) return "null";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

export function matchesClause(record: unknown, clause: WhereClause): boolean {
	const values = getPath(record, clause.path);
	if (clause.op === "!=") return values.every((v) => stringifyValue(v) !== clause.value);
	if (clause.op === "=") return values.some((v) => stringifyValue(v) === clause.value);
	if (clause.op === "~=") {
		const needle = clause.value.toLowerCase();
		return values.some((v) => stringifyValue(v).toLowerCase().includes(needle));
	}
	const bound = Number(clause.value);
	if (!Number.isFinite(bound)) return false;
	return values.some((v) => compareNumeric(v, clause.op, bound));
}

function compareNumeric(value: unknown, op: WhereOp, bound: number): boolean {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return false;
	if (op === ">") return n > bound;
	if (op === "<") return n < bound;
	if (op === ">=") return n >= bound;
	return n <= bound;
}

export function matchesAll(record: unknown, clauses: WhereClause[]): boolean {
	return clauses.every((clause) => matchesClause(record, clause));
}

/** "30m"/"2h"/"7d" (relative to now) or an ISO timestamp → epoch ms. */
export function resolveTimeBound(spec: string, nowMs: number = Date.now()): number {
	if (/^\d+\s*[smhd]$/i.test(spec.trim())) return nowMs - parseDuration(spec);
	const parsed = Date.parse(spec);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid --since "${spec}" — expected a duration like 30m/2h/7d or an ISO timestamp`);
	}
	return parsed;
}

/** Epoch ms of a record's `ts` (or `timestamp`) field, if parseable. */
export function recordTimestampMs(record: Record<string, unknown>): number | undefined {
	const ts = record.ts ?? record.timestamp;
	if (typeof ts !== "string") return undefined;
	const ms = Date.parse(ts);
	return Number.isFinite(ms) ? ms : undefined;
}
