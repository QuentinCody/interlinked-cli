import { interpretTestClaim, verifyTestClaim, type TestReceipt } from "./receipt-facts.mjs";

type Node =
    | { id: string; kind: "claim"; text: string; interpretation: "explicit" | "model"; scope: { receiptId: string; sourceIdentity: string; selection: string[] } }
    | { id: string; kind: "receipt"; origin: "tool_result" | "assistant"; result: TestReceipt }
    | { id: string; kind: "run"; completed: boolean; captureComplete: boolean; stableDuringRun: boolean | null;
        nondeterministic: boolean; environment: string | null; selectionIdentity: string | null }
    | { id: string; kind: "input"; path: string; sha256: string; dependenciesComplete: boolean };
interface Edge { id: string; from: string; to: string; kind: "cites" | "generated_by" | "executed" | "used" | "depends_on"; basis: "observed" | "inferred" }
export interface ProvenanceGraph { nodes: Node[]; edges: Edge[] }
export interface CurrentInputs { files: Record<string, string>; environment: string | null; selectionIdentity: string | null }
export interface Assessment { status: "supported" | "contradicted" | "unsupported" | "not_assessable"; reason: string;
    freshness: "current" | "stale" | "unknown"; edgeIds: string[]; inputPaths: string[] }
type Input = Extract<Node, { kind: "input" }>;
type Run = Extract<Node, { kind: "run" }>;
type Claim = Extract<Node, { kind: "claim" }>;
type Receipt = Extract<Node, { kind: "receipt" }>;
interface ObservedRun {
    claim: Claim;
    receipt: Receipt;
    run: Run;
    targets: (id: string, kind: Edge["kind"]) => Node[];
}
const sameSet = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

function inputClosure(graph: ProvenanceGraph, seeds: Input[]): { inputs: Input[]; reason: string | null; edges: string[] } {
    const nodes = new Map(graph.nodes.map(n => [n.id, n]));
    const inputs = [...seeds], seen = new Set(seeds.map(n => n.id)), edges: string[] = [];
    for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index]!;
        if (!input.dependenciesComplete) return { inputs, edges, reason: "dependency_closure_incomplete" };
        for (const edge of graph.edges.filter(e => e.from === input.id && e.kind === "depends_on")) {
            const next = nodes.get(edge.to);
            if (edge.basis !== "observed" || next?.kind !== "input") return { inputs, edges, reason: "dependency_not_observed" };
            edges.push(edge.id);
            if (!seen.has(next.id)) { seen.add(next.id); inputs.push(next); }
        }
    }
    return { inputs, edges, reason: null };
}

function currentInputs(run: Run, inputs: Input[], current: CurrentInputs): Pick<Assessment, "status" | "reason" | "freshness"> | null {
    const unknown = (reason: string) => ({ status: "not_assessable", reason, freshness: "unknown" } as const);
    const stale = (reason: string) => ({ status: "unsupported", reason, freshness: "stale" } as const);
    if (!run.captureComplete || !run.stableDuringRun) return unknown("capture_incomplete_or_run_raced_with_edit");
    if (run.nondeterministic) return unknown("historical_result_not_reusable");
    if (!run.environment || !current.environment || !run.selectionIdentity || !current.selectionIdentity) return unknown("environment_or_selection_not_captured");
    if (run.environment !== current.environment || run.selectionIdentity !== current.selectionIdentity) return stale("environment_or_selection_changed");
    const versions = new Map<string, string>();
    for (const input of inputs) {
        if (!/^[a-f0-9]{64}$/.test(input.sha256) || !/^[a-f0-9]{64}$/.test(current.files[input.path] ?? "")) return unknown("input_identity_missing");
        if (versions.has(input.path) && versions.get(input.path) !== input.sha256) return unknown("multiple_versions_in_one_run");
        versions.set(input.path, input.sha256);
        if (input.sha256 !== current.files[input.path]) return stale(`input_changed:${input.path}`);
    }
    return null;
}

function observedRun(graph: ProvenanceGraph, claimId: string, edgeIds: string[]): ObservedRun | string {
    const nodes = new Map(graph.nodes.map(n => [n.id, n]));
    if (nodes.size !== graph.nodes.length || new Set(graph.edges.map(e => e.id)).size !== graph.edges.length
        || graph.edges.some(e => !nodes.has(e.from) || !nodes.has(e.to))) return "invalid_graph_identity";
    const targets = (id: string, kind: Edge["kind"]) => {
        const edges = graph.edges.filter(e => e.from === id && e.kind === kind && e.basis === "observed");
        edgeIds.push(...edges.map(e => e.id)); return edges.map(e => nodes.get(e.to)!);
    };
    const claim = nodes.get(claimId);
    if (claim?.kind !== "claim" || claim.interpretation !== "explicit") return "claim_interpretation_not_established";
    const receipts = targets(claim.id, "cites"), receipt = receipts[0];
    if (receipts.length !== 1 || receipt?.kind !== "receipt" || receipt.origin !== "tool_result") return "trusted_receipt_not_unique";
    if (receipt.result.id !== receipt.id) return "receipt_identity_mismatch";
    const runs = targets(receipt.id, "generated_by"), run = runs[0];
    if (runs.length !== 1 || run?.kind !== "run" || !run.completed) return "completed_run_not_observed";
    return { claim, receipt, run, targets };
}

/** Evaluation-only current-state claim query. Trusted edges organize evidence; the receipt predicate still decides support. */
export function assessTestProvenance(graph: ProvenanceGraph, claimId: string, current: CurrentInputs): Assessment {
    const edgeIds: string[] = [], inputPaths: string[] = [];
    const unknown = (reason: string): Assessment => ({ status: "not_assessable", reason, freshness: "unknown", edgeIds, inputPaths });
    const observed = observedRun(graph, claimId, edgeIds);
    if (typeof observed === "string") return unknown(observed);
    const { claim, receipt, run, targets } = observed;
    const tests = targets(run.id, "executed"), used = targets(run.id, "used");
    if (!tests.length || !used.length || tests.some(n => n.kind !== "input") || used.some(n => n.kind !== "input")) return unknown("run_inputs_missing");
    const testInputs = tests.filter(n => n.kind === "input"), usedInputs = used.filter(n => n.kind === "input");
    if (!sameSet(testInputs.map(n => n.path), receipt.result.selection ?? [])) return unknown("executed_selection_mismatch");
    const closure = inputClosure(graph, [...new Map([...testInputs, ...usedInputs].map(n => [n.id, n])).values()]);
    edgeIds.push(...closure.edges);
    if (closure.reason) return unknown(closure.reason);
    if (closure.inputs.some(n => !usedInputs.some(input => input.id === n.id))) return unknown("dependency_version_not_captured_by_run");
    inputPaths.push(...usedInputs.map(n => n.path));
    const invalid = currentInputs(run, usedInputs, current);
    if (invalid) return { ...invalid, edgeIds, inputPaths };
    const interpreted = interpretTestClaim(claim.text, claim.scope);
    if (!interpreted) return unknown("unsupported_claim_grammar");
    const verdict = verifyTestClaim(interpreted, receipt.result);
    return { status: verdict.status, reason: verdict.reason, freshness: "current", edgeIds, inputPaths };
}
