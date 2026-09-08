import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { parseHookCheckReceipts, type HookCheckReceipt } from "./hook-coverage-evidence.js";

interface ObservedFile { identity: string; scope: "policy" | "reservation" }
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
        pending: raw.pending.map(parsePending), acceptedPolicy: raw.acceptedPolicy, reviews: parseReviews(raw.reviews), checks: parseHookCheckReceipts(raw.checks) };
}

/** Single daemon writer; atomic replacement preserves the previous state on failure. */
export class HookCoverageLedger {
    private state: LedgerState;
    constructor(private readonly path: string) {
        this.state = existsSync(path) ? parseState(JSON.parse(readFileSync(path, "utf8"))) : { schema: 1, generation: 0, policyGeneration: 0, files: {}, pending: [], acceptedPolicy: null, reviews: [], checks: [] };
    }

    snapshot(): LedgerState { return structuredClone(this.state); }

    observe(path: string, identity: string, scope: ObservedFile["scope"]): void {
        const previous = this.state.files[path];
        if (previous?.identity === identity && previous.scope === scope) return;
        const next = this.snapshot();
        next.generation++;
        next.files[path] = { identity, scope };
        if (scope === "policy" || previous?.scope === "policy") next.policyGeneration++;
        next.pending = next.pending.filter(entry => entry.path !== path);
        next.pending.push({ id: randomUUID(), path, identity, scope, writer: "unknown" });
        this.save(next);
    }

    policyDigest(): string {
        const files = Object.entries(this.state.files).filter(([, value]) => value.scope === "policy").map(([path, value]) => [path, value.identity]).sort();
        return createHash("sha256").update(JSON.stringify(files)).digest("hex");
    }

    /** Explicit acceptance only; observing or checking a change is not approval. */
    acceptPolicy(expectedDigest: string): boolean {
        if (this.policyDigest() !== expectedDigest) return false;
        const next = this.snapshot();
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
        const next = this.snapshot();
        next.pending = next.pending.filter(candidate => candidate.id !== receipt.id);
        next.reviews.push({ id: entry.id, path: entry.path, identity: entry.identity, evidence: receipt.evidence, reviewedAt: new Date().toISOString(), kind: "manual_review" });
        next.generation++;
        this.save(next);
        return true;
    }

    /** Only the daemon's checker supplies these receipts. The observation ID
     * detects replacement/ABA without invalidation by unrelated acknowledgments. */
    recordCheck(receipt: HookCheckReceipt): boolean {
        if (!receipt.checks.length || receipt.policyDigest !== this.policyDigest()) return false;
        if (receipt.policyGeneration !== this.state.policyGeneration) return false;
        const entry = this.state.pending.find(candidate => candidate.id === receipt.id);
        if (!entry || entry.path !== receipt.path || entry.identity !== receipt.identity) return false;
        const next = this.snapshot();
        next.pending = next.pending.filter(candidate => candidate.id !== receipt.id);
        next.checks.push(structuredClone(receipt));
        next.generation++;
        this.save(next);
        return true;
    }

    private save(next: LedgerState): void {
        mkdirSync(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
        try { renameSync(temporary, this.path); }
        catch (error) { unlinkSync(temporary); throw error; }
        this.state = next;
    }
}
