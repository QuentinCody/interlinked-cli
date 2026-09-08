import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerMetricsCommands } from "../registrars/metrics.js";
import { isJsonObject } from "../lib/json-types.js";
import { parseScoreSnapshot } from "../lib/metrics/score-snapshot.js";
import { compareScoreSnapshots } from "../lib/metrics/score-compare.js";

const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "metrics-cli-")); roots.push(root);
    writeFileSync(join(root, "index.js"), "export function answer() { return 42; }\n");
    return root;
}
async function run(args: string[]): Promise<unknown> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation(value => { lines.push(String(value)); });
    const program = new Command().exitOverride(); registerMetricsCommands(program);
    await program.parseAsync(["metrics", ...args], { from: "user" });
    return JSON.parse(lines.join("\n"));
}
it("exposes the new report through real CLI parsing and inherits root options", async () => {
    const value = await run(["--cwd", fixture(), "--json", "score"]);
    const snapshot = parseScoreSnapshot(value);
    expect(snapshot.profile.id).toBe("interlinked-slop-v1");
    expect(snapshot.metrics.some(row => row.id === "mutation.survivors" && row.state === "missing")).toBe(true);
    expect(snapshot.rankingEligible).toBe(false);
});
it("preserves the explicitly selected legacy structure profile", async () => {
    const value = await run(["score", "--cwd", fixture(), "--json", "--profile", "structure-v1"]);
    expect(isJsonObject(value) && value.schemaVersion).toBe(1);
    expect(isJsonObject(value) && value.structuralScore).toBe(0);
});
it("catalogs every check and explains a diagnostic metric", async () => {
    const catalog = await run(["catalog", "--json"]);
    expect(isJsonObject(catalog) && Array.isArray(catalog.checks) && catalog.checks.length).toBeGreaterThan(100);
    const explanation = await run(["explain", "coverage.crap", "--cwd", fixture(), "--json"]);
    expect(isJsonObject(explanation) && explanation.groups).toEqual([]);
});
it("withholds composite comparisons when evidence is incomplete", async () => {
    const root = fixture(), value = await run(["score", "--cwd", root, "--json"]), snapshot = parseScoreSnapshot(value);
    const comparison = compareScoreSnapshots(snapshot, snapshot);
    expect(comparison.comparable).toBe(false);
    expect(comparison.compositeDelta).toBeNull();
    expect(comparison.metrics.find(row => row.id === "tokens")?.scoreDelta).toBe(0);
});
it("reports invalid profiles as command failures", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation(value => { errors.push(String(value)); });
    const program = new Command().exitOverride(); registerMetricsCommands(program);
    await program.parseAsync(["metrics", "score", "--profile", "invalid", "--json"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(errors.join()).toContain("Profile must be");
});
