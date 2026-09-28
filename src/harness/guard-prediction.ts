import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { SharedConfig } from "../lib/config.js";
import { withFileMutationLock } from "../lib/file-mutation-lock.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { extractApplyPatchRaw, looksLikeApplyPatch, parseApplyPatchSections } from "./apply-patch-content.js";
import { isFileWrite } from "./evaluator/tool-classifiers.js";
import { compareGuardOwnership, type GuardChange } from "./guard-ownership.js";
import { projectFileChanges, type ProjectedFileChange } from "./projected-file-changes.js";
import { extractAllEditedFilePaths } from "./server-tool-helpers.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

export type GuardPredictionMode = "enforced" | "shadow" | "off";
interface Proposal { id: string; file: string; beforeSha256: string; afterSha256: string; }
interface Receipt { nonce: string; reconcile?: string; rationale?: string; }
interface ProtocolRow {
    version: 1;
    kind: "reveal" | "predicted" | "reconciled";
    session: string;
    proposal: Proposal;
    changes: GuardChange[];
    timestamp: string;
    invocation?: string;
    nonce?: string;
    rationale?: string;
}
const PREFIX = "[interlinked:guard-prediction]";
const STATE = ".interlinked/predictions";
const MAX_SOURCE_BYTES = 2_000_000;
interface Admission { kind: ProtocolRow["kind"]; session: string; proposalId: string; nonce?: string; invocation?: string; }
interface GuardRun { event: HarnessEvent; cwd: string; mode: GuardPredictionMode; pending: ProtocolRow[]; }

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** Byte-bound identity. No formatter or newline normalization runs before this oracle. */
export function guardProposal(file: string, before: string, after: string): Proposal {
    const beforeSha256 = digest(before);
    const afterSha256 = digest(after);
    return { file, beforeSha256, afterSha256, id: digest(JSON.stringify([1, file, beforeSha256, afterSha256])) };
}

export function guardReceiptPath(cwd: string, session: string, proposal: string): string {
    return join(cwd, STATE, "guards", digest(session), `${proposal}.json`);
}

export function guardPredictionMode(config: SharedConfig | null): GuardPredictionMode {
    const policy = config?.harness?.guard_prediction;
    if (isJsonObject(policy) && (policy.mode === "off" || policy.mode === "shadow")) return policy.mode;
    return "enforced";
}

function unknown(reason: string): HarnessDecision {
    return { decision: "allow", warnings: [`${PREFIX} NOT CHECKED: ${reason}`] };
}

function refusal(message: string, mode: GuardPredictionMode): HarnessDecision {
    const reason = `${PREFIX} ${message}`;
    if (mode === "shadow") return { decision: "allow", warnings: [reason] };
    return { decision: "block", rule_id: "guard-prediction-protocol", reason, severity: "medium", category: "guard-prediction" };
}

function unambiguousEdits(input: JsonObject, before: string): boolean {
    if (typeof input.content === "string") return true;
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    let text = before;
    for (const edit of edits) {
        if (!isJsonObject(edit) || typeof edit.old_string !== "string" || !edit.old_string || typeof edit.new_string !== "string") return false;
        const parts = text.split(edit.old_string);
        if (parts.length < 2 || (parts.length !== 2 && edit.replace_all !== true)) return false;
        if (edit.replace_all === true) text = parts.join(edit.new_string);
        else {
            const offset = text.indexOf(edit.old_string);
            text = text.slice(0, offset) + edit.new_string + text.slice(offset + edit.old_string.length);
        }
    }
    return true;
}

function project(event: HarnessEvent, cwd: string): ProjectedFileChange[] | null {
    const input = event.tool_input ?? {};
    const changes = projectFileChanges(input, cwd);
    const raw = extractApplyPatchRaw(input);
    if (typeof input.file_path === "string" || typeof input.path === "string") {
        if (changes.some(change => !unambiguousEdits(input, change.before))) return null;
    } else if (looksLikeApplyPatch(raw)) {
        if (parseApplyPatchSections(raw).length !== changes.length) return null;
    }
    if (!changes.length || new Set(changes.map(change => change.sourcePath)).size !== changes.length) return null;
    return changes;
}

function readRows(cwd: string): Admission[] {
    const path = join(cwd, STATE, "guard-events.jsonl");
    if (!existsSync(path)) return [];
    const rows: Admission[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        const value: unknown = JSON.parse(line);
        if (!isJsonObject(value) || value.version !== 1 || !isJsonObject(value.proposal) || typeof value.proposal.id !== "string" ||
            typeof value.session !== "string" || (value.kind !== "reveal" && value.kind !== "predicted" && value.kind !== "reconciled")) throw new Error("Invalid guard event ledger");
        rows.push({ kind: value.kind, session: value.session, proposalId: value.proposal.id,
            ...(typeof value.nonce === "string" ? { nonce: value.nonce } : {}),
            ...(typeof value.invocation === "string" ? { invocation: value.invocation } : {}) });
    }
    return rows;
}

function readReceipt(cwd: string, session: string, proposal: Proposal, changes: GuardChange[]): Receipt | null {
    const path = guardReceiptPath(cwd, session, proposal.id);
    if (!existsSync(path)) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(value) || value.version !== 1 || value.session !== session ||
        value.id !== proposal.id || value.file !== proposal.file || value.beforeSha256 !== proposal.beforeSha256 || value.afterSha256 !== proposal.afterSha256 ||
        typeof value.nonce !== "string" || !value.nonce.trim() || !Array.isArray(value.changes)) return null;
    // JSON object key order does not express intent. Array order records the lexical guard stack.
    if (stableJson(value.changes) !== stableJson(changes)) return null;
    return { nonce: value.nonce,
        ...(typeof value.reconcile === "string" ? { reconcile: value.reconcile } : {}),
        ...(typeof value.rationale === "string" ? { rationale: value.rationale } : {}) };
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (isJsonObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
}

function record(cwd: string, row: ProtocolRow, dryRun: boolean | undefined): void {
    if (dryRun) return;
    appendFileSync(join(cwd, STATE, "guard-events.jsonl"), JSON.stringify(row) + "\n", { mode: 0o600 });
}

function reconcile(run: GuardRun, proposal: Proposal, changes: GuardChange[]): HarnessDecision | null {
    const { event, cwd, mode, pending } = run;
    const rows = readRows(cwd).filter(row => row.session === event.session_id && row.proposalId === proposal.id);
    const receipt = readReceipt(cwd, event.session_id, proposal, changes);
    const revealed = rows.some(row => row.kind === "reveal");
    const accepted = rows.find(row => row.kind !== "reveal" && row.nonce === receipt?.nonce);
    const invocation = event.tool_use_id;
    // Other pre-execution gates can refuse an otherwise predicted proposal. Retrying
    // identical bytes retains the same intent; a different proposal cannot reuse it.
    if (accepted) return null;
    const intentional = receipt && !accepted && (!revealed || (receipt.reconcile === proposal.id && !!receipt.rationale?.trim()));
    const row: ProtocolRow = { version: 1, session: event.session_id, proposal, changes, timestamp: event.timestamp,
        kind: intentional ? (revealed ? "reconciled" : "predicted") : "reveal",
        ...(invocation ? { invocation } : {}) };
    if (intentional) {
        pending.push({ ...row, nonce: receipt.nonce, ...(receipt.rationale ? { rationale: receipt.rationale } : {}) });
        return null;
    }
    if (!revealed) record(cwd, row, event.dry_run);
    return refusal(`Unpredicted or unreconciled if-guard change in ${proposal.file}. ` +
        `This is a scope change, not a proven bug. Correct the edit or declare the exact intended changes in ${guardReceiptPath(cwd, event.session_id, proposal.id)}. ` +
        `After this reveal include reconcile: "${proposal.id}", a rationale and a declaration nonce. ` +
        `Receipt fields: ${JSON.stringify({ version: 1, session: event.session_id, ...proposal, changes })}`, mode);
}

function inspectChange(run: GuardRun, change: ProjectedFileChange): HarnessDecision | null {
    const { cwd } = run;
    if (!change.existed || change.deleted || !/\.[cm]?[jt]sx?$/i.test(change.path)) return null;
    const path = realpathSync(change.sourcePath);
    const file = relative(cwd, path);
    if (file === ".." || file.startsWith("../") || isAbsolute(file)) return null;
    if (Buffer.byteLength(change.before) + Buffer.byteLength(change.after) > MAX_SOURCE_BYTES) return unknown(`${file}: source exceeds the bounded guard analysis budget.`);
    // A move changes file identity as well; this first oracle does not match statements across files.
    if (change.path !== change.sourcePath) return unknown(`${file}: cross-file movement is outside this guard oracle.`);
    const compared = compareGuardOwnership(change.before, change.after, file);
    if (compared.changes.length) {
        const decision = reconcile(run, guardProposal(file, change.before, change.after), compared.changes);
        if (decision) return decision;
    }
    if (compared.status !== "measured") return unknown(`${file}: ${compared.status} guard comparison (${compared.unmatched} unmatched existing return/throw statements).`);
    return null;
}

/** Serializes ledger admissions and consumes predictions only once the entire proposal passes. */
function reconcileChanges(run: GuardRun, changes: ProjectedFileChange[]): HarnessDecision | null {
    const { cwd, event, mode } = run;
    const state = join(cwd, STATE);
    const inspect = (): HarnessDecision | null => {
        const warnings: string[] = [];
        for (const change of changes) {
            const decision = inspectChange(run, change);
            if (decision?.decision === "block") return decision;
            warnings.push(...(decision?.warnings ?? []));
        }
        for (const row of run.pending) record(cwd, row, event.dry_run);
        return warnings.length ? { decision: "allow", warnings } : null;
    };
    try {
        if (event.dry_run) return inspect();
        mkdirSync(state, { recursive: true });
        return withFileMutationLock(join(state, "guard-events.jsonl"), inspect, { waitMs: 0 });
    } catch (error) {
        return refusal(`Protocol NOT CHECKED: ${String(error)}. Restore readable protocol state and retry; no prediction was accepted.`, mode);
    }
}

/** Same raw-proposal oracle for the daemon and native cold path; graph shards are irrelevant. */
export function driveGuardPrediction(event: HarnessEvent, mode: GuardPredictionMode = "enforced"): HarnessDecision | null {
    if (mode === "off" || event.hook_event !== "PreToolUse" || !isFileWrite(event.tool_name)) return null;
    if (!extractAllEditedFilePaths(event).some(path => /\.[cm]?[jt]sx?$/i.test(path))) return null;
    try {
        const cwd = realpathSync(event.cwd || process.cwd());
        const changes = project(event, cwd);
        if (!changes) return unknown("tool input cannot be projected unambiguously; guard preservation was not established.");
        const codeChanges = changes.filter(change => change.existed && !change.deleted && /\.[cm]?[jt]sx?$/i.test(change.path));
        if (!codeChanges.length) return null;
        if (!event.session_id) return unknown("missing session identity; a prediction cannot be bound to this edit.");
        return reconcileChanges({ event, cwd, mode, pending: [] }, codeChanges);
    } catch (error) { return unknown(`source projection unavailable: ${String(error)}`); }
}
