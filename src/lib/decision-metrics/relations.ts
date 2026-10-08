import type { Interpretation } from "./types.js";

export interface RelationEdge {
    left: string;
    right: string;
    relation: string;
}
export interface GoalClusters {
    groups: string[][];
    contradictions: RelationEdge[];
    unresolved: RelationEdge[];
    missingPairs: number;
}

export function clusterGoals(nodes: string[], edges: RelationEdge[]): GoalClusters {
    if (new Set(nodes).size !== nodes.length) throw new Error("duplicate goal nodes");
    const parent = new Map(nodes.map((id) => [id, id]));
    function root(id: string): string {
        if (!parent.has(id)) throw new Error("unknown goal node");
        while (parent.get(id) !== id) id = parent.get(id)!;
        return id;
    }
    const seen = new Set<string>();
    for (const edge of edges) {
        const key = JSON.stringify([edge.left, edge.right].sort());
        if (seen.has(key) || edge.left === edge.right)
            throw new Error("duplicate or self goal edge");
        seen.add(key);
        const a = root(edge.left),
            b = root(edge.right);
        if (["same_goal", "supporting"].includes(edge.relation)) parent.set(b, a);
    }
    const groups = new Map<string, string[]>();
    for (const node of nodes) {
        const id = root(node);
        groups.set(id, [...(groups.get(id) ?? []), node]);
    }
    return {
        groups: [...groups.values()],
        contradictions: edges.filter(
            (edge) => edge.relation === "independent" && root(edge.left) === root(edge.right),
        ),
        unresolved: edges.filter(
            (edge) => !["same_goal", "supporting", "independent"].includes(edge.relation),
        ),
        missingPairs: (nodes.length * (nodes.length - 1)) / 2 - edges.length,
    };
}

export function obligationStatus(
    obligation: Interpretation,
    satisfaction: Interpretation | null,
): string {
    if (obligation.status !== "answered") return obligation.status;
    if (obligation.value === "no_work") return "no_work_required";
    if (!satisfaction) return obligation.value === "verify_only" ? "verify_only" : "unassessed";
    if (satisfaction.status !== "answered") return satisfaction.status;
    if (!["satisfied", "missing", "verify_only"].includes(String(satisfaction.value)))
        return "insufficient_evidence";
    return String(satisfaction.value);
}

export function reconcilePreference(forward: string, reverse: string): string {
    const swap: Record<string, string> = {
        left: "right",
        right: "left",
        tie: "tie",
        insufficient_evidence: "insufficient_evidence",
    };
    if (!Object.hasOwn(swap, forward) || !Object.hasOwn(swap, reverse))
        return "insufficient_evidence";
    return forward === swap[reverse] ? forward : "order_sensitive";
}

export interface DecisionNode {
    id: string;
    dependencies: string[];
    run: (answers: Record<string, Interpretation>) => Promise<Interpretation>;
}

function topologicalOrder(nodes: DecisionNode[]): DecisionNode[] {
    if (nodes.length > 1000 || new Set(nodes.map((node) => node.id)).size !== nodes.length)
        throw new Error("invalid decision graph population");
    const pending = new Map(nodes.map((node) => [node.id, node]));
    const ordered: DecisionNode[] = [];
    const seen = new Set<string>();
    while (pending.size) {
        const ready = [...pending.values()].filter((node) =>
            node.dependencies.every((id) => seen.has(id)),
        );
        if (!ready.length) throw new Error("decision graph contains a cycle or missing dependency");
        for (const node of ready) {
            ordered.push(node);
            seen.add(node.id);
            pending.delete(node.id);
        }
    }
    return ordered;
}

export async function decisionGraph(
    nodes: DecisionNode[],
    deadline = Infinity,
): Promise<Record<string, Interpretation>> {
    const ordered = topologicalOrder(nodes);
    const answers: Record<string, Interpretation> = Object.create(null);
    for (const node of ordered) {
        if (
            Date.now() >= deadline ||
            node.dependencies.some((id) => answers[id]?.status !== "answered")
        ) {
            answers[node.id] = {
                status: "unassessed",
                value: null,
                reason: "dependency unresolved or deadline exhausted",
            };
            continue;
        }
        try {
            answers[node.id] = await node.run(answers);
        } catch {
            answers[node.id] = { status: "failed", value: null, reason: "decision node failed" };
        }
    }
    return answers;
}
