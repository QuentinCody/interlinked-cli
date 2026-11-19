import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots = [];
const fresh = () => {
    const directory = mkdtempSync(join(tmpdir(), "study-driver-"));
    roots.push(directory);
    return directory;
};
afterEach(() => {
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function run(driver, action, runDir, cwd = fresh()) {
    const path = fileURLToPath(new URL(`../semantic-relations/${driver}.ts`, import.meta.url));
    return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), path, action, runDir],
        { cwd, encoding: "utf8", timeout: 35000 });
}

it("describes both runtime recipes without creating a study or invoking a model", () => {
    const root = fresh();
    for (const driver of ["runtime-evaluation", "runtime-probes"]) {
        const result = run(driver, "--help", root);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("RUN_DIR");
    }
    expect(readdirSync(root)).toEqual([]);
});

it("requires the fresh run's inputs before copying source or initializing a capture repository", () => {
    const root = fresh();
    const result = run("runtime-evaluation", "prepare", root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(join(root, "heap-measurements.json"));
    expect(existsSync(join(root, "repo"))).toBe(false);
    writeFileSync(join(root, "heap-measurements.json"), "{}");
    writeFileSync(join(root, "engines.json"), "{}");
    const malformed = run("runtime-evaluation", "prepare", root);
    expect(malformed.stderr).toContain("array of engine definitions");
    expect(existsSync(join(root, "repo"))).toBe(false);
});

it("preserves an existing probe result and refuses an unsafe run label before launching children", () => {
    const root = fresh(), study = join(root, "study");
    mkdirSync(study);
    const resultFile = join(study, "runtime-probes-local.json");
    writeFileSync(resultFile, "previous evidence");
    for (const label of ["local", "../outside"]) {
        const result = run("runtime-probes", label, root);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(label === "local" ? "already exists" : "Invalid probe label");
    }
    expect(readFileSync(resultFile, "utf8")).toBe("previous evidence");
    expect(readdirSync(root)).toEqual(["study"]);
});

it("writes observed local child outcomes into the selected run directory", () => {
    const root = fresh();
    const repository = fileURLToPath(new URL("../", import.meta.url));
    const result = run("runtime-probes", "local", root, repository);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(root, "study/runtime-probes-local.json"), "utf8"));
    const reports = new Map(report.results.map(row => [row.name, JSON.parse(row.stdout.trim())]));
    expect(reports.get("success").report).toMatchObject({ exitCode: 0, verdict: "exit" });
    expect(reports.get("failure").report).toMatchObject({ exitCode: 3, verdict: "exit" });
    expect(reports.get("external-signal").report).toMatchObject({ exitCode: 75, verdict: "interrupted" });
    expect(reports.get("own-75").report).toMatchObject({ exitCode: 75, verdict: "exit" });
    expect(readdirSync(join(root, "probes"))).toHaveLength(1);
}, 45000);
