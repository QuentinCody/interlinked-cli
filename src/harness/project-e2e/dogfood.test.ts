// Interlinked CLI as a HOST project (plan 31 §16 Unit A, §18 "Interlinked CLI
// dogfood", PE-91): a disposable host repository declares one public CLI
// workflow (`interlinked scratch init`) through ordinary project policy. The
// application under test is the BUILT candidate (`dist/index.js`); the
// supervisor is this source tree. A passing self-test lane is not this proof.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_MANIFEST, CONTRACT_POLICY, contractDigest } from "../contracts/paths.js";
import { evaluateE2e } from "./evaluate.js";
import { readE2eReceipt } from "./receipt.js";
import { E2E_POLICY_PATH } from "./policy.js";
import { runProjectE2e } from "./run.js";

const CANDIDATE = resolve("dist/index.js");
const TIMEOUT = 120_000;
const REQUIREMENT = "`interlinked scratch init` provisions scratch/ and a root .ignore negation so scratch stays searchable.\n";
const EXPECTED_IGNORE = `# scratch/ is gitignored (session/agent scripts) but must stay SEARCHABLE —
# rg/grep honor .ignore; this negation restores visibility.
!scratch/
!scratch/**
`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function hostRepository(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-dogfood-"))); roots.push(root);
    mkdirSync(join(root, ".interlinked"));
    writeFileSync(join(root, "REQUIREMENTS.md"), REQUIREMENT);
    const source = { kind: "requirement", path: "REQUIREMENTS.md", sha256: contractDigest(REQUIREMENT), quote: "a root .ignore negation" };
    const row = { id: "scratch.init", description: "scratch init writes the .ignore negation", source, inputs: [], runner: { kind: "process", argv: ["node", CANDIDATE, "scratch", "init"] }, expect: { exitCode: 0, files: { ".ignore": EXPECTED_IGNORE } } };
    writeFileSync(join(root, CONTRACT_MANIFEST), JSON.stringify({ version: 1, cases: [row] }));
    writeFileSync(join(root, CONTRACT_POLICY), JSON.stringify({ version: 1, accepted: { [contractDigest(row)]: "dogfood acceptance" } }));
    writeFileSync(join(root, E2E_POLICY_PATH), JSON.stringify({
        version: 1,
        projects: [{ id: "interlinked-host", root: ".", protectedInputs: ["REQUIREMENTS.md"], mode: "required",
            suites: [{ id: "cli", adapter: "managed-contracts" }],
            scenarios: [{ id: "scratch-init", suite: "cli", affects: ["REQUIREMENTS.md"], contractIds: ["scratch.init"], required: true, boundary: { entry: "process", real: ["application"] } }] }],
        expectations: [],
    }));
    return root;
}

describe("Interlinked CLI dogfood through ordinary project policy", () => {
    it(existsSync(CANDIDATE) ? "the built candidate satisfies the declared scratch-init workflow in a disposable host; the receipt binds the candidate identity separately from the supervisor" : "candidate build absent: dogfood reports unavailable (run npm run build first)", async () => {
        const root = hostRepository();
        const result = await runProjectE2e({ root, timeoutMs: TIMEOUT, sessionId: "dogfood" });
        if (!existsSync(CANDIDATE)) {
            expect(result.verdicts[0]?.satisfied).toBe(false);
            expect(result.verdicts[0]?.dimensions.execution).toBe("unavailable");
            return;
        }
        expect(result.verdicts[0]?.reasons).toEqual([]);
        expect(result.exitCode).toBe(0);
        const receipt = readE2eReceipt(root, result.receipts[0]!.path)!;
        expect(receipt.cases[0]?.observations?.exitCode).toBe(0);
        expect(receipt.runtime.interlinked).not.toBe("unknown");
        expect(receipt.inputs.map(row => row.path)).toContain(CANDIDATE); // the CANDIDATE's own bytes are part of the generation (R9)
        expect(existsSync(join(root, ".ignore"))).toBe(false); // the candidate acted only inside the driver's disposable workspace
        writeFileSync(join(root, "REQUIREMENTS.md"), `${REQUIREMENT}R2. more\n`);
        expect(evaluateE2e({ root, atMs: Date.now() }).verdicts[0]?.reasons.map(row => row.code)).toContain("STALE_GENERATION");
    }, TIMEOUT);
    it(existsSync(CANDIDATE) ? "a candidate-only change (the invoked executable, not the requirement) makes the verdict stale (R9)" : "candidate build absent: skipped identity check", async () => {
        if (!existsSync(CANDIDATE)) return;
        const shimDirectory = realpathSync(mkdtempSync(join(tmpdir(), "e2e-candidate-"))); roots.push(shimDirectory);
        const shim = join(shimDirectory, "candidate.mjs");
        writeFileSync(shim, `import ${JSON.stringify(CANDIDATE)};\n`);
        const root = hostRepository();
        const manifest = JSON.parse(readFileSync(join(root, CONTRACT_MANIFEST), "utf8"));
        manifest.cases[0].runner.argv = ["node", shim, "scratch", "init"];
        writeFileSync(join(root, CONTRACT_MANIFEST), JSON.stringify(manifest));
        writeFileSync(join(root, CONTRACT_POLICY), JSON.stringify({ version: 1, accepted: { [contractDigest(manifest.cases[0])]: "dogfood acceptance" } }));
        const result = await runProjectE2e({ root, timeoutMs: TIMEOUT });
        expect(result.verdicts[0]?.reasons).toEqual([]);
        writeFileSync(shim, "console.log('impostor');\n"); // same requirement, same policy, different candidate bytes
        const stale = evaluateE2e({ root, atMs: Date.now() });
        expect(stale.verdicts[0]?.reasons.map(row => row.code)).toContain("STALE_GENERATION");
        expect(stale.exitCode).toBe(1);
    }, TIMEOUT);
});
