// ===========================================
// interlinked verify-changeset — agent-callable self-gate (preview-not-bypass)
// ===========================================
// Runs the SAME proven content-quality pipeline the enforced Write/Edit gate
// runs (pre_block registry -> biome diff-overlay -> tsc diff-overlay, and
// optionally pre_warn), but over a PROPOSED changeset held in memory, and
// REPORTS the result without writing anything. It lets a capable agent verify
// (and fix) a multi-file change in one pass BEFORE submitting the real edits.
//
// PREVIEW-NOT-BYPASS: this command only reports. It writes nothing, touches no
// enforced gate, and cannot weaken enforcement — the real PreToolUse gate still
// runs on the actual Write/Edit (it calls the same `gateProposedContent`). A
// non-zero exit is informational ("this WOULD be blocked"), not enforcement.
//
// Input (JSON, via --file <path> or --stdin):
//   { "version": 1, "changes": [ <entry>, ... ] }
// where each <entry> is `{ path }` plus a Write/Edit/MultiEdit tool-input shape:
//   { path, content }                          (Write — full proposed content)
//   { path, old_string, new_string }           (Edit  — spliced against disk)
//   { path, edits: [{ old_string, new_string }] }  (MultiEdit)

import { readFileSync } from "node:fs";
import {
	formatGateResult,
	GATE_SEVERITY_ERROR,
	type GateFailure,
	type GateInputEntry,
	type GateResult,
	gateProposedContent,
} from "../harness/content-gate.js";
import { resolveProposedContent } from "../harness/overlay-content.js";
import { c } from "../lib/formatter.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";

/** Options accepted by `interlinked verify-changeset`. */
export interface VerifyChangesetOptions {
	file?: string;
	stdin?: boolean;
	json?: boolean;
	/** Also surface pre_warn advisories (skipPreWarn=false). Default: match the enforced gate. */
	warnings?: boolean;
}

/** Exit-code sentinels (informational — this command enforces nothing). */
const EXIT_USAGE = 2;
const EXIT_GATE_FAIL = 1;

/** One proposed change: a target path + a tool-input-shaped payload. */
interface ChangeEntry {
	path: string;
	toolInput: JsonObject;
}

/** Read stdin to EOF. */
async function readStdin(): Promise<string> {
	return new Promise<string>((res, rej) => {
		const chunks: Buffer[] = [];
		process.stdin.on("data", (ch: Buffer) => chunks.push(ch));
		process.stdin.on("end", () => res(Buffer.concat(chunks).toString("utf-8")));
		process.stdin.on("error", rej);
	});
}

/** Read the changeset JSON from --file or --stdin. Throws a usage-level Error. */
async function readChangesetSource(opts: VerifyChangesetOptions): Promise<string> {
	if (opts.file) {
		try {
			return readFileSync(opts.file, "utf-8");
		} catch (err) {
			throw new Error(
				`Could not read changeset file ${opts.file}: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err },
			);
		}
	}
	if (opts.stdin) return readStdin();
	throw new Error("Provide --file <changeset.json> or --stdin.");
}

/** Coerce one raw change into a validated ChangeEntry. Throws a usage-level Error. */
function toChangeEntry(raw: unknown, i: number): ChangeEntry {
	if (!isJsonObject(raw)) {
		throw new Error(`changes[${i}] must be an object { path, content | old_string+new_string | edits }.`);
	}
	const obj = raw;
	if (typeof obj.path !== "string" || obj.path.length === 0) {
		throw new Error(`changes[${i}].path must be a non-empty string.`);
	}
	return { path: obj.path, toolInput: obj };
}

/** Parse + validate the `{ version: 1, changes: [...] }` envelope. Throws usage-level Errors. */
function parseChangeset(raw: string): ChangeEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Changeset is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
			cause: err,
		});
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Changeset must be a JSON object { version: 1, changes: [...] }.");
	}
	const env: { version?: unknown; changes?: unknown } = parsed;
	if (env.version !== 1) {
		throw new Error(`Changeset version must be 1 (got ${JSON.stringify(env.version)}).`);
	}
	if (!Array.isArray(env.changes) || env.changes.length === 0) {
		throw new Error("Changeset must include a non-empty 'changes' array.");
	}
	return env.changes.map((raw2, i) => toChangeEntry(raw2, i));
}

/** Resolve each change to full proposed content. READ-ONLY (splices against disk). */
function resolveEntries(changes: ChangeEntry[]): GateInputEntry[] {
	return changes.map((ch) => ({ path: ch.path, content: resolveProposedContent(ch.path, ch.toolInput) }));
}

function failureJson(f: GateFailure): JsonObject {
	return {
		path: f.path,
		tool: f.tool,
		code: f.code,
		line: f.line,
		message: f.message,
		severity: f.severity,
		...(f.column !== undefined ? { column: f.column } : {}),
		...(f.hint !== undefined ? { hint: f.hint } : {}),
	};
}

function toJsonPayload(result: GateResult): JsonObject {
	return {
		ok: result.ok,
		preview: true,
		elapsedMs: result.elapsedMs,
		failures: result.failures.map(failureJson),
	};
}

function reportUsageError(message: string, useJson: boolean): void {
	if (useJson) {
		console.log(JSON.stringify({ ok: false, preview: true, error: message }, null, 2));
	} else {
		console.error(c.red(`interlinked verify-changeset: ${message}`));
	}
	process.exitCode = EXIT_USAGE;
}

function report(result: GateResult, useJson: boolean): void {
	const blocking = result.failures.some((f) => f.severity === "error");
	if (useJson) {
		console.log(JSON.stringify(toJsonPayload(result), null, 2));
	} else {
		console.log(formatGateResult(result));
		console.log("");
		console.log(
			c.dim(
				blocking
					? "Preview only — nothing changed. The real gate blocks this on submit until fixed."
					: "Preview only — nothing changed. This changeset would pass the gate.",
			),
		);
	}
	process.exitCode = blocking ? EXIT_GATE_FAIL : 0;
}

/**
 * `interlinked verify-changeset` — preview the enforced gate over a proposed
 * changeset without writing. Wired into `src/registrars/quality.ts`. Thin:
 * read -> parse -> resolve proposed content -> gate -> report + exit code.
 */
export async function verifyChangesetCommand(opts: VerifyChangesetOptions): Promise<void> {
	const useJson = opts.json === true;
	let entries: GateInputEntry[];
	try {
		entries = resolveEntries(parseChangeset(await readChangesetSource(opts)));
	} catch (err) {
		reportUsageError(err instanceof Error ? err.message : String(err), useJson);
		return;
	}
	// Same pipeline the enforced Write/Edit gate calls — never writes.
	// tscUnavailableSeverity=error: a changeset "verified" while the type
	// checker never ran must fail the preview — unavailable is not clean.
	const result = gateProposedContent(entries, {
		skipPreWarn: opts.warnings !== true,
		tscUnavailableSeverity: GATE_SEVERITY_ERROR,
	});
	report(result, useJson);
}
