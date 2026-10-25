import assert from "node:assert/strict";
import test from "node:test";
import { assessTestProvenance, type ProvenanceGraph, type CurrentInputs } from "./provenance-graph.mjs";

export function fixture(): { graph: ProvenanceGraph; current: CurrentInputs } {
    const graph: ProvenanceGraph = { nodes: [
        { id: "claim", kind: "claim", text: "All 3 executed tests passed.", interpretation: "explicit", scope: { receiptId: "receipt", sourceIdentity: "revision", selection: ["a.test.ts"] } },
        { id: "receipt", kind: "receipt", origin: "tool_result", result: { id: "receipt", completion: "completed", sourceIdentity: "revision", selection: ["a.test.ts"],
            runner: { success: true, numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 } } },
        { id: "run", kind: "run", completed: true, captureComplete: true, stableDuringRun: true, nondeterministic: false, environment: "env1", selectionIdentity: "selected-a" },
        { id: "test", kind: "input", path: "a.test.ts", sha256: "a".repeat(64), dependenciesComplete: true },
        { id: "source", kind: "input", path: "a.ts", sha256: "b".repeat(64), dependenciesComplete: true },
        { id: "config", kind: "input", path: "tsconfig.json", sha256: "c".repeat(64), dependenciesComplete: true },
    ], edges: [
        ["claim", "receipt", "cites"], ["receipt", "run", "generated_by"], ["run", "test", "executed"],
        ["test", "source", "depends_on"], ["run", "test", "used"], ["run", "source", "used"], ["run", "config", "used"],
    ].map(([from, to, kind], i) => ({ id: `e${i}`, from: from!, to: to!, kind: kind as ProvenanceGraph["edges"][number]["kind"], basis: "observed" })) };
    return { graph, current: { environment: "env1", selectionIdentity: "selected-a", files: { "a.test.ts": "a".repeat(64), "a.ts": "b".repeat(64), "tsconfig.json": "c".repeat(64) } } };
}

test("complete observed graph supports only the exact current selection", () => {
    const { graph, current } = fixture();
    assert.equal(assessTestProvenance(graph, "claim", current).status, "supported");
    const claim = graph.nodes[0]!; if (claim.kind !== "claim") throw Error("fixture");
    claim.scope.selection.push("b.test.ts");
    assert.equal(assessTestProvenance(graph, "claim", current).status, "unsupported");
});

test("dependency/configuration revisions invalidate; unrelated edits and exact reverts do not", () => {
    const { graph, current } = fixture();
    for (const path of ["a.ts", "tsconfig.json"]) {
        const changed = structuredClone(current); changed.files[path] = "d".repeat(64);
        assert.equal(assessTestProvenance(graph, "claim", changed).freshness, "stale");
        changed.files[path] = current.files[path]!;
        assert.equal(assessTestProvenance(graph, "claim", changed).status, "supported");
    }
    current.files["unrelated.md"] = "d".repeat(64);
    assert.equal(assessTestProvenance(graph, "claim", current).status, "supported");
});

test("configuration dependencies and receipt identity must be captured too", () => {
    const { graph, current } = fixture();
    graph.nodes.push({ id: "config-base", kind: "input", path: "tsconfig.base.json", sha256: "e".repeat(64), dependenciesComplete: true });
    graph.edges.push({ id: "config-dependency", from: "config", to: "config-base", kind: "depends_on", basis: "observed" });
    current.files["tsconfig.base.json"] = "e".repeat(64);
    assert.equal(assessTestProvenance(graph, "claim", current).reason, "dependency_version_not_captured_by_run");
    graph.edges.push({ id: "used-config-base", from: "run", to: "config-base", kind: "used", basis: "observed" });
    assert.equal(assessTestProvenance(graph, "claim", current).status, "supported");
    const receipt = graph.nodes[1]!; if (receipt.kind !== "receipt") throw Error("fixture");
    receipt.result.id = "another-receipt";
    assert.equal(assessTestProvenance(graph, "claim", current).reason, "receipt_identity_mismatch");
});

test("capture gaps, races, inferred linkage and assistant receipts cannot establish support", () => {
    for (const change of ["missing", "inferred", "assistant", "race", "environment", "opaque", "nondeterministic", "selection"]) {
        const { graph, current } = fixture();
        const run = graph.nodes[2]!, receipt = graph.nodes[1]!, input = graph.nodes[4]!;
        if (run.kind !== "run" || receipt.kind !== "receipt" || input.kind !== "input") throw Error("fixture");
        if (change === "missing") graph.edges = graph.edges.filter(e => e.id !== "e5");
        if (change === "inferred") graph.edges[0]!.basis = "inferred";
        if (change === "assistant") receipt.origin = "assistant";
        if (change === "race") run.stableDuringRun = false;
        if (change === "environment") current.environment = null;
        if (change === "opaque") input.dependenciesComplete = false;
        if (change === "nondeterministic") run.nondeterministic = true;
        if (change === "selection") current.selectionIdentity = null;
        assert.equal(assessTestProvenance(graph, "claim", current).status, "not_assessable", change);
    }
});

test("a trusted path still needs the runner result; cycles terminate and ambiguous citations fail", () => {
    const { graph, current } = fixture();
    graph.edges.push({ id: "cycle", from: "source", to: "test", kind: "depends_on", basis: "observed" });
    const receipt = graph.nodes[1]!; if (receipt.kind !== "receipt") throw Error("fixture");
    receipt.result.runner!.success = false;
    assert.equal(assessTestProvenance(graph, "claim", current).status, "contradicted");
    graph.edges.push({ ...graph.edges[0]!, id: "duplicate" });
    assert.equal(assessTestProvenance(graph, "claim", current).status, "not_assessable");
});
