import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { QualityCheckConfig } from "../types.js";
import { isOperationalCheckDeferral } from "../operational-check-deferrals.js";
import { hasExternalCheck, pathMatchesCheck } from "./change-set-external-candidates.js";
import type { QualityCheckResult } from "./result-types.js";

export interface BatchCheckScope {
    batchId: string;
    check: string;
    configurationHash: string;
    inputs: Array<{ path: string; identity: string }>;
    /** Observed request inputs, not a complete compiler/test dependency closure. */
    kind: "request-inputs";
}
export interface BatchFileEvidence {
    checks: string[];
    unavailable: string[];
    scopes: BatchCheckScope[];
}

function identity(path: string, budget = 64 * 1024 * 1024): { hash: string; bytes: number } {
    const before = lstatSync(path);
    if (!before.isFile() || before.size > budget) throw new Error("Batch input is not a regular file within the byte budget");
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex"), after = lstatSync(path);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) {
        throw new Error("Batch input changed while reading");
    }
    return { hash, bytes: before.size };
}

/** Captured before the shared run. Any missing/changed input prevents attribution.
 * Evidence can be retained with partial checks; it must never be used as a reuse key. */
export class ChangeSetEvidence {
    private readonly batchId = randomUUID();
    private readonly inputs: BatchCheckScope["inputs"] = [];
    private issue: string | undefined;
    constructor(paths: readonly string[], private readonly config: Record<string, QualityCheckConfig>, cwd: string) {
        try {
            let remaining = 64 * 1024 * 1024;
            for (const path of paths.filter(path => hasExternalCheck(path, config))) {
                const absolute = resolve(cwd, path), captured = identity(absolute, remaining);
                this.inputs.push({ path: absolute, identity: captured.hash });
                remaining -= captured.bytes;
            }
        } catch (error) { this.issue = String(error); }
    }

    finish(): void {
        try {
            if (this.inputs.some(input => identity(input.path).hash !== input.identity)) throw new Error("Shared batch inputs changed during or after execution");
        } catch (error) { this.issue = String(error); }
    }

    forFile(path: string, completed: readonly string[], results: Map<string, QualityCheckResult[]>): BatchFileEvidence {
        const unavailable = [...results.values()].flat().filter(row => isOperationalCheckDeferral(row.name)).map(row => `${row.name}: ${row.detail ?? row.message}`);
        if (this.issue) return { checks: [], scopes: [], unavailable: [...unavailable, this.issue] };
        const checks = [...new Set(completed)].filter(name => this.config[name] && pathMatchesCheck(path, this.config[name]));
        if (!checks.length && hasExternalCheck(path, this.config)) unavailable.push("No applicable shared check completed for this input");
        const scopes = checks.map(check => ({ batchId: this.batchId, check, kind: "request-inputs" as const,
            configurationHash: createHash("sha256").update(JSON.stringify(this.config[check])).digest("hex"), inputs: this.inputs }));
        return { checks, unavailable, scopes };
    }
}
