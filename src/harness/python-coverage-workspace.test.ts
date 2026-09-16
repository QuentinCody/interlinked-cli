import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PythonCoverageRunner, type SpawnFn } from "./coverage-runner.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "interlinked-python-reports-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("Python coverage invocation ownership", () => {
    it("keeps overlapping run reports and databases separate, preserving caller files and cwd", async () => {
        writeFileSync(join(root, "coverage.json"), "user report");
        writeFileSync(join(root, ".coverage"), "user database");
        const databases: string[] = [];
        let arrivals = 0;
        let release: () => void = () => {};
        const bothStarted = new Promise<void>((resolve) => { release = resolve; });
        const spawn: SpawnFn = async (_command, args, options) => {
            const database = options.env!.COVERAGE_FILE!;
            databases.push(database);
            const report = args.find((arg) => arg.startsWith("--cov-report=json:"))!.slice("--cov-report=json:".length);
            const line = ++arrivals;
            writeFileSync(database, String(line));
            writeFileSync(report, JSON.stringify({ files: { "source.py": { executed_lines: [line], missing_lines: [] } } }));
            expect(dirname(report)).toBe(dirname(database));
            expect(options.cwd).toBe(root);
            expect(options.env?.INTERLINKED_PROPERTY_NUMRUNS).toBe("25");
            if (arrivals === 2) release();
            await bothStarted;
            return { status: 0, stdout: "", stderr: "" };
        };
        const runner = new PythonCoverageRunner(spawn);
        const options = { projectRoot: root, coverageDir: root, selectedTests: ["test_source.py"] };
        const results = await Promise.all([runner.run(options), runner.run(options)]);
        expect(results.map((result) => [...result.perFile.get("source.py")!.coveredLines!])).toEqual([[1], [2]]);
        expect(new Set(databases).size).toBe(2);
        expect(databases.every((path) => !existsSync(dirname(path)))).toBe(true);
        expect(readFileSync(join(root, "coverage.json"), "utf8")).toBe("user report");
        expect(readFileSync(join(root, ".coverage"), "utf8")).toBe("user database");
    });

    it.each(["throws", "timeout"])("cleans owned report files after a %s", async (mode) => {
        const spawn: SpawnFn = async () => {
            if (mode === "throws") throw new Error("launch failed");
            return { status: null, stdout: "", stderr: "", error: new Error("timed out") };
        };
        const result = await new PythonCoverageRunner(spawn).run({ projectRoot: root, coverageDir: root });
        expect(result).toMatchObject({ ok: false, testsPassed: null });
        expect(readdirSync(root)).toEqual([]);
    });

    it("reports a preparation failure without launching tests", async () => {
        const file = join(root, "file");
        writeFileSync(file, "not a directory");
        const result = await new PythonCoverageRunner().run({ projectRoot: root, coverageDir: file });
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining("setup failed") });
        expect(readFileSync(file, "utf8")).toBe("not a directory");
    });
});
