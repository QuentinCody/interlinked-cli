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
export interface ContractCase {
    id: string;
    description: string;
    source: ContractSource;
    inputs: string[];
    runner: { kind: "process"; argv: string[] } |
        { kind: "http"; url: string; method: "GET" | "POST"; body?: string };
    expect: ContractExpectation;
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
    observations?: { stdoutSha256: string; stderrSha256: string; stdoutPreview: string; exitCode?: number; status?: number };
}
export interface ContractReport {
    version: 1;
    cases: ContractEvidence[];
    gaps: string[];
    elapsedMs: number;
    reuse: "none-external-state-unsealed";
}
