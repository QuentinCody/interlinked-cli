// ===========================================
// Runtime dependency observations — Node V8 coverage of OWNED processes (Unit E4, plan §7.4)
// ===========================================
// The shared edge format plus ONE proven collector: NODE_V8_COVERAGE set on the
// owned services and contract case processes of a supervised run. Edges are
// observed execution (case → source), recorded with their provenance and
// limits. Services are shared across the run's cases, so attribution is
// RUN-level (PE-85): no per-case edge is invented from overlapping timestamps.
// Missing child output is incomplete coverage, never a measured zero. Other
// runtimes need their own collector; absence is an optional gap unless the
// project requires this profile.

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_OBSERVATIONS_FILE = "runtime-observations.jsonl";
export const COVERAGE_DIRECTORY = "coverage";
const MAX_EDGES = 5000;
export interface RuntimeEdge {
    version: 1; runId: string; scenarioIds: string[]; /** Always null today: services are shared, so no case attribution is established (PE-85). */ caseId: null; attribution: "run";
    runtime: { kind: "node"; method: "NODE_V8_COVERAGE" }; source: { path: string; functions: number; covered: number };
}
export interface RuntimeObservationSummary { version: 1; runtime: "node"; method: "NODE_V8_COVERAGE"; attribution: "run"; complete: boolean; files: number; edges: number; limits: string[]; path: string; }
/** The owned processes whose output is EXPECTED (review E3): a missing file for any of them is incomplete coverage, whatever the others flushed. */
export interface ExpectedProcesses { services: Array<{ id: string; pid: number }>; /** Contract cases that ran as processes, each with ITS OWN pid (round 2 R2): coverage must come from that process; a helper's file discharges nothing, and an unrecorded pid is a gap. */ processes: Array<{ id: string; pid: number | null }>; }
export interface CollectOptions { coverageDirectory: string; snapshotRoot: string; runId: string; scenarioIds: string[]; expected?: ExpectedProcesses; }
/** Contract cases execute copied inputs under a per-case workspace (`interlinked-contract-*`); the copy keeps the project-relative path, so the URL maps back (review E4). */
const CONTRACT_WORKSPACE = /^(.*?[\\/]interlinked-contract-[^\\/]+)[\\/]/;
const COVERAGE_FILE = /^coverage-(\d+)-\d+-\d+\.json$/;
interface V8Function { ranges: Array<{ count: number }>; }
interface V8Script { url: string; functions: V8Function[]; }

function canonical(path: string): string { try { return realpathSync(path); } catch { return path; } }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
/** The scripts of one coverage file, or null when the file is not V8's `{ result: [{ url, functions: [{ ranges: [{ count }] }] }] }`. */
function scriptsOf(text: string): V8Script[] | null {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    if (!isRecord(parsed) || !Array.isArray(parsed.result)) return null;
    const scripts: V8Script[] = [];
    for (const item of parsed.result) {
        if (!isRecord(item) || typeof item.url !== "string" || !Array.isArray(item.functions)) return null;
        const functions: V8Function[] = [];
        for (const fn of item.functions) {
            if (!isRecord(fn) || !Array.isArray(fn.ranges)) return null;
            functions.push({ ranges: fn.ranges.map(range => ({ count: isRecord(range) && typeof range.count === "number" ? range.count : 0 })) });
        }
        scripts.push({ url: item.url, functions });
    }
    return scripts;
}
/** Snapshot-relative posix path for a script URL, or null when the script is not project source under the snapshot. */
function sourcePath(url: string, roots: string[]): string | null {
    if (!url.startsWith("file://")) return null;
    let absolute: string;
    try { absolute = canonical(fileURLToPath(url)); } catch { return null; }
    const workspace = CONTRACT_WORKSPACE.exec(absolute)?.[1];
    for (const root of workspace ? [...roots, workspace] : roots) {
        const rel = relative(root, absolute);
        if (!rel || rel.startsWith("..") || rel.startsWith(sep) || rel.split(sep).includes("node_modules")) continue;
        return rel.split(sep).join("/");
    }
    return null;
}
/** E3: every expected owned process must have flushed a coverage file (named `coverage-<pid>-…`); contract processes are counted, services matched by pid. */
function missingOutputs(expected: ExpectedProcesses | undefined, files: string[]): string[] {
    if (!expected) return [];
    const pids = new Set(files.map(name => COVERAGE_FILE.exec(name)?.[1]).filter((pid): pid is string => pid !== undefined));
    const limits = expected.services.filter(row => !pids.has(String(row.pid))).map(row => `owned service ${row.id} (pid ${row.pid}) produced no coverage output; it must exit normally on SIGTERM for V8 to flush — its execution is unobserved`);
    for (const row of expected.processes) {
        if (row.pid === null) limits.push(`contract case ${row.id} ran without a recorded process id; its execution cannot be reconciled with any coverage file`);
        else if (!pids.has(String(row.pid))) limits.push(`contract case ${row.id} (pid ${row.pid}) produced no coverage output; a wrapper, a disabled collector or an untraceable execution is a gap — another process's file never discharges it`);
    }
    return limits;
}
function coveredCount(functions: V8Function[]): number { return functions.filter(fn => (fn.ranges[0]?.count ?? 0) > 0).length; }
function edgeFor(options: CollectOptions, path: string, functions: V8Function[]): RuntimeEdge {
    return { version: 1, runId: options.runId, scenarioIds: [...options.scenarioIds], caseId: null, attribution: "run", runtime: { kind: "node", method: "NODE_V8_COVERAGE" }, source: { path, functions: functions.length, covered: coveredCount(functions) } };
}
/** Merge a script's functions into the per-path accumulator (one Node process per coverage file; the same source may appear in several). */
function accumulate(byPath: Map<string, V8Function[]>, path: string, functions: V8Function[]): void {
    const existing = byPath.get(path);
    if (!existing) { byPath.set(path, functions); return; }
    for (const [index, fn] of functions.entries()) {
        const slot = existing[index];
        if (slot && fn.ranges[0] && slot.ranges[0]) slot.ranges[0].count += fn.ranges[0].count; else if (!slot) existing.push(fn);
    }
}
/** Read every coverage file the owned Node processes wrote; a missing directory or a malformed file is a named limit and makes the summary incomplete. */
export function collectNodeCoverage(options: CollectOptions): { edges: RuntimeEdge[]; summary: RuntimeObservationSummary } {
    const limits: string[] = [], byPath = new Map<string, V8Function[]>();
    const roots = [...new Set([options.snapshotRoot, canonical(options.snapshotRoot)])];
    const files = existsSync(options.coverageDirectory) ? readdirSync(options.coverageDirectory).filter(name => name.startsWith("coverage-") && name.endsWith(".json")).sort() : [];
    if (!files.length) limits.push("no coverage output from owned Node processes: missing child output is incomplete coverage, not a measured zero (a service must exit normally, e.g. handle SIGTERM with process.exit, for V8 to flush)");
    limits.push(...missingOutputs(options.expected, files));
    let parsed = 0;
    for (const name of files) {
        const scripts = scriptsOf(readFileSync(join(options.coverageDirectory, name), "utf8"));
        if (!scripts) { limits.push(`${name} is not a V8 coverage file; its process's execution is unobserved`); continue; }
        parsed += 1;
        for (const script of scripts) { const path = sourcePath(script.url, roots); if (path !== null) accumulate(byPath, path, script.functions); }
    }
    const edges = [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, functions]) => edgeFor(options, path, functions));
    if (edges.length > MAX_EDGES) { limits.push(`${edges.length} edges truncated to ${MAX_EDGES}`); edges.length = MAX_EDGES; }
    return { edges, summary: { version: 1, runtime: "node", method: "NODE_V8_COVERAGE", attribution: "run", complete: parsed > 0 && limits.length === 0, files: parsed, edges: edges.length, limits, path: RUNTIME_OBSERVATIONS_FILE } };
}
/** One JSON line per edge under the run directory (beside the receipt, which records only the summary). Returns the relative file name. */
export function writeRuntimeObservations(runDirectory: string, edges: readonly RuntimeEdge[]): string {
    writeFileSync(join(runDirectory, RUNTIME_OBSERVATIONS_FILE), edges.map(edge => JSON.stringify(edge)).join("\n") + (edges.length ? "\n" : ""));
    return RUNTIME_OBSERVATIONS_FILE;
}
