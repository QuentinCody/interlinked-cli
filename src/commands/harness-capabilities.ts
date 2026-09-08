import { join } from "node:path";
import { existsSync } from "node:fs";
import type { OptionValues } from "commander";
import { buildAllAdapters } from "../harness/adapters/index.js";
import { ecosystemCatalog } from "../harness/adapters/ecosystem-catalog.js";
import { describeHookCapability } from "../harness/adapters/hook-contract.js";
import { createDaemonClient } from "../harness/daemon-client.js";
import { isHookCoverageReport, type HookCoverageReport, type HookCoverageRequest } from "../harness/hook-coverage-control.js";
import { manifestPath, readManifestState } from "../harness/installer.js";
import { hashHookDefinition, readHookRuntimeReceipt } from "../lib/hook-runtime-receipt.js";
import { output, getOutputMode } from "../lib/output.js";
import { getFramedSocketPath, getSocketPath } from "./harness-process.js";
import { queryHarness } from "./harness-status-helpers.js";

/** Raw repo daemon and framed-only deployments share the same control handler. */
export async function queryHookCoverage(cwd: string, request: HookCoverageRequest): Promise<HookCoverageReport> {
    if (!existsSync(getSocketPath(cwd))) return queryFramedCoverage(cwd, request);
    const raw = await queryHarness(cwd, { hook_event: "HookCoverage", request });
    if (typeof raw?.additional_context === "string") {
        try { const report: unknown = JSON.parse(raw.additional_context); if (isHookCoverageReport(report)) return report; }
        catch { /* Intentional: a stale raw response is not evidence; try the framed control below. */ }
    }
    if (request.operation !== "status") return { readiness: "unmeasured", reason: "Coverage mutation response unavailable; inspect status before retrying. The operation may already have completed." };
    return queryFramedCoverage(cwd, request);
}

async function queryFramedCoverage(cwd: string, request: HookCoverageRequest): Promise<HookCoverageReport> {
    try {
        const report = await createDaemonClient(getFramedSocketPath(cwd, undefined)).call("daemon.coverage", request);
        return isHookCoverageReport(report) ? report : { readiness: "unmeasured", reason: "Invalid coverage daemon response; inspect status before retrying a mutation" };
    }
    catch (error) { return { readiness: "unmeasured", reason: `Coverage daemon unavailable or response lost; inspect status before retrying a mutation: ${String(error)}` }; }
}

export function hookCapabilityInventory(cwd: string) {
    const manifest = readManifestState(manifestPath(cwd));
    const runtime = readHookRuntimeReceipt(join(cwd, ".interlinked", "hook-runtime.json"));
    return {
        schema: 1, catalog: ecosystemCatalog, translationLog: join(cwd, ".interlinked", "hook-translations.jsonl"),
        installationManifest: manifest,
        adapters: buildAllAdapters().map(adapter => {
            const observed = runtime?.providers[adapter.id];
            const currentHash = hashHookDefinition(join(cwd, adapter.capabilities.project_hook_path));
            return {
                provider: adapter.id, label: adapter.label, lastEmission: observed ?? null,
                definitionMatchesLastEmission: Boolean(currentHash && observed?.definition_sha256 === currentHash),
                events: adapter.capabilities.events.map(event => describeHookCapability(adapter.capabilities,
                    { provider: adapter.id, host: "unknown", mode: "unknown" }, { name: event.name, observed: observed?.native_event === event.name })),
            };
        }),
    };
}

export async function harnessCapabilitiesCommand(opts: OptionValues): Promise<void> {
    const inventory = hookCapabilityInventory(process.cwd());
    const coverage = await queryHookCoverage(process.cwd(), { operation: "status" });
    const result = { ...inventory, coverage };
    output(getOutputMode(opts), result, {
        json: () => result,
        normal: () => [
            `${inventory.catalog.surfaces.length} documented runtime profiles; ${inventory.adapters.length} installable adapters.`,
            ...inventory.adapters.map(adapter => `${adapter.label}: ${adapter.events.filter(event => event.subscription === "selected").length} selected events; last emission ${adapter.lastEmission?.native_event ?? "unmeasured"}; enforcement unmeasured`),
            `Filesystem observation: ${coverage.readiness}; ${coverage.pending?.length ?? "unknown"} pending file versions.`,
            "Use --json for the full event/control checklist, sources, installation records and coverage identities.",
        ].join("\n"),
    });
}

export async function harnessCoverageCommand(request: HookCoverageRequest, opts: OptionValues): Promise<void> {
    const result = await queryHookCoverage(process.cwd(), request);
    output(getOutputMode(opts), result, { json: () => result, normal: () => JSON.stringify(result, null, 2) });
    if (request.operation !== "status" && result.changed !== true) process.exitCode = 1;
}
