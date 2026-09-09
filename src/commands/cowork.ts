import { readFileSync } from "node:fs";
import { createCoworkBridge } from "../lib/cowork/bridge.js";
import { coworkCapabilities } from "../lib/cowork/capabilities.js";
import { checkCoworkArtifact } from "../lib/cowork/artifacts.js";
import { packageCoworkPlugin } from "../lib/cowork/package.js";
import { DEFAULT_COWORK_POLICY, parseCoworkPolicy } from "../lib/cowork/policy.js";
import { COWORK_PROBE_PROMPT } from "../lib/cowork/probe.js";
import { summarizeCoworkReceipts } from "../lib/cowork/receipts.js";
import { verifyCoworkWorkspace } from "../lib/cowork/workspace.js";
import { analyzeCoworkConformance } from "../lib/cowork/conformance.js";

export function coworkCapabilitiesCommand(): void { console.log(JSON.stringify(coworkCapabilities(), null, 2)); }
export function coworkProbePromptCommand(): void { console.log(COWORK_PROBE_PROMPT); }
export function coworkReportCommand(path: string, options: { effects?: string }): void {
    const receipts = readFileSync(path, "utf8");
    const report = options.effects ? analyzeCoworkConformance(receipts, readFileSync(options.effects, "utf8")) : summarizeCoworkReceipts(receipts);
    console.log(JSON.stringify(report, null, 2));
}

export function coworkPackageCommand(options: { output: string; policy?: string; probe?: boolean }): void {
    const policy = options.policy ? parseCoworkPolicy(JSON.parse(readFileSync(options.policy, "utf8"))) : structuredClone(DEFAULT_COWORK_POLICY);
    if (options.probe) policy.mode = "probe";
    console.log(JSON.stringify(packageCoworkPlugin({ output: options.output, policy }), null, 2));
}

export function coworkArtifactCommand(path: string): void {
    const report = checkCoworkArtifact(path);
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "unmeasured" || report.findings.some(finding => finding.severity === "error")) process.exitCode = 1;
}

export async function coworkVerifyCommand(root: string): Promise<void> {
    const report = await verifyCoworkWorkspace(root);
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "unmeasured" || report.report.results.some(row => row.severity === "error")) process.exitCode = 1;
}

export async function coworkBridgeCommand(options: { workspace: string; root: string; runtimeRoot: string; tokenEnv: string; port: string }): Promise<void> {
    const token = process.env[options.tokenEnv];
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid bridge port");
    if (!token) throw new Error("Cowork bridge token environment variable is unset");
    const server = createCoworkBridge({ token, workspace: { id: options.workspace, hostRoot: options.root, runtimeRoot: options.runtimeRoot } });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        // interlinked-ignore: ubs_hardcoded_localhost — deliberate loopback-only authenticated bridge; remote exposure belongs to an explicitly configured HTTPS proxy.
        server.listen(port, "127.0.0.1", resolve);
    });
    console.log(JSON.stringify({ status: "listening", address: server.address(), workspace: options.workspace, remoteReachability: "unmeasured" }));
    const stop = (): void => { server.close(); server.closeIdleConnections(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
}
