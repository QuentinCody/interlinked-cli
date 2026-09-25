// interlinked-tdd: exempt — declarations only; schema and execution are covered by companion suites.
export interface ContractSource {
    kind: "requirement" | "example" | "regression" | "inferred";
    path: string;
    sha256: string;
    quote: string;
    observation?: "json" | "stdout" | "contract-example";
}
export interface ContractExpectation {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    json?: unknown;
    status?: number;
    headers?: Record<string, string>;
    files?: Record<string, string>;
}
/** A workflow step the supervisor performs BEFORE the case's request: restart an owned service (plan §5.3 create → restart → read-back). */
export interface ContractStep { kind: "restart"; service: string; }
export type HttpRunner =
    { kind: "http"; url: string; method: "GET" | "POST"; body?: string } |
    /** Service-bound (Unit D1): the request goes to the OWNED service the e2e supervisor started; unrunnable without it. */
    { kind: "http"; service: string; path: string; method: "GET" | "POST"; body?: string };
export interface ContractCase {
    id: string;
    description: string;
    source: ContractSource;
    inputs: string[];
    runner: { kind: "process"; argv: string[] } | HttpRunner;
    expect: ContractExpectation;
    steps?: ContractStep[];
    replaces?: { id: string; reason: string };
}
export interface ContractManifest { version: 1; cases: ContractCase[]; }
export interface ContractPolicy { version: 1; accepted: Record<string, string>; }
export type ContractState = "passed" | "failed" | "unavailable" | "stale" | "not-run";
export interface ContractEvidence {
    contract: ContractCase;
    id: string;
    digest: string;
    authority: "configured" | "proposed";
    provenance: "matched" | "stale" | "inferred" | "unavailable" | "conflict";
    state: ContractState;
    details: string[];
    durationMs: number;
    inputHash?: string;
    observations?: {
        stdoutSha256: string; stderrSha256: string; stdoutPreview: string; exitCode?: number; status?: number;
        /** The process runner's spawned pid: runtime observations require coverage from THIS process, never from a helper's file (plan 31 §7.4). */ pid?: number;
        /** Which declared observables held (files, stdout, stderr, exitCode, status, json, headers) — a declared, matching exit code or status proves the invocation ended the way the contract expects (§9.4). */ matched?: string[];
        /** Which declared observables differed — the phase evidence a comparison needs to tell an outcome mismatch from a crash. */ mismatched?: string[];
    };
}
export interface ContractReport {
    version: 1;
    cases: ContractEvidence[];
    gaps: string[];
    elapsedMs: number;
    reuse: "none-external-state-unsealed";
}
