import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Append writers outside the transport/server families. Census test pins growth. */
export const LEDGER_WRITERS = [
    "src/commands/scanner.ts", "src/commands/scratch.ts", "src/commands/verify/verify-summary.ts",
    "src/harness/agent-io/store.ts", "src/harness/assertion-waiver-log.ts", "src/harness/background-task-log.ts",
    "src/harness/baseline-autofold.ts", "src/harness/break-glass.ts", "src/harness/coverage-obligation-ledger.ts",
    "src/harness/crap-telemetry.ts", "src/harness/daemon-ledger.ts", "src/harness/ephemeral-write-log.ts",
    "src/harness/error-history.ts", "src/harness/failure-record.ts", "src/harness/findings/corpus.ts",
    "src/harness/findings/simplification-record.ts", "src/harness/gate-reach-collect.ts", "src/harness/graph-prediction-cache.ts",
    "src/harness/guard-prediction.ts", "src/harness/latency-log.ts", "src/harness/mutation/manifest.ts", "src/harness/mutation/mutation-cloud-v3-finding-delivery.ts",
    "src/harness/mutation/run-log.ts", "src/harness/obligation-ledger-io.ts", "src/harness/plan-capture.ts",
    "src/harness/policy-classifier.ts", "src/harness/project-e2e/ledger.ts", "src/harness/project-e2e/policy-changes.ts", "src/harness/project-e2e/requests.ts", "src/harness/project-e2e/stability.ts","src/harness/replay/eval-ledger.ts", "src/harness/replay/inference-store.ts",
    "src/harness/replay/state-archive.ts", "src/harness/replay/tree-snapshot.ts", "src/harness/spec/reconciliation.ts",
    "src/harness/stop-digest-state.ts", "src/harness/telemetry-spool.ts", "src/harness/timeline-writer.ts",
    "src/lib/audit-chain.ts", "src/lib/collection/writer.ts", "src/lib/cowork/receipts.ts", "src/lib/data/capture.ts",
    "src/lib/file-mutation-lock.ts", "src/lib/file-suffix-replacement.ts", "src/lib/guard-state.ts",
    "src/lib/hook-transport-receipt.ts", "src/lib/local-activity-sync.ts", "src/lib/local-activity.ts",
    "src/lib/manual-debt-marker-record.ts", "src/lib/mcp-recorder/writer.ts", "src/lib/metrics/evidence-run.ts",
    "src/lib/metrics/execution-journal.ts", "src/lib/settings-validator.ts", "src/lib/viz/test-events.ts",
] as const;
const writers = new Set<string>(LEDGER_WRITERS);

export function isProductSource(path: string): boolean {
    return path.startsWith("src/") && /\.tsx?$/.test(path)
        && !path.startsWith("src/e2e/")
        && path !== "src/harness/adapters/test-output.ts" // Vitest assertion helpers, not shipped runtime.
        && !/\.(?:test|spec|graph|d)\.tsx?$/.test(path)
        && !/(?:^|\/)(?:__tests__|__fixtures__|__mocks__)(?:\/|$)/.test(path);
}

export function isGeneratedHookSource(path: string): boolean {
    return path === "src/lib/hooks-template.ts" || path.startsWith("src/lib/hook-template-chunks/");
}

/**
 * Plan 31 §15: the boundary list below is Interlinked's OWN self-test policy. It applies only inside the Interlinked
 * checkout (package name `interlinked-cli`); in any other repository the project e2e policy is the only e2e obligation.
 */
export function isInterlinkedCheckout(cwd: string): boolean {
    try {
        const parsed: unknown = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
        return typeof parsed === "object" && parsed !== null && "name" in parsed && parsed.name === "interlinked-cli";
    } catch {
        return false; // no manifest or an unreadable one: not this checkout
    }
}

export function isBoundaryFile(file: string): boolean {
    const path = file.replaceAll("\\", "/");
    if (!isProductSource(path)) return false;
    return writers.has(path) || /^src\/hook-entry[^/]*\.ts$/.test(path)
        || path.startsWith("src/harness/adapters/") || path.startsWith("src/harness/server/")
        || isGeneratedHookSource(path) || /^src\/lib\/hook-installers[^/]*\.ts$/.test(path)
        || /^(?:src\/lib\/hooks|src\/harness\/(?:server|daemon-client|legacy-client|session-paths|startup-lock)|src\/harness\/evaluator\/(?:pre-tool|pre-tool-pipeline|post-tool))\.ts$/.test(path);
}
