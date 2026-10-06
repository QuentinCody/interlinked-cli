import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isJsonObject } from "../lib/json-types.js";
import { parseHookCheckReceipts, type HookCheckReceipt } from "./hook-coverage-evidence.js";
import { writeHookCoverageLedger } from "./hook-coverage-persistence.js";
import { parseHookVerificationCheckpoint, type HookVerificationCheckpoint } from "./hook-coverage-job.js";
import { historySummary, recentHistory } from "./hook-coverage-history.js";

interface ObservedFile { identity: string; scope: "policy" | "reservation" }
export interface HookFileObservation extends ObservedFile { path: string }
export interface HookPendingCheck {
    id: string;
    path: string;
    identity: string;
    scope: "policy" | "reservation";
    writer: "unknown";
}
export interface HookReviewReceipt { id: string; path: string; identity: string; evidence: string; reviewedAt: string; kind: "manual_review" }
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

function reviewString(raw: Record<string, unknown>, key: string): string {
    const value = raw[key];
    if (typeof value !== "string") throw new Error(`Invalid hook review ${key}`);
    return value;
}

function parseReview(raw: unknown): HookReviewReceipt {
    if (!isJsonObject(raw) || raw.kind !== "manual_review") throw new Error("Invalid hook review receipt");
    return { id: reviewString(raw, "id"), path: reviewString(raw, "path"), identity: reviewString(raw, "identity"), evidence: reviewString(raw, "evidence"), reviewedAt: reviewString(raw, "reviewedAt"), kind: "manual_review" };
}

function parseReviews(raw: unknown): HookReviewReceipt[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new Error("Invalid hook reviews");
    return raw.map(parseReview);
}

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

function parseState(raw: unknown): LedgerState {
    if (!isJsonObject(raw) || raw.schema !== 1 || typeof raw.generation !== "number") throw new Error("Invalid hook coverage ledger header");
    const generation = parseGeneration(raw.generation);
    if (!isJsonObject(raw.files) || !Array.isArray(raw.pending)) throw new Error("Invalid hook coverage entries");
    if (raw.acceptedPolicy !== null && typeof raw.acceptedPolicy !== "string") throw new Error("Invalid accepted policy identity");
    return { schema: 1, generation, policyGeneration: parseGeneration(raw.policyGeneration ?? generation),
        files: Object.fromEntries(Object.entries(raw.files).map(([path, value]) => [path, parseObservedFile(value)])),
        pending: raw.pending.map(parsePending), acceptedPolicy: raw.acceptedPolicy, reviews: parseReviews(raw.reviews), checks: parseHookCheckReceipts(raw.checks),
        ...(raw.recovery === undefined ? {} : { recovery: parseHookVerificationCheckpoint(raw.recovery) }) };
}

/** Single daemon writer; atomic replacement preserves the previous state on failure. */
export class HookCoverageLedger {
    private state: LedgerState;
    constructor(private readonly path: string) {
        this.state = existsSync(path) ? parseState(JSON.parse(readFileSync(path, "utf8"))) : { schema: 1, generation: 0, policyGeneration: 0, files: {}, pending: [], acceptedPolicy: null, reviews: [], checks: [] };
    }

    snapshot(): LedgerState { return structuredClone(this.state); }

    /** Operator status keeps all pending work, but never copies unbounded history. */
    statusReport() {
        const checks = recentHistory(this.state.checks), reviews = recentHistory(this.state.reviews);
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
        const next = { ...this.state, reviews: [...this.state.reviews] };
        next.pending = next.pending.filter(candidate => candidate.id !== receipt.id);
        next.reviews.push({ id: entry.id, path: entry.path, identity: entry.identity, evidence: receipt.evidence, reviewedAt: new Date().toISOString(), kind: "manual_review" });
        next.generation++;
        this.save(next);
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
            pending: [...pending.values()], checks: [...this.state.checks, ...accepted], ...(recovery ? { recovery } : {}) });
        return outcomes;
    }

    private save(next: LedgerState): void {
        writeHookCoverageLedger(this.path, next);
        this.state = next;
    }
}
