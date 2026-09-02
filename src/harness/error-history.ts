// Error History — Cross-session error memory
// Persists error records across sessions in .interlinked/error-history.jsonl.
// Provides deterministic lookups by file and check name.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import { harnessNow } from "./replay/harness-clock.js";
import type { ErrorMemoryConfig, ErrorRecord, ModuleRole, StructuralCheckResult } from "./types.js";

/** Cap the diff snippet stored alongside each error record. */
const MAX_DIFF_CONTEXT_CHARS = 2000;
/** Cap the fix snippet stored alongside each error record. */
const MAX_FIX_CONTEXT_CHARS = 1000;
/** Milliseconds per second (for age-cutoff calculations). */
const MS_PER_SECOND = 1000;

function isModuleRole(v: unknown): v is ModuleRole {
	return v === "leaf" || v === "internal" || v === "hub" || v === "root";
}

function isRecordSeverity(v: unknown): v is ErrorRecord["severity"] {
	return v === "error" || v === "warning";
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((entry): entry is string => typeof entry === "string");
}

/**
 * Defensively narrow one persisted JSONL line to an `ErrorRecord`, or null for
 * a torn / foreign / legacy row. `load()` folds the non-null results in and
 * silently skips the rest — malformed error-history bookkeeping must never
 * crash the harness (`[[feedback_safety_continuity]]`). Every required field
 * is checked; the return is a CONSTRUCTED literal, so a field added to
 * `ErrorRecord` fails to compile here instead of silently under-validating.
 */
type RequiredErrorFields = Pick<
	ErrorRecord,
	| "timestamp"
	| "session_id"
	| "agent_name"
	| "file"
	| "file_role"
	| "check_name"
	| "severity"
	| "message"
	| "diff_context"
>;

/**
 * Narrow the nine required `ErrorRecord` fields out of a JSON object, or
 * return null if any is missing/mistyped. Split out of `parseErrorRecord` so
 * each function stays under the cyclomatic cap; behavior is unchanged.
 */
function extractRequiredErrorFields(value: Record<string, unknown>): RequiredErrorFields | null {
	const {
		timestamp,
		session_id,
		agent_name,
		file,
		file_role,
		check_name,
		severity,
		message,
		diff_context,
	} = value;
	if (typeof timestamp !== "string") return null;
	if (typeof session_id !== "string") return null;
	if (typeof agent_name !== "string") return null;
	if (typeof file !== "string") return null;
	if (!isModuleRole(file_role)) return null;
	if (typeof check_name !== "string") return null;
	if (!isRecordSeverity(severity)) return null;
	if (typeof message !== "string") return null;
	if (typeof diff_context !== "string") return null;

	return {
		timestamp,
		session_id,
		agent_name,
		file,
		file_role,
		check_name,
		severity,
		message,
		diff_context,
	};
}

/**
 * Narrow the optional `ErrorRecord` fields out of a JSON object; every field
 * defaults to `undefined` when absent or mistyped. Split out of
 * `parseErrorRecord` so each function stays under the cyclomatic cap;
 * behavior is unchanged.
 */
function extractOptionalErrorFields(value: Record<string, unknown>) {
	return {
		affected_files: isStringArray(value.affected_files) ? value.affected_files : undefined,
		fix_context: typeof value.fix_context === "string" ? value.fix_context : undefined,
		line_start: typeof value.line_start === "number" ? value.line_start : undefined,
		line_end: typeof value.line_end === "number" ? value.line_end : undefined,
		co_edited_files: isStringArray(value.co_edited_files) ? value.co_edited_files : undefined,
		pre_error_sequence: isStringArray(value.pre_error_sequence)
			? value.pre_error_sequence
			: undefined,
	};
}

/**
 * Defensively narrow one persisted JSONL line to an `ErrorRecord`, or null for
 * a torn / foreign / legacy row. `load()` folds the non-null results in and
 * silently skips the rest — malformed error-history bookkeeping must never
 * crash the harness (`[[feedback_safety_continuity]]`). Every required field
 * is checked; the return is a CONSTRUCTED literal, so a field added to
 * `ErrorRecord` fails to compile here instead of silently under-validating.
 */
export function parseErrorRecord(value: unknown): ErrorRecord | null {
	if (!isJsonObject(value)) return null;
	const required = extractRequiredErrorFields(value);
	if (!required) return null;

	return {
		...required,
		...extractOptionalErrorFields(value),
	};
}

export class ErrorHistory {
	private records: ErrorRecord[] = [];
	private filePath: string;
	private config: ErrorMemoryConfig;

	private byFile: Map<string, ErrorRecord[]> = new Map();
	private checkFrequency: Map<string, number> = new Map();

	constructor(dataDir: string, config: ErrorMemoryConfig) {
		this.filePath = join(dataDir, "error-history.jsonl");
		this.config = config;
		this.load();
	}

	get size(): number {
		return this.records.length;
	}

	getRecords(): ErrorRecord[] {
		return this.records;
	}

	async recordError(
		sessionId: string,
		agentName: string,
		file: string,
		fileRole: ModuleRole,
		result: StructuralCheckResult,
		diffContext: string,
		extra?: {
			line_start?: number;
			line_end?: number;
			co_edited_files?: string[];
			pre_error_sequence?: string[];
		},
	): Promise<void> {
		const record: ErrorRecord = {
			timestamp: new Date().toISOString(),
			session_id: sessionId,
			agent_name: agentName,
			file,
			file_role: fileRole,
			check_name: result.check,
			severity: result.severity === "info" ? "warning" : result.severity,
			message: result.message,
			diff_context: diffContext.slice(0, MAX_DIFF_CONTEXT_CHARS),
			affected_files: result.affectedFiles?.map((f) => f),
			line_start: extra?.line_start,
			line_end: extra?.line_end,
			co_edited_files: extra?.co_edited_files,
			pre_error_sequence: extra?.pre_error_sequence,
		};

		this.records.push(record);
		this.indexRecord(record);
		this.appendToDisk(record);
		this.enforceMaxRecords();
	}

	recordFix(file: string, fixContext: string): void {
		const fileRecords = this.byFile.get(file);
		if (!fileRecords) return;

		for (let i = fileRecords.length - 1; i >= 0; i--) {
			if (!nonNull(fileRecords[i]).fix_context) {
				nonNull(fileRecords[i]).fix_context = fixContext.slice(0, MAX_FIX_CONTEXT_CHARS);
				this.writeToDisk();
				break;
			}
		}
	}

	lookupByFile(file: string): ErrorRecord[] {
		const records = this.byFile.get(file) || [];
		const cutoff = harnessNow() - this.config.max_age_s * MS_PER_SECOND;
		return records.filter((r) => new Date(r.timestamp).getTime() > cutoff).reverse();
	}

	getFileCheckFrequency(file: string): Map<string, number> {
		const freq = new Map<string, number>();
		const records = this.lookupByFile(file);
		for (const r of records) {
			freq.set(r.check_name, (freq.get(r.check_name) || 0) + 1);
		}
		return freq;
	}

	getFileHistoryWarning(file: string): string | null {
		const records = this.lookupByFile(file);
		if (records.length === 0) return null;

		const checkFreq = this.getFileCheckFrequency(file);
		const topChecks = [...checkFreq.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([check, count]) => `${check} (${count}x)`)
			.join(", ");

		const unfixed = records.filter((r) => !r.fix_context).length;
		const total = records.length;

		if (unfixed > 0) {
			return `[interlinked:error-memory] This file has had ${total} check failure(s) across sessions: ${topChecks}. ${unfixed} may still be unresolved.`;
		}

		return `[interlinked:error-memory] This file has had ${total} check failure(s) across sessions (all resolved): ${topChecks}. Take extra care with changes here.`;
	}

	static buildErrorContext(opts: {
		file: string;
		fileRole: string;
		dependentCount: number;
		dependencyCount: number;
		exports: string[];
		result: StructuralCheckResult;
		oldString?: string;
		newString?: string;
		content?: string;
	}): string {
		const parts: string[] = [];
		parts.push(`File: ${opts.file} (${opts.fileRole})`);
		if (opts.dependentCount > 0) parts.push(`Depended on by: ${opts.dependentCount} files`);
		if (opts.dependencyCount > 0) parts.push(`Imports from: ${opts.dependencyCount} modules`);
		if (opts.exports.length > 0) {
			parts.push(
				`Exports: ${opts.exports.slice(0, 15).join(", ")}${opts.exports.length > 15 ? ` +${opts.exports.length - 15} more` : ""}`,
			);
		}
		parts.push(`Check: ${opts.result.check}`);
		parts.push(`Error: ${opts.result.message}`);
		if (opts.result.affectedFiles && opts.result.affectedFiles.length > 0) {
			parts.push(`Affected: ${opts.result.affectedFiles.slice(0, 8).join(", ")}`);
		}
		if (opts.oldString && opts.newString) {
			parts.push(`Diff:\n-${opts.oldString.slice(0, 400)}\n+${opts.newString.slice(0, 400)}`);
		} else if (opts.content) {
			parts.push(`Content: ${opts.content.slice(0, 600)}`);
		}
		return parts.join("\n");
	}

	static buildQueryContext(opts: {
		file: string;
		fileRole: string;
		dependentCount: number;
		dependencyCount: number;
		exports: string[];
		oldString?: string;
		newString?: string;
		content?: string;
	}): string {
		const parts: string[] = [];
		parts.push(`File: ${opts.file} (${opts.fileRole})`);
		if (opts.dependentCount > 0) parts.push(`Depended on by: ${opts.dependentCount} files`);
		if (opts.dependencyCount > 0) parts.push(`Imports from: ${opts.dependencyCount} modules`);
		if (opts.exports.length > 0) {
			parts.push(
				`Exports: ${opts.exports.slice(0, 15).join(", ")}${opts.exports.length > 15 ? ` +${opts.exports.length - 15} more` : ""}`,
			);
		}
		if (opts.oldString && opts.newString) {
			parts.push(
				`Change:\n-${opts.oldString.slice(0, 400)}\n+${opts.newString.slice(0, 400)}`,
			);
		} else if (opts.content) {
			parts.push(`Content: ${opts.content.slice(0, 600)}`);
		}
		return parts.join("\n");
	}

	private load(): void {
		if (!existsSync(this.filePath)) return;
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			const cutoff = harnessNow() - this.config.max_age_s * MS_PER_SECOND;
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					const record = parseErrorRecord(JSON.parse(line));
					if (!record) continue;
					if (new Date(record.timestamp).getTime() < cutoff) continue;
					this.records.push(record);
					this.indexRecord(record);
				} catch (e) {
					void e;
				}
			}
		} catch (e) {
			void e;
		}
	}

	private indexRecord(record: ErrorRecord): void {
		let fileRecords = this.byFile.get(record.file);
		if (!fileRecords) {
			fileRecords = [];
			this.byFile.set(record.file, fileRecords);
		}
		fileRecords.push(record);
		this.checkFrequency.set(
			record.check_name,
			(this.checkFrequency.get(record.check_name) || 0) + 1,
		);
	}

	private appendToDisk(record: ErrorRecord): void {
		try {
			const dir = dirname(this.filePath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
		} catch (e) {
			void e;
		}
	}

	private writeToDisk(): void {
		try {
			const dir = dirname(this.filePath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			const content = `${this.records.map((r) => JSON.stringify(r)).join("\n")}\n`;
			writeFileSync(this.filePath, content);
		} catch (e) {
			void e;
		}
	}

	private enforceMaxRecords(): void {
		if (this.records.length <= this.config.max_records) return;
		const excess = this.records.length - this.config.max_records;
		this.records.splice(0, excess);
		this.byFile.clear();
		this.checkFrequency.clear();
		for (const record of this.records) this.indexRecord(record);
		this.writeToDisk();
	}
}
