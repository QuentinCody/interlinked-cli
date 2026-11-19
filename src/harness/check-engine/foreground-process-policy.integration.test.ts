import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CheckEngine } from "./index.js";
import { runProcessAsync } from "./spawn-async.js";
import { parseCompleteSemgrepReport } from "./tool-runners/generic-process-verdict.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("retains the tail finding of a complete project scan beyond the background capture bound", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "foreground-engine-")));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(root, "a.ts"), "const first = 1;\nconst last = 2;\n");
	const scanner = join(bin, "semgrep");
	writeFileSync(scanner, `#!${process.execPath}\nconst path = require('node:path');\nconst item = (line,id,message) => ({path:path.join(process.cwd(),'a.ts'),start:{line,col:1},check_id:id,extra:{message}});\nprocess.stdout.write(JSON.stringify({results:[item(1,'large','x'.repeat(11*1024*1024)),item(2,'tail','tail finding')],errors:[]}));\n`);
	chmodSync(scanner, 0o700);
	vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
	const engine = new CheckEngine(root);
	vi.spyOn(engine, "discoverTools").mockReturnValue([{ id: "semgrep", available: true }]);
	const report = await engine.runChecksAsync({ projectRoot: root, mode: "project" }, { admissionAlreadyHeld: true, resourcePolicy: "foreground-verify" });
	expect(report.skipped).toEqual([]);
	expect(report.results.map(result => result.ruleId)).toEqual(["large", "tail"]);
	expect(report.toolsRun.map(tool => tool.id)).toEqual(["semgrep"]);
}, 10_000);

const installedSemgrep = spawnSync("which", ["semgrep"], { encoding: "utf8", timeout: 1000 });
it.skipIf(installedSemgrep.status !== 0)("respects project Gitignore while preserving explicit ignored file scanning", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "semgrep-ignore-")));
	roots.push(root);
	execFileSync("git", ["init", "--quiet", root]);
	writeFileSync(join(root, ".gitignore"), "ignored.js\n");
	writeFileSync(join(root, "visible.js"), 'eval("fixture");\n');
	writeFileSync(join(root, "ignored.js"), 'eval("fixture");\n');
	const rule = join(root, "rule.yml");
	writeFileSync(rule, "rules:\n- id: fixture-eval\n  pattern: eval(...)\n  languages: [javascript]\n  message: fixture finding\n  severity: WARNING\n");
	const args = ["scan", "--config", rule, "--json", "--metrics=off", "--disable-version-check", "--timeout=0", "--max-target-bytes=0"];
	const options = { cwd: root, timeout: 10_000, env: { SEMGREP_SETTINGS_FILE: join(root, "settings.yml"), SEMGREP_LOG_FILE: join(root, "semgrep.log") } };
	const project = await runProcessAsync(installedSemgrep.stdout.trim(), [...args, "."], options);
	expect(project.code).toBe(0);
	expect(parseCompleteSemgrepReport(project.stdout, root).map(row => row.file)).toEqual(["visible.js"]);
	const selected = await runProcessAsync(installedSemgrep.stdout.trim(), [...args, "--no-git-ignore", "ignored.js"], options);
	expect(selected.code).toBe(0);
	expect(parseCompleteSemgrepReport(selected.stdout, root).map(row => row.file)).toEqual(["ignored.js"]);
}, 30_000);
