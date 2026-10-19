import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { isJsonObject } from "../lib/json-types.js";
import type { HookCheckReceipt, HookReviewReceipt } from "./hook-coverage-evidence.js";
import { writeHookCoverageLedger } from "./hook-coverage-persistence.js";
import { parseHookVerificationCheckpoint, type HookVerificationCheckpoint } from "./hook-coverage-job.js";
import { historySummary, recentHistory } from "./hook-coverage-history.js";
import { appendHistoryRows, assertHistoryCommitted, emptyHistoryPointer, fileStamp, historyLogPath, parseHistoryPointer, readHistory, readRecentHistory,
    type HookHistoryPointer, type HookHistoryRow } from "./hook-coverage-history-log.js";
import { hasInlineHistory, loadLedgerFile } from "./hook-coverage-migration.js";

export type { HookReviewReceipt } from "./hook-coverage-evidence.js";

/** Files up to this size parse whole; larger ones (only a legacy ledger) stream. */
const PARSE_LIMIT_BYTES = 64 * 1024 * 1024;

interface ObservedFile { identity: string; scope: "policy" | "reservation" }
export interface HookFileObservation extends ObservedFile { path: string }
export interface HookPendingCheck {
    id: string;
    path: string;
    identity: string;
    scope: "policy" | "reservation";
    writer: "unknown";
}
/** The full view: current state plus every retained receipt (`snapshot()`). */
export interface LedgerState {
    schema: 1;
    generation: number;
    policyGeneration: number;
    files: Record<string, ObservedFile>;
    pending: HookPendingCheck[];
    acceptedPolicy: string | null;
    reviews: HookReviewReceipt[];
    checks: HookCheckReceipt[];
    recovery?: HookVerificationCheckpoint;
}
/** What the state file holds: no receipts, only the committed length of the history log. */
export interface PersistedLedgerState extends Omit<LedgerState, "checks" | "reviews"> { history: HookHistoryPointer }

function parseObservedFile(raw: unknown): ObservedFile {
    if (!isJsonObject(raw) || typeof raw.identity !== "string") throw new Error("Invalid hook file identity");
    if (raw.scope !== "policy" && raw.scope !== "reservation") throw new Error("Invalid hook file scope");
    return { identity: raw.identity, scope: raw.scope };
}

function parsePending(raw: unknown): HookPendingCheck {
    const file = parseObservedFile(raw);
    if (!isJsonObject(raw) || typeof raw.id !== "string" || typeof raw.path !== "string" || raw.writer !== "unknown") throw new Error("Invalid pending hook check");
    return { ...file, id: raw.id, path: raw.path, writer: "unknown" };
}

function parseGeneration(raw: unknown): number {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) throw new Error("Invalid hook coverage generation");
    return raw;
}

function parseState(raw: unknown, history: HookHistoryPointer): PersistedLedgerState {
    if (!isJsonObject(raw) || raw.schema !== 1 || typeof raw.generation !== "number") throw new Error("Invalid hook coverage ledger header");
    const generation = parseGeneration(raw.generation);
    if (!isJsonObject(raw.files) || !Array.isArray(raw.pending)) throw new Error("Invalid hook coverage entries");
    if (raw.acceptedPolicy !== null && typeof raw.acceptedPolicy !== "string") throw new Error("Invalid accepted policy identity");
    return { schema: 1, generation, policyGeneration: parseGeneration(raw.policyGeneration ?? generation),
        files: Object.fromEntries(Object.entries(raw.files).map(([path, value]) => [path, parseObservedFile(value)])),
        pending: raw.pending.map(parsePending), acceptedPolicy: raw.acceptedPolicy, history,
        ...(raw.recovery === undefined ? {} : { recovery: parseHookVerificationCheckpoint(raw.recovery) }) };
}

/** A current ledger parses whole and is never rewritten on load; a legacy one migrates once. */
function loadState(path: string, logPath: string): PersistedLedgerState {
    if (!existsSync(path)) return { schema: 1, generation: 0, policyGeneration: 0, files: {}, pending: [], acceptedPolicy: null, history: emptyHistoryPointer() };
    if (statSync(path).size <= PARSE_LIMIT_BYTES) {
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!isJsonObject(raw)) return parseState(raw, emptyHistoryPointer());
        if (!hasInlineHistory(raw)) return parseState(raw, parseHistoryPointer(raw.history));
    }
    return loadLedgerFile(path, logPath, parseState, state => writeHookCoverageLedger(path, state)).state;
}

export interface HistoryRepair {
    repaired: boolean;
    detail: string;
    /** Where the partial log was set aside, when there was one. */
    orphan?: string;
}

/**
 * Operator repair for a history log shorter than its committed pointer (a
 * cleared `hook-coverage-history.jsonl` beside a kept `hook-coverage.json`).
 * The ledger constructor refuses that state so the daemon never reports LESS
 * history than it committed; without a repair that refusal is permanent and
 * the only exit is deleting the state file and its pending obligations. This
 * keeps the state (files, pending, accepted policy, generation), sets aside
 * whatever log remains, and restarts the history at zero. Never called by the
 * daemon: evidence loss is acknowledged by a human, not healed in silence.
 */
export function repairHistoryLoss(path: string): HistoryRepair {
    if (!existsSync(path)) return { repaired: false, detail: `no hook coverage ledger at ${path}` };
    const logPath = historyLogPath(path);
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(raw)) throw new Error("Invalid hook coverage ledger header");
    if (hasInlineHistory(raw)) return { repaired: false, detail: "legacy inline-history ledger: it migrates on the next daemon start" };
    const state = parseState(raw, parseHistoryPointer(raw.history));
    const size = existsSync(logPath) ? statSync(logPath).size : 0;
    if (size >= state.history.bytes) return { repaired: false, detail: `history intact: ${logPath} holds ${size} of ${state.history.bytes} committed bytes` };
    const orphan = `${logPath}.orphan-${fileStamp()}-${randomUUID().slice(0, 8)}`;
    if (existsSync(logPath)) renameSync(logPath, orphan);
    writeHookCoverageLedger(path, { ...state, history: emptyHistoryPointer() });
    const lost = `${state.history.checks} check receipt(s) and ${state.history.reviews} review(s) (${state.history.bytes} committed bytes, ${size} present)`;
    return { repaired: true, detail: `history restarted; lost ${lost}; pending obligations kept (${state.pending.length})`, ...(size ? { orphan } : {}) };
}

/** Single daemon writer; atomic replacement preserves the previous state on failure.
 * Receipts live in an append-only sibling log, so a save is O(current state), not O(history). */
export class HookCoverageLedger {
    private state: PersistedLedgerState;
    private readonly logPath: string;
    constructor(private readonly path: string) {
        this.logPath = historyLogPath(path);
        this.state = loadState(path, this.logPath);
        assertHistoryCommitted(this.logPath, this.state.history);
    }

    /** Full view including every retained receipt. O(history): diagnostics and tests only. */
    snapshot(): LedgerState {
        const { history, ...current } = structuredClone(this.state);
        return { ...current, ...readHistory(this.logPath, history.bytes) };
    }

    /** Operator status keeps all pending work, but never copies unbounded history. */
    statusReport() {
        const recent = readRecentHistory(this.logPath, this.state.history);
        const checks = recentHistory(recent.checks, this.state.history.checks), reviews = recentHistory(recent.reviews, this.state.history.reviews);
        return { ...this.summary(), pending: structuredClone(this.state.pending), checks: checks.rows, reviews: reviews.rows,
            history: historySummary(this.path, checks.counts, reviews.counts) };
    }

    /** Current observation data without retained check/review history. */
    observation(): Pick<LedgerState, "files" | "pending"> {
        return structuredClone({ files: this.state.files, pending: this.state.pending });
    }

    summary() {
        return { generation: this.state.generation, policyGeneration: this.state.policyGeneration,
            pendingCount: this.state.pending.length, acceptedPolicy: this.state.acceptedPolicy };
    }

    observe(path: string, identity: string, scope: ObservedFile["scope"]): void {
        this.observeBatch([{ path, identity, scope }]);
    }

    recovery(): HookVerificationCheckpoint | undefined { return this.state.recovery ? structuredClone(this.state.recovery) : undefined; }

    saveRecovery(checkpoint: HookVerificationCheckpoint): void {
        this.save({ ...this.state, recovery: structuredClone(parseHookVerificationCheckpoint(checkpoint)) });
    }

    /** Reconciliation is one transaction, with generations retained for every change. */
    observeBatch(observations: readonly HookFileObservation[]): void {
        const next = { ...this.state, files: { ...this.state.files } };
        const pending = new Map(this.state.pending.map(entry => [entry.path, entry]));
        for (const { path, identity, scope } of observations) {
            const previous = next.files[path];
            if (previous?.identity === identity && previous.scope === scope) continue;
            next.generation++;
            next.files[path] = { identity, scope };
            if (scope === "policy" || previous?.scope === "policy") next.policyGeneration++;
            pending.delete(path);
            // Initial absence is not an observed write. Later deletion still needs evidence.
            if (previous || identity !== "missing") {
                pending.set(path, { id: randomUUID(), path, identity, scope, writer: "unknown" });
            }
        }
        if (next.generation !== this.state.generation) this.save({ ...next, pending: [...pending.values()] });
    }

    policyDigest(): string {
        const files = Object.entries(this.state.files).filter(([, value]) => value.scope === "policy").map(([path, value]) => [path, value.identity]).sort();
        return createHash("sha256").update(JSON.stringify(files)).digest("hex");
    }

    /** Explicit acceptance only; observing or checking a change is not approval. */
    acceptPolicy(expectedDigest: string): boolean {
        if (this.policyDigest() !== expectedDigest) return false;
        const next = { ...this.state };
        next.acceptedPolicy = expectedDigest;
        next.generation++;
        this.save(next);
        return true;
    }

    /** Call after checking captured inputs. Any newer observation invalidates it. */
    acknowledge(receipt: { id: string; generation: number; identity: string; evidence: string }): boolean {
        if (!receipt.evidence.trim() || receipt.generation !== this.state.generation) return false;
        const entry = this.state.pending.find(candidate => candidate.id === receipt.id);
        if (!entry || entry.identity !== receipt.identity) return false;
        const review: HookReviewReceipt = { id: entry.id, path: entry.path, identity: entry.identity, evidence: receipt.evidence, reviewedAt: new Date().toISOString(), kind: "manual_review" };
        this.save({ ...this.state, generation: this.state.generation + 1, pending: this.state.pending.filter(candidate => candidate.id !== receipt.id) }, [review]);
        return true;
    }

    /** Only the daemon's checker supplies these receipts. The observation ID
     * detects replacement/ABA without invalidation by unrelated acknowledgments. */
    recordCheck(receipt: HookCheckReceipt): boolean {
        return this.recordChecks([receipt])[0] ?? false;
    }

    /** Persist a checker batch once. Stale and partial results keep their existing semantics. */
    recordChecks(receipts: readonly HookCheckReceipt[], checkpoint?: (outcomes: readonly boolean[]) => HookVerificationCheckpoint): boolean[] {
        const digest = this.policyDigest();
        const pending = new Map(this.state.pending.map(entry => [entry.id, entry]));
        const accepted: HookCheckReceipt[] = [];
        const outcomes = receipts.map(receipt => {
            if (!receipt.checks.length || receipt.policyDigest !== digest) return false;
            if (receipt.policyGeneration !== this.state.policyGeneration) return false;
            const entry = pending.get(receipt.id);
            if (!entry || entry.path !== receipt.path || entry.identity !== receipt.identity) return false;
            accepted.push(structuredClone(receipt));
            if (!receipt.unavailable?.length) pending.delete(receipt.id);
            return true;
        });
        const recovery = checkpoint ? structuredClone(parseHookVerificationCheckpoint(checkpoint(outcomes))) : undefined;
        if (accepted.length || recovery) this.save({ ...this.state, generation: this.state.generation + accepted.length,
            pending: [...pending.values()], ...(recovery ? { recovery } : {}) }, accepted);
        return outcomes;
    }

    /** Rows append first; the state write commits them by naming the new log length.
     * If the state write fails, the append is rolled back and both old states remain. */
    private save(next: PersistedLedgerState, rows: readonly HookHistoryRow[] = []): void {
        const append = rows.length ? appendHistoryRows(this.logPath, this.state.history, rows) : undefined;
        const committed = append ? { ...next, history: append.pointer } : next;
        try { writeHookCoverageLedger(this.path, committed); }
        catch (error) { append?.rollback(); throw error; }
        this.state = committed;
    }
}
