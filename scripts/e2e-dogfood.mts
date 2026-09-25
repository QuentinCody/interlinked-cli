// ===========================================
// Interlinked CLI dogfood pilot (plan 31 §18 "Interlinked CLI dogfood", Unit G4)
// ===========================================
// Interlinked CLI as a HOST PROJECT judged by the shipped engine: the public
// `interlinked scratch init | status` workflow (independently observable
// files and stdout) is declared as portable process contracts in a
// disposable host that carries only the candidate build (`dist/` + its one
// runtime dependency). The run proves the common route accepts the valid
// candidate, rejects a stale candidate (a changed chunk) and rejects a
// recorded behavior-breaking fault (the README write removed: the CLI still
// reports "created"). The supervising build and the candidate build are
// recorded by path and sha256 — never assumed identical. Never installs
// hooks anywhere; the developer's tree is only read.
//
//   node --import tsx scripts/e2e-dogfood.mts [--candidate <dist directory>]

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_MANIFEST, CONTRACT_POLICY, contractDigest } from "../src/harness/contracts/paths.js";
import { parseContractManifest } from "../src/harness/contracts/schema.js";
import type { ContractCase } from "../src/harness/contracts/types.js";
import { evaluateE2e } from "../src/harness/project-e2e/evaluate.js";
import { E2E_POLICY_PATH } from "../src/harness/project-e2e/policy.js";
import { runProjectE2e } from "../src/harness/project-e2e/run.js";
import { resolveCliEntry } from "../src/harness/project-e2e/scheduler.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 180_000;
const REQUIREMENTS = `# interlinked scratch — requirements

R1. \`interlinked scratch init\` provisions scratch/README.md, a .gitignore carve-out and an .ignore search negation, and reports each piece it created.
R2. \`interlinked scratch status --json\` reports the presence of each piece as JSON and reports every piece absent in an unprovisioned directory.
`;
const GITIGNORE_BLOCK = `# Sanctioned session/agent-script home (see scratch/README.md): local-only
# like the host scratchpad it replaces, but — unlike it — gated by the
# harness quality checks, rg-searchable, and durable across sessions.
scratch/*
!scratch/README.md
`;
const IGNORE_BLOCK = `# scratch/ is gitignored (session/agent scripts) but must stay SEARCHABLE —
# rg/grep honor .ignore; this negation restores visibility.
!scratch/
!scratch/**
`;
/** The provisioned README, verbatim from `src/commands/scratch.ts` (R1): the contract asserts the FILE, not the "created" line — a defect that reports success without writing it must fail here. */
const README_CONTENT = `# scratch/ — the sanctioned home for session & agent scripts

One-off scripts written during a session — analysis probes, migration
drivers, data munging — belong HERE, not in /tmp or the host session
scratchpad. A script that shapes real decisions deserves the same scrutiny
as the code it touches, and future sessions should be able to find it.

What this location gives you:

- **Gated**: content-quality, security, and lint/type diff-overlays apply —
  scratch code is first-class, not a workaround lane. Companion-test and
  coverage ratchets are exempt here (like scripts/): demanding tests for
  one-offs would push work back to ungoverned temp dirs.
- **Greppable**: gitignored (except this README) but re-included for search
  via the root .ignore negation, so rg/grep and the harness trigram index
  see it.
- **Durable**: survives the session; future agents can \`rg scratch/\` for
  prior art instead of re-deriving it.

Conventions:

- One subdirectory per effort, date-prefixed: \`scratch/2026-07-09-<slug>/\`.
- Keep artifacts small and text-based; large/binary outputs still belong in
  the host scratchpad (they are archived from there at session end).
- Anything that graduates to durable tooling moves to \`scripts/\` (committed)
  with the normal review bar.

Provisioned by \`interlinked scratch init\`.
`;
const INIT_STDOUT = "created  scratch/README.md\ncreated  .gitignore entries\ncreated  .ignore entries\nscratch/ ready — session/agent scripts belong there (see scratch/README.md).\n";
/** The recorded fault: the README write removed while the CLI still reports the piece as created (a "success without persistence" defect). */
const FAULT = { find: String.raw`writeFileSync\d*\(readmePath, README_CONTENT\);`, replace: "/* dogfood fault: README not written, still reported as created */" };
const FAULT_ANCHOR = new RegExp(FAULT.find, "g"); // the bundler suffixes colliding names (`writeFileSync81`), so the anchor is a pattern

interface Identity { path: string; sha256: string; }
interface Outcome { exit: 0 | 1 | 2; codes: string[]; messages: string[]; runIds: string[]; }

function sha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function cases(requirementSha: string): ContractCase[] {
    const source = (quote: string) => ({ kind: "requirement" as const, path: "REQUIREMENTS.md", sha256: requirementSha, quote });
    return [
        { id: "scratch.init", description: "init provisions the three pieces and reports them", source: source("reports each piece it created"), inputs: ["dist/cli.mjs"], runner: { kind: "process", argv: ["node", "dist/cli.mjs", "scratch", "init"] }, expect: { exitCode: 0, stdout: INIT_STDOUT, files: { "scratch/README.md": README_CONTENT, ".gitignore": GITIGNORE_BLOCK, ".ignore": IGNORE_BLOCK } } },
        { id: "scratch.status-empty", description: "status reports every piece absent in an unprovisioned directory", source: source("reports every piece absent in an unprovisioned directory"), inputs: ["dist/cli.mjs"], runner: { kind: "process", argv: ["node", "dist/cli.mjs", "scratch", "status", "--json"] }, expect: { exitCode: 0, json: { dir: false, readme: false, gitignoreEntry: false, ignoreEntry: false } } },
    ];
}
function policy(): unknown {
    return { version: 1, expectations: [], projects: [{
        id: "interlinked-cli", root: ".", mode: "required", protectedInputs: ["dist/**"], gates: { stop: "warn", commit: "require", ci: "require" },
        suites: [{ id: "cli", adapter: "managed-contracts" }],
        scenarios: [{ id: "scratch-workflow", suite: "cli", description: "the public scratch provisioning workflow", affects: ["dist/**"], contractIds: ["scratch.init", "scratch.status-empty"], required: true, boundary: { entry: "process", real: ["application"] } }],
    }] };
}
/**
 * The candidate is ONE self-contained executable: `dist/index.js` and everything it reaches (409 chunks here plus its
 * runtime dependency) bundled by esbuild into `dist/cli.mjs`. A contract case's workspace holds only its declared inputs
 * (at most 128 literal paths), so the candidate travels the way a compiled binary does — byte-for-byte, one file, bound
 * into the generation. A long-lived `dist/` also carries thousands of stale chunks and an over-cap metafile; none of that
 * is the candidate.
 */
function bundleCandidate(candidateDist: string, host: string): string {
    const esbuild = join(REPO, "node_modules", ".bin", "esbuild");
    if (!existsSync(esbuild)) throw new Error("esbuild is not installed in this checkout; the dogfood candidate cannot be bundled");
    const out = join(host, "dist", "cli.mjs");
    mkdirSync(dirname(out), { recursive: true });
    // `readline/promises` is a Node builtin subpath esbuild 0.28 does not know; `--ignore-annotations` keeps the chunks' side-effect imports (command registration) that the package's `sideEffects: false` would let esbuild drop.
    // The banner gives the bundled CommonJS dependency (commander) a real `require` inside the ES module output.
    const banner = "--banner:js=import { createRequire as __dogfoodCreateRequire } from 'node:module'; const require = __dogfoodCreateRequire(import.meta.url);";
    const built = spawnSync(esbuild, [join(candidateDist, "index.js"), "--bundle", "--platform=node", "--format=esm", "--external:readline/promises", "--ignore-annotations", banner, `--outfile=${out}`, "--log-level=error"], { encoding: "utf8" });
    if (built.status !== 0) throw new Error(`esbuild failed: ${built.stderr}`);
    return out;
}
/** The disposable host: the bundled candidate, the requirement document, the contracts and the policy. */
function buildHost(candidateDist: string): string {
    const host = mkdtempSync(join(tmpdir(), "interlinked-dogfood-"));
    bundleCandidate(candidateDist, host);
    writeFileSync(join(host, "package.json"), JSON.stringify({ name: "interlinked-dogfood-host", private: true }));
    writeFileSync(join(host, "REQUIREMENTS.md"), REQUIREMENTS);
    mkdirSync(join(host, ".interlinked"), { recursive: true });
    const rows = cases(contractDigest(REQUIREMENTS));
    parseContractManifest(JSON.stringify({ version: 1, cases: rows }));
    writeFileSync(join(host, CONTRACT_MANIFEST), JSON.stringify({ version: 1, cases: rows }, null, 2));
    writeFileSync(join(host, CONTRACT_POLICY), JSON.stringify({ version: 1, accepted: Object.fromEntries(rows.map(row => [contractDigest(row), "dogfood acceptance: requirements R1/R2"])) }));
    writeFileSync(join(host, E2E_POLICY_PATH), JSON.stringify(policy(), null, 2));
    return host;
}
/** Every built file carrying the fault anchor (the bundle may hold the scratch command in more than one chunk); each must carry it exactly once. */
function scratchChunks(host: string): string[] {
    const dist = join(host, "dist");
    const chunks = readdirSync(dist).filter(name => name.endsWith(".js") || name.endsWith(".mjs")).map(name => join(dist, name)).filter(path => FAULT_ANCHOR.test(readFileSync(path, "utf8")));
    if (!chunks.length) throw new Error("no built file in the candidate carries the scratch README write; the fault recipe no longer matches the build");
    for (const chunk of chunks) {
        const count = readFileSync(chunk, "utf8").match(FAULT_ANCHOR)?.length ?? 0;
        if (count !== 1) throw new Error(`fault anchor occurs ${count} times in ${chunk}; exactly one is required`);
    }
    return chunks;
}
async function outcomeOf(host: string): Promise<Outcome> {
    const result = await runProjectE2e({ root: host, timeoutMs: TIMEOUT_MS });
    const reasons = result.verdicts.flatMap(row => row.reasons);
    return { exit: result.exitCode, codes: reasons.map(reason => reason.code), messages: [...result.messages, ...reasons.map(reason => `${reason.code}: ${reason.message}`)], runIds: result.receipts.map(row => row.runId) };
}
/** valid → stale (chunk touched) → fault (README write removed); the verdict names the contradiction, if any. */
async function judge(host: string, chunks: string[]): Promise<{ valid: Outcome; stale: { exit: number; codes: string[] }; fault: Outcome; verdict: "qualified" | "CONTRADICTION" }> {
    const valid = await outcomeOf(host);
    for (const chunk of chunks) writeFileSync(chunk, `${readFileSync(chunk, "utf8")}\n// touched\n`);
    const evaluation = evaluateE2e({ root: host, atMs: Date.now(), reconcile: true });
    const stale = { exit: evaluation.exitCode, codes: evaluation.verdicts.flatMap(row => row.reasons.map(reason => reason.code)) };
    for (const chunk of chunks) writeFileSync(chunk, readFileSync(chunk, "utf8").replace(FAULT_ANCHOR, FAULT.replace));
    const fault = await outcomeOf(host);
    const qualified = valid.exit === 0 && stale.exit === 1 && stale.codes.includes("STALE_GENERATION") && fault.exit === 1 && fault.codes.includes("CASE_FAILED");
    return { valid, stale, fault, verdict: qualified ? "qualified" : "CONTRADICTION" };
}
async function main(): Promise<void> {
    const index = process.argv.indexOf("--candidate");
    const candidateDist = resolve(index === -1 ? join(REPO, "dist") : process.argv[index + 1]!);
    const supervisor = resolveCliEntry();
    if (!supervisor) throw new Error("the supervising CLI entry could not be resolved");
    const host = buildHost(candidateDist);
    try {
        const chunks = scratchChunks(host);
        const identities: { supervisor: Identity; candidate: Identity & { source: string; chunks: Identity[] } } = { supervisor: { path: supervisor.file, sha256: sha256(supervisor.file) }, candidate: { path: join(host, "dist", "cli.mjs"), source: join(candidateDist, "index.js"), sha256: sha256(join(host, "dist", "cli.mjs")), chunks: chunks.map(path => ({ path, sha256: sha256(path) })) } };
        const judged = await judge(host, chunks);
        const identicalBuilds = identities.supervisor.sha256 === identities.candidate.sha256;
        const report = { version: 1, generatedAt: new Date().toISOString(), host, identities, identicalBuilds, fault: FAULT, ...judged };
        mkdirSync(join(REPO, ".interlinked", "test-runs", "e2e"), { recursive: true });
        writeFileSync(join(REPO, ".interlinked", "test-runs", "e2e", "dogfood.json"), `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`dogfood: valid exit ${judged.valid.exit}; stale exit ${judged.stale.exit} [${judged.stale.codes.join(",")}]; fault exit ${judged.fault.exit} [${judged.fault.codes.join(",")}] → ${judged.verdict}\n`);
        process.stdout.write(`supervisor ${identities.supervisor.sha256.slice(0, 12)} (${identities.supervisor.path}); candidate ${identities.candidate.sha256.slice(0, 12)} (${identities.candidate.path})${identicalBuilds ? " — byte-identical builds this run; a release pilot pins a distinct supervisor" : ""}\n`);
        process.exitCode = judged.verdict === "qualified" ? 0 : 1;
    } finally { rmSync(host, { recursive: true, force: true }); }
}
await main();
