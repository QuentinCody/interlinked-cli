#!/usr/bin/env node
// Explicit-build paired pilot. Evidence and failed sessions are retained.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enableHarness, stopHarness, harnessCommand, run, setupFixture, loadMetricsModule, readActivityLines, REPO_ROOT } from "./lib/fixture-ops.mjs";

const TASKS = {
    module: { slug: "new-module-with-test" }, rename: { slug: "cross-file-rename" },
    repair: { slug: "fix-failing-test" }, read: { slug: "read-heavy-question" },
    probe: { prompt: "Create scratch/fixture-probe.mjs that reads src/order.js as UTF-8, copies that content into a fixture file inside a fresh os.tmpdir() directory, reads the fixture back and prints its UTF-8 byte length. Run it and write the printed number to PROBE.txt. Leave the original source and tests unchanged. The script must work with different input contents." },
    complexity: { prompt: "Extend score(value) in src/score.js to return value * 2 for integer values 10 through 14 as well as 0 through 9. Keep the existing flat sequence of equality branches and the -1 default. Add tests for the new values, then run npm test. Make one coherent edit where possible." },
};

function hash(content) { return createHash("sha256").update(content).digest("hex"); }
function save(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
}

export function comparisonPlan(tasks, repetitions) {
    return tasks.flatMap(task => Array.from({ length: repetitions }, (_, index) => {
        const arms = index % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];
        return arms.map(arm => ({ task, rep: index + 1, arm }));
    }).flat());
}

export function pairedSummary(cells) {
    const baseline = cells.filter(cell => cell.arm === "baseline"), candidate = cells.filter(cell => cell.arm === "candidate");
    const pairs = baseline.flatMap(left => {
        const right = candidate.find(cell => cell.task === left.task && cell.rep === left.rep);
        return left.success && right?.success ? [{ task: left.task, rep: left.rep, delta: right.seconds - left.seconds }] : [];
    });
    return { baseline_successes: baseline.filter(cell => cell.success).length, candidate_successes: candidate.filter(cell => cell.success).length,
        baseline_sessions: baseline.length, candidate_sessions: candidate.length, infrastructure_failures: cells.filter(cell => cell.infrastructure_error).length,
        paired_seconds: pairs, caveat: "Pilot; time differences include only pairs with two correct completions. Report failures alongside cost. Native usage is separate from ledger warnings." };
}

function options(argv) {
    const opts = { tasks: Object.keys(TASKS).join(","), repeat: "5", model: "claude-fable-5", output: null, baseline: null, candidate: null, execute: false };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === "--run") { opts.execute = true; continue; }
        if (flag === "--dry-run") continue;
        const key = flag.slice(2);
        if (!["tasks", "repeat", "model", "output", "baseline", "candidate"].includes(key)) throw new Error(`Unknown option: ${flag}`);
        const value = argv[++i];
        if (!value) throw new Error(`Missing value: ${flag}`);
        opts[key] = value;
    }
    opts.repeat = Number(opts.repeat); opts.tasks = opts.tasks.split(",");
    if (!Number.isInteger(opts.repeat) || opts.repeat < 1 || opts.tasks.some(task => !TASKS[task])) throw new Error("Invalid tasks or repetitions");
    return opts;
}

function taskSpec(name) {
    const task = TASKS[name];
    if (task.slug) return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "evals/tasks", task.slug, "task.json"), "utf8"));
    return { slug: name, repo_shape: "colocated-tdd", prompt: task.prompt, timeout_s: 420 };
}

function fileSnapshot(dir, prefix = "") {
    const ignored = new Set([".git", ".interlinked", ".claude", ".agents", ".codex", "node_modules"]);
    return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap(entry => {
        if (ignored.has(entry.name) || entry.isSymbolicLink()) return [];
        const relative = path.join(prefix, entry.name);
        return entry.isDirectory() ? fileSnapshot(dir, relative) : [{ path: relative, sha256: hash(fs.readFileSync(path.join(dir, relative))) }];
    });
}

function prepareFixture(item, spec) {
    const dir = setupFixture(spec, `${item.arm}-${item.rep}`);
    if (item.task === "complexity") {
        const branches = Array.from({ length: 10 }, (_, i) => `    if (value === ${i}) return ${i * 2};`).join("\n");
        save(path.join(dir, "src/score.js"), `export function score(value) {\n${branches}\n    return -1;\n}\n`);
        save(path.join(dir, "src/score.test.js"), 'import { expect, it } from "vitest";\nimport { score } from "./score.js";\nit("existing values", () => { expect(score(9)).toBe(18); expect(score(-1)).toBe(-1); });\n');
    }
    const files = fileSnapshot(dir);
    run("git", ["init", "-q"], dir, 10);
    run("git", ["add", "--", ...files.map(file => file.path)], dir, 10);
    run("git", ["-c", "user.name=Interlinked Eval", "-c", "user.email=eval@localhost", "commit", "-qm", "Evaluation fixture"], dir, 10);
    return { dir, files };
}

function enabledBuild(dir, artifact, evidenceDir) {
    enableHarness(dir, "claude", artifact);
    const settings = fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8");
    if (!settings.includes(path.join(path.dirname(artifact), "hook-entry.js"))) throw new Error("Installed hook does not reference selected artifact");
    save(path.join(evidenceDir, "settings.json"), settings);
    const status = harnessCommand(artifact, ["harness", "status", "--json"], dir, 30);
    save(path.join(evidenceDir, "status-before.json"), status.stdout || status.stderr);
    if (status.status !== 0) throw new Error("Selected daemon did not start");
}

function agentCommand(spec, opts, evidenceDir, sessionId) {
    return ["-p", spec.prompt, "--model", opts.model, "--session-id", sessionId,
        "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--disable-slash-commands", "--tools", "Bash,Read,Write,Edit,Glob,Grep", "--dangerously-skip-permissions",
        "--max-turns", "30", "--output-format", "stream-json", "--verbose", "--debug-file", path.join(evidenceDir, "claude-debug.log")];
}

function nativeEvidence(output) {
    const rows = output.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const result = rows.findLast(row => row.type === "result");
    const hooks = rows.filter(row => row.type === "system" && row.subtype === "hook_response");
    const init = rows.find(row => row.type === "system" && row.subtype === "init");
    return { result_subtype: result?.subtype ?? null, usage: result?.usage ?? null, model_usage: result?.modelUsage ?? null,
        reported_cost_usd: result?.total_cost_usd ?? null, resolved_model: init?.model ?? null,
        native_hook_responses: hooks.length, native_hook_output_bytes: hooks.reduce((sum, row) => sum + Buffer.byteLength(row.stdout || "") + Buffer.byteLength(row.stderr || ""), 0),
        model_visible_hook_bytes: null, model_visible_hook_tokens: null,
        delivery_note: "Hook-response bytes describe native transport, not proof of model delivery. Full stream and native transcript retained where available." };
}

function oracleSource(task, dir) {
    const url = file => JSON.stringify(pathToFileURL(path.join(dir, file)).href), header = 'import assert from "node:assert/strict";\n';
    const items = '[{price: 2.5, qty: 3}, {price: 4, qty: 2}]';
    if (task === "module") return header + `const { mean } = await import(${url("src/stats.js")}); for(const [values, answer] of [[[],0], [[2,4,9],5], [[-7,3],-2], [[1.5,2.5],2]]) assert.equal(mean(values), answer);`;
    if (task === "rename") return header + `const mod = await import(${url("src/order.js")}); const {formatReceipt} = await import(${url("src/report.js")}); assert.equal(mod.computeTotal, undefined); assert.equal(mod.calculateTotal(${items}), 15.5); assert.equal(formatReceipt(${items}), "TOTAL: $15.50");`;
    if (task === "repair") return header + `const {add,multiply} = await import(${url("src/calc.js")}); for(const [a,b] of [[2,3],[-7,4],[0,0],[1.5,2.5]]) { assert.equal(add(a,b),a+b); assert.equal(multiply(a,b),a*b); }`;
    if (task === "complexity") return header + `const {score} = await import(${url("src/score.js")}); for(let i=0;i<15;i++) assert.equal(score(i),i*2); for(const i of [-1,15,2.5]) assert.equal(score(i),-1);`;
    return null;
}

function probeOracle(dir, evidenceDir) {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "hce-probe-oracle-")), input = "different fixture content\nπ\n";
    save(path.join(testDir, "src/order.js"), input);
    const script = path.join(testDir, "scratch/fixture-probe.mjs");
    save(script, fs.readFileSync(path.join(dir, "scratch/fixture-probe.mjs"), "utf8"));
    const result = run(process.execPath, [script], testDir, 20);
    save(path.join(evidenceDir, "probe-oracle.json"), { input, status: result.status, stdout: result.stdout, stderr: result.stderr, fixture: testDir });
    return result.status === 0 && Number(result.stdout.trim()) === Buffer.byteLength(input);
}

function protectedChanges(item, fixture) {
    return fixture.files.filter(file => item.task !== "rename" && /(?:test|spec)\.[cm]?[jt]s$/.test(file.path))
        .filter(file => !(item.task === "complexity" && file.path === "src/score.test.js"))
        .filter(file => !fs.existsSync(path.join(fixture.dir, file.path)) || hash(fs.readFileSync(path.join(fixture.dir, file.path))) !== file.sha256);
}

function evaluateFinal(item, fixture, evidenceDir) {
    const { dir, files } = fixture, changed = protectedChanges(item, fixture);
    if (changed.length) return { success: false, reason: "Protected tests changed", changed_tests: changed };
    if (item.task === "read") {
        const answer = fs.readFileSync(path.join(dir, "ANSWER.md"), "utf8");
        return { success: answer.includes("app/parser.py") && answer.includes("unquote") && files.every(file => hash(fs.readFileSync(path.join(dir, file.path))) === file.sha256) };
    }
    if (item.task === "probe") return { success: probeOracle(dir, evidenceDir) && files.every(file => hash(fs.readFileSync(path.join(dir, file.path))) === file.sha256) };
    const script = path.join(evidenceDir, "oracle.mjs");
    save(script, oracleSource(item.task, dir));
    const result = run(process.execPath, [script], dir, 30);
    save(path.join(evidenceDir, "oracle-result.json"), { status: result.status, stdout: result.stdout, stderr: result.stderr });
    return { success: result.status === 0 };
}

function retainNativeTranscript(dir, sessionId, evidenceDir) {
    const transcript = path.join(os.homedir(), ".claude/projects", fs.realpathSync(dir).replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
    if (fs.existsSync(transcript)) fs.copyFileSync(transcript, path.join(evidenceDir, "native-transcript.jsonl"));
}

function evaluateSafely(item, fixture, evidenceDir) {
    try { return evaluateFinal(item, fixture, evidenceDir); }
    catch (error) { return { success: false, oracle_error: error.message }; }
}

function harvest(cell, fixture, evidenceDir, metrics) {
    cell.metrics = metrics.extractEvalMetrics(readActivityLines(fixture.dir));
    const checkFile = path.join(fixture.dir, ".interlinked/check-results.jsonl");
    if (fs.existsSync(checkFile)) fs.copyFileSync(checkFile, path.join(evidenceDir, "check-results.jsonl"));
    save(path.join(evidenceDir, "final-files.json"), fileSnapshot(fixture.dir));
    save(path.join(evidenceDir, "final.diff"), run("git", ["diff", "--", ".", ":!.interlinked"], fixture.dir, 15).stdout || "");
    if (!cell.metrics.turns) cell.infrastructure_error = "No daemon activity receipts for attempted tool calls";
    cell.success = cell.success && !cell.infrastructure_error;
}

function runCell(item, opts, metrics) {
    const evidenceDir = path.join(opts.output, `${item.task}-${item.rep}-${item.arm}`);
    const cell = { ...item, success: false, infrastructure_error: null, seconds: 0 };
    const spec = taskSpec(item.task), fixture = prepareFixture(item, spec), artifact = opts[item.arm], sessionId = randomUUID();
    cell.fixture = fixture.dir;
    save(path.join(evidenceDir, "initial-files.json"), fixture.files);
    try {
        enabledBuild(fixture.dir, artifact, evidenceDir);
        const args = agentCommand(spec, opts, evidenceDir, sessionId);
        save(path.join(evidenceDir, "invocation.json"), { command: "claude", args, cwd: fixture.dir, artifact, sessionId });
        const started = Date.now(), result = run("claude", args, fixture.dir, spec.timeout_s);
        cell.seconds = (Date.now() - started) / 1000;
        save(path.join(evidenceDir, "stream.jsonl"), result.stdout || ""); save(path.join(evidenceDir, "stderr.txt"), result.stderr || "");
        cell.native = nativeEvidence(result.stdout || ""); cell.agent_exit = result.status;
        cell.oracle = evaluateSafely(item, fixture, evidenceDir);
        cell.success = result.status === 0 && cell.oracle.success;
        retainNativeTranscript(fixture.dir, sessionId, evidenceDir);
        harvest(cell, fixture, evidenceDir, metrics);
    } catch (error) { cell.infrastructure_error = error.message; }
    finally { stopHarness(fixture.dir, artifact); save(path.join(evidenceDir, "result.json"), cell); }
    return cell;
}

async function main() {
    const opts = options(process.argv.slice(2)), plan = comparisonPlan(opts.tasks, opts.repeat);
    if (!opts.execute) { process.stdout.write(JSON.stringify({ model: opts.model, sessions: plan.length, plan }, null, 2) + "\n"); return; }
    if (!opts.baseline || !opts.candidate || !opts.output) throw new Error("--run requires --baseline, --candidate and --output");
    for (const key of ["baseline", "candidate", "output"]) opts[key] = path.resolve(opts[key]);
    const artifacts = Object.fromEntries(["baseline", "candidate"].map(arm => [arm, { cli: opts[arm], sha256: hash(fs.readFileSync(opts[arm])), hook_sha256: hash(fs.readFileSync(path.join(path.dirname(opts[arm]), "hook-entry.js"))) }]));
    save(path.join(opts.output, "manifest.json"), { started_at: new Date().toISOString(), options: opts, artifacts, plan, client: run("claude", ["--version"], REPO_ROOT, 10).stdout });
    const metrics = await loadMetricsModule(), cells = [];
    for (const item of plan) {
        const cell = runCell(item, opts, metrics); cells.push(cell);
        save(path.join(opts.output, "results.json"), { cells, summary: pairedSummary(cells) });
        process.stdout.write(JSON.stringify({ task: cell.task, rep: cell.rep, arm: cell.arm, success: cell.success, seconds: cell.seconds, infrastructure_error: cell.infrastructure_error }) + "\n");
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 2; });
