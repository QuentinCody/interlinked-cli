#!/usr/bin/env node
// ============================================================================
// Tarball smoke — project e2e surface (plan 31 Unit F2)
// ============================================================================
// Invoked by scripts/smoke-tarball-install.sh AFTER the packed tarball is
// installed into a throwaway project. Builds a git-initialized HOST project
// from the TypeScript CLI fixture (copied as data; the host never imports the
// Interlinked source tree), then drives the installed `interlinked` bin only:
//   doctor → check (no evidence ⇒ 1) → run (0) → check (0)
//   → check --staged (0) → check --revision HEAD (0)
//   → unstaged source edit ⇒ check (1, stale) but check --staged (0)   [PE-35]
// Every exit code is asserted; any deviation fails the smoke.
//
// Usage: node scripts/smoke-tarball-e2e.mjs <interlinked-bin> <fixture-dir> <host-dir>
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [bin, fixture, host] = process.argv.slice(2);
if (!bin || !fixture || !host) { console.error("usage: smoke-tarball-e2e.mjs <interlinked-bin> <fixture-dir> <host-dir>"); process.exit(2); }

const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: host, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@x", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@x" } }).trim();
function interlinked(expectedExit, ...args) {
    const run = spawnSync(bin, args, { cwd: host, encoding: "utf8", env: { ...process.env, INTERLINKED_DISABLE_SCRATCH_GUARD: "1" } });
    const status = run.status ?? -1;
    if (status !== expectedExit) {
        console.error(`✗ interlinked ${args.join(" ")} exited ${status}, expected ${expectedExit}\n${run.stdout}\n${run.stderr}`);
        process.exit(1);
    }
    console.log(`  ✓ interlinked ${args.join(" ")} → ${status}`);
    return run.stdout;
}

// 1. Host project = the fixture app + a manifest + acceptance + a required policy (the same shapes the fixture builders write).
mkdirSync(join(host, ".interlinked"), { recursive: true });
cpSync(fixture, host, { recursive: true });
const requirementSha = digest(readFileSync(join(host, "REQUIREMENTS.md"), "utf8"));
// Quotes must be exact substrings of REQUIREMENTS.md: a quote that drifts makes the case STALE before it runs (R1).
const source = { kind: "requirement", path: "REQUIREMENTS.md", sha256: requirementSha, quote: "persists the order so a later invocation can read it back" };
const cases = [
    { id: "orders.create", description: "add persists the order and prints it", source, inputs: ["dist/cli.js"], runner: { kind: "process", argv: ["node", "dist/cli.js", "add", "widget"] }, expect: { exitCode: 0, json: { ok: true, order: { id: 1, name: "widget" } }, files: { "data/orders.json": "[{\"id\":1,\"name\":\"widget\"}]" } } },
    { id: "orders.invalid", description: "add without a name prints usage and fails with exit 2", source: { ...source, quote: "fails with exit code 2" }, inputs: ["dist/cli.js"], runner: { kind: "process", argv: ["node", "dist/cli.js", "add"] }, expect: { exitCode: 2, stderr: "usage: cli add <name> | list\n" } },
];
writeFileSync(join(host, ".interlinked", "behavioral-contracts.json"), JSON.stringify({ version: 1, cases }, null, 2));
writeFileSync(join(host, ".interlinked", "contract-policy.json"), JSON.stringify({ version: 1, accepted: Object.fromEntries(cases.map(row => [digest(row), "smoke acceptance"])) }, null, 2));
const affects = ["src/**", "build.mjs", "package.json"];
writeFileSync(join(host, ".interlinked", "e2e-policy.json"), JSON.stringify({
    version: 1,
    projects: [{ id: "orders", root: ".", protectedInputs: affects, mode: "required", gates: { stop: "warn", commit: "require" },
        suites: [{ id: "cli", adapter: "managed-contracts", prepare: [{ argv: ["node", "build.mjs"] }], artifacts: ["dist/**"] }],
        scenarios: [{ id: "order-persists", suite: "cli", description: "add persists an order the driver can read back", affects, contractIds: ["orders.create", "orders.invalid"], required: true, boundary: { entry: "process", real: ["application"] } }] }],
    expectations: [],
}, null, 2));
writeFileSync(join(host, ".gitignore"), ".interlinked/test-runs/\n.interlinked/*.jsonl\nnode_modules/\ndist/\ndata/\n");
git("init", "--quiet");
git("add", ".");
git("commit", "--quiet", "--no-gpg-sign", "-m", "host");
const head = git("rev-parse", "HEAD");

// 2. The installed package, end to end.
console.log("e2e smoke against the installed package:");
interlinked(0, "tests", "e2e", "doctor");
interlinked(1, "tests", "e2e", "check");                       // required scenario, no evidence yet
interlinked(0, "tests", "e2e", "run", "--timeout", "120000");  // supervised run in a disposable snapshot
interlinked(0, "tests", "e2e", "check");
interlinked(0, "tests", "e2e", "check", "--staged");
interlinked(0, "tests", "e2e", "check", "--revision", head);
// 3. PE-35 inverted: an UNSTAGED edit makes the worktree stale while the staged bytes (== HEAD) stay certified.
const cli = join(host, "src", "cli.ts");
writeFileSync(cli, `${readFileSync(cli, "utf8")}\n// unstaged edit\n`);
interlinked(1, "tests", "e2e", "check");
interlinked(0, "tests", "e2e", "check", "--staged");
interlinked(2, "tests", "e2e", "check", "--revision", "no-such-ref"); // unavailable, never a pass
console.log("✓ e2e tarball smoke passed");
