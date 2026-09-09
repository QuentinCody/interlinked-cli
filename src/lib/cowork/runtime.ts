import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../json-types.js";
import { encodeCoworkVerdict, evaluateCoworkInput, parseCoworkEvent, type CoworkEvent, type CoworkVerdict } from "./native.js";
import { parseCoworkPolicy, type CoworkBridgeConfig } from "./policy.js";
import { digest, recordCoworkReceipt } from "./receipts.js";
import { coworkProbeOutput, probeControl } from "./probe.js";
import { checkCoworkArtifact } from "./artifacts.js";
import { nativePath } from "./native.js";
import { extname } from "node:path";
import { coworkFileState, sameCoworkFileState } from "./file-state.js";

function checkWrittenArtifact(event: CoworkEvent, verdict: CoworkVerdict): CoworkVerdict {
    if (event.event !== "PostToolUse" || event.tool !== "Write") return verdict;
    const path = nativePath(event);
    if (!path || ![".md", ".txt", ".csv", ".tsv", ".html", ".docx", ".xlsx", ".pptx"].includes(extname(path).toLowerCase())) return verdict;
    try {
        const artifact = checkCoworkArtifact(path);
        const feedback = `[interlinked:cowork] Artifact ${artifact.sha256}: ${artifact.findings.map(row => `${row.check}: ${row.message}`).join("; ") || "listed artifact checks completed"}. Workspace tests, rendering, and factual verification remain unmeasured.`;
        return { ...verdict, checks: [...verdict.checks, ...artifact.checks], context: [verdict.context, feedback].filter(Boolean).join("\n") };
    } catch { return { ...verdict, unmeasured: [...verdict.unmeasured, "artifact_bytes_unavailable"] }; }
}

async function bridgeVerdict(config: CoworkBridgeConfig, event: CoworkEvent): Promise<CoworkVerdict> {
    const token = process.env[config.tokenEnv];
    if (!token) throw new Error("Configured Cowork bridge credential unavailable");
    const path = nativePath(event);
    if (!path) throw new Error("Bridge requires a native file target");
    const fileState = coworkFileState(path);
    const response = await fetch(config.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(config.timeoutMs),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ schema: 1, workspace: config.workspace, event: event.raw, fileState }),
    });
    if (!response.ok) throw new Error(`Cowork bridge returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!sameCoworkFileState(fileState, coworkFileState(path))) throw new Error("Native file changed during host evaluation");
    if (!isJsonObject(value) || !["allow", "deny", "ask", "observe"].includes(String(value.decision)) || !Array.isArray(value.checks) || !Array.isArray(value.unmeasured)) throw new Error("Invalid Cowork bridge verdict");
    if (![...value.checks, ...value.unmeasured].every(item => typeof item === "string")) throw new Error("Invalid Cowork bridge check names");
    const decision = value.decision === "ask" ? "ask" : value.decision === "deny" ? "deny" : value.decision === "allow" ? "allow" : "observe";
    return { decision, checks: value.checks, unmeasured: value.unmeasured,
        ...(typeof value.reason === "string" ? { reason: value.reason } : {}), ...(typeof value.context === "string" ? { context: value.context } : {}) };
}

export async function runCoworkHook(root: string, raw: unknown, expectedEvent: string): Promise<Record<string, unknown> | null> {
    const event = parseCoworkEvent(raw, expectedEvent);
    const policyText = readFileSync(join(root, "policy.json"), "utf8");
    const policy = parseCoworkPolicy(JSON.parse(policyText));
    let verdict = evaluateCoworkInput(event, policy);
    if (policy.bridge && verdict.decision !== "deny" && ["PreToolUse", "PostToolUse"].includes(event.event)) {
        const remote = await bridgeVerdict(policy.bridge, event);
        verdict = { ...remote, checks: [...verdict.checks, ...remote.checks] };
    }
    verdict = checkWrittenArtifact(event, verdict);
    const control = policy.mode === "probe" ? probeControl(event) : undefined;
    if (control) verdict.probeControl = control;
    const evidenceRoot = join(root, "evidence");
    recordCoworkReceipt(join(evidenceRoot, "events.jsonl"), event, verdict, digest(policyText));
    if (policy.mode === "probe") {
        const output = await coworkProbeOutput(event, evidenceRoot);
        if (output) return output;
    }
    return encodeCoworkVerdict(event.event, verdict);
}
