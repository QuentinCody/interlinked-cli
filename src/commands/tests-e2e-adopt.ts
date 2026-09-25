// `interlinked tests e2e discover|surfaces|adopt|doctor` — plan 31 §5.1 / §14.
// The adoption workflow: inspect a repository (read-only), propose commands
// and behavior mappings, show unresolved gaps, and write EXPLICITLY selected
// configuration. Discovery never accepts inferred expectations; adoption
// strips them. Exit contract: inspection 0; usage/unconfigured/invalid 2;
// refusal or failed prerequisite 1.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { adoptPolicy, type AdoptOptions, type AdoptResult } from "../harness/project-e2e/adopt.js";
import { discoverProjects, type DiscoveryReport, formatDiscovery } from "../harness/project-e2e/discover.js";
import { doctorE2e, formatDoctor } from "../harness/project-e2e/doctor.js";
import { loadE2ePolicy } from "../harness/project-e2e/policy.js";
import { discoverSurfaces, formatSurfaces, mapSurfaces, writeSurfaceInventory } from "../harness/project-e2e/surfaces.js";
import { getOutputMode, output, outputError, type OutputMode } from "../lib/output.js";

export type AdoptionAction = "discover" | "surfaces" | "adopt" | "doctor";
export interface AdoptionOptions {
    cwd?: string; json?: boolean;
    /** discover: write the full report (the adopt input) here. */ out?: string;
    /** surfaces: persist the inventory to its replaceable artifact path. */ write?: boolean;
    /** adopt: a discovery report or policy document. */ from?: string;
    project?: string[]; scenario?: string[]; mode?: string; replace?: boolean;
}
const USAGE = /--from|--mode|policy invalid|unconfigured|ENOENT|JSON|Unexpected/;

function rootOf(options: AdoptionOptions): string { return realpathSync(options.cwd ?? process.cwd()); }
function discover(mode: OutputMode, options: AdoptionOptions): void {
    const report = discoverProjects(rootOf(options));
    const lines = formatDiscovery(report);
    if (options.out) { writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`); lines.push(`report written to ${options.out}; review it, then: interlinked tests e2e adopt --from ${options.out} [--project <id>] [--scenario <id>]`); }
    else lines.push("pass --out <file> to write the report that `tests e2e adopt --from` consumes");
    output(mode, report, { normal: () => lines.join("\n") });
}
function surfaces(mode: OutputMode, options: AdoptionOptions): void {
    const root = rootOf(options);
    const loaded = loadE2ePolicy(root);
    if (loaded.status !== "configured") throw new Error(loaded.status === "unconfigured" ? "unconfigured: no .interlinked/e2e-policy.json; run interlinked tests e2e discover first" : `policy invalid: ${loaded.reason}`);
    const inventory = discoverSurfaces(root, loaded.policy);
    const mappings = mapSurfaces(inventory, loaded.policy);
    const path = options.write ? writeSurfaceInventory(root, inventory) : null;
    const lines = formatSurfaces(inventory, mappings);
    lines.push(path ? `inventory written to ${path} (replaceable; never authority)` : "pass --write to persist the inventory; bind a surface with a scenario's surfaceIds");
    output(mode, { inventory, mappings, path }, { normal: () => lines.join("\n") });
}
function adoptMode(mode: string | undefined): "advisory" | "required" | undefined {
    if (mode === undefined || mode === "advisory" || mode === "required") return mode;
    throw new Error(`--mode must be advisory or required, got ${mode}`);
}
function readProposal(path: string): DiscoveryReport {
    const text = readFileSync(path, "utf8");
    // SAFETY: JSON envelope only; adoptPolicy re-validates the selection with the strict policy parser before any write.
    try { return JSON.parse(text) as DiscoveryReport; } catch (error) { throw new Error(`--from ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}
function adopt(mode: OutputMode, options: AdoptionOptions): void {
    if (!options.from) throw new Error("--from <file> is required: a reviewed discovery report (tests e2e discover --out) or a policy document");
    const request: AdoptOptions = { root: rootOf(options), proposal: readProposal(options.from), atMs: Date.now() };
    if (options.project?.length) request.projectIds = options.project;
    if (options.scenario?.length) request.scenarioIds = options.scenario;
    const selected = adoptMode(options.mode);
    if (selected) request.mode = selected;
    if (options.replace) request.replace = true;
    const result: AdoptResult = adoptPolicy(request);
    output(mode, result, { normal: () => result.notes.join("\n") });
}
function doctor(mode: OutputMode, options: AdoptionOptions): void {
    const report = doctorE2e(rootOf(options), options.project?.[0] ? { projectId: options.project[0] } : {});
    output(mode, report, { normal: () => formatDoctor(report).join("\n") });
    if (report.exitCode !== 0) process.exitCode = report.exitCode;
}
/** discover inspects; surfaces maps; adopt writes only what was selected; doctor diagnoses (exit per report). */
export async function testsE2eAdoptionCommand(action: AdoptionAction, options: AdoptionOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        if (action === "discover") discover(mode, options);
        else if (action === "surfaces") surfaces(mode, options);
        else if (action === "adopt") adopt(mode, options);
        else doctor(mode, options);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputError(mode, message);
        process.exitCode = USAGE.test(message) ? 2 : 1;
    }
}
