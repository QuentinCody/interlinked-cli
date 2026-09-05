import { dataHealth } from "../lib/data/health.js";
import { isJsonObject } from "../lib/json-types.js";
import { thinkingCaptureCheck } from "./doctor-capture.js";
import type { CheckResult } from "./doctor-checks.js";

function dataCaptureHealthCheck(cwd: string): CheckResult {
    try {
        const health = dataHealth(cwd);
        if (health.discovery_complete !== true) return { name: "Local data producers", status: "warn",
            message: "Data discovery is incomplete; producer coverage is unavailable. Run 'interlinked data health' for details." };
        const sources = Array.isArray(health.sources) ? health.sources.filter(isJsonObject) : [];
        const failures = sources.filter((source) => source.state === "failed");
        const unmeasured = sources.filter((source) => source.state === "unmeasured").length;
        return { name: "Local data producers", status: failures.length || unmeasured ? "warn" : "pass",
            message: `${failures.length} latest producer failure(s); ${unmeasured} populated sources without recent receipts. Run 'interlinked data health' for coverage.` };
    } catch (error) {
        return { name: "Local data producers", status: "warn", message: error instanceof Error ? error.message : String(error) };
    }
}

export function captureChecks(cwd: string): CheckResult[] {
    return [thinkingCaptureCheck(cwd), dataCaptureHealthCheck(cwd)];
}
