import { appendCapturedData, recordCaptureReceipt } from "../lib/data/capture.js";
import { updateCaptureState } from "../lib/data/state.js";
import type { ProjectGraph } from "./project-graph.js";

const GRAPH_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const lastChecked = new Map<string, number>();
/** Reuse the initialized daemon graph; no second recursive source scan on a hook. */
export function captureProjectGraph(cwd: string, projectRoot: string, graph: ProjectGraph): void {
    const key = JSON.stringify([cwd, projectRoot]);
    if (Date.now() - (lastChecked.get(key) ?? 0) < GRAPH_SNAPSHOT_INTERVAL_MS) return;
    const context = { cwd, producer: "harness/data-capture-graph" };
    try {
        updateCaptureState(cwd, `graph:${projectRoot}`, (state) => {
            const now = Date.now();
            if (typeof state.at_ms === "number" && now - state.at_ms < GRAPH_SNAPSHOT_INTERVAL_MS) return { state, result: undefined };
            const files = graph.allFiles();
            const row = { schema: "graph-snapshot.v1", ts: new Date(now).toISOString(), project_root: projectRoot,
                files: files.length, import_edges: files.reduce((sum, file) => sum + graph.getDependencies(file).length, 0),
                resolved_exports: files.reduce((sum, file) => sum + graph.getExports(file).length, 0),
                lines: null, cycle_hints: null, measurement: "initialized project graph; transitive re-exports included" };
            if (!appendCapturedData(context, "graph-history", [row])) throw new Error("graph-write-failed");
            return { state: { at_ms: now }, result: undefined };
        });
        lastChecked.set(key, Date.now());
    } catch { recordCaptureReceipt(context, { source: "graph-history", status: "failed", error: "snapshot-failed" }); }
}
