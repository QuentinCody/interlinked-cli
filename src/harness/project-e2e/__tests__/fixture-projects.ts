// Copies one of the external fixture projects (ts-cli / py-cli / rust-cli)
// into a fresh temporary workspace and writes its contract manifest + e2e
// policy there. The fixtures share NO implementation with the enforcement
// code (plan 31 §18); the policy is authored here so the requirement digest
// always matches the copied REQUIREMENTS.md bytes.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contractDigest, CONTRACT_MANIFEST, CONTRACT_POLICY } from "../../contracts/paths.js";
import { parseContractManifest } from "../../contracts/schema.js";
import type { ContractCase } from "../../contracts/types.js";
import { E2E_POLICY_PATH } from "../policy.js";

export type FixtureLanguage = "ts" | "py" | "rust";
export interface FixtureProject { root: string; language: FixtureLanguage; sourceFile: string; }
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
const QUOTE = "persists the order so a later invocation can read it back";

interface Shape { directory: string; sourceFile: string; inputs: string[]; argv: string[]; prepare: Array<{ argv: string[] }>; artifacts: string[]; persisted: Record<string, string>; /** The usage line the error path prints to stderr: the ACTION evidence of `orders.invalid` (its designated outcome is the exit code). */ usage: string; }
const SHAPES: Record<FixtureLanguage, Shape> = {
    ts: { directory: "ts-cli", sourceFile: "src/cli.ts", inputs: ["dist/cli.js"], argv: ["node", "dist/cli.js"], prepare: [{ argv: ["node", "build.mjs"] }], artifacts: ["dist/**"], persisted: { "data/orders.json": "[{\"id\":1,\"name\":\"widget\"}]" }, usage: "usage: cli add <name> | list\n" },
    py: { directory: "py-cli", sourceFile: "orders_cli.py", inputs: ["orders_cli.py"], argv: ["python3", "orders_cli.py"], prepare: [], artifacts: [], persisted: { "data/orders.json": "[{\"id\":1,\"name\":\"widget\"}]" }, usage: "usage: orders_cli.py add <name> | list\n" },
    rust: { directory: "rust-cli", sourceFile: "src/main.rs", inputs: ["target/release/orders_cli"], argv: ["./target/release/orders_cli"], prepare: [{ argv: ["cargo", "build", "--release", "--quiet"] }], artifacts: ["target/**"], persisted: { "data/orders.txt": "1:widget\n" }, usage: "usage: orders_cli add <name> | list\n" },
};
function cases(shape: Shape, requirementSha: string): ContractCase[] {
    const source = { kind: "requirement" as const, path: "REQUIREMENTS.md", sha256: requirementSha, quote: QUOTE };
    return [
        { id: "orders.create", description: "add persists the order and prints it", source, inputs: shape.inputs, runner: { kind: "process", argv: [...shape.argv, "add", "widget"] }, expect: { exitCode: 0, json: { ok: true, order: { id: 1, name: "widget" } }, files: shape.persisted } },
        { id: "orders.invalid", description: "add without a name prints usage and fails with exit 2", source: { ...source, quote: "fails with exit code 2" }, inputs: shape.inputs, runner: { kind: "process", argv: [...shape.argv, "add"] }, expect: { exitCode: 2, stderr: shape.usage } },
    ];
}
export function fixturePolicy(language: FixtureLanguage): Record<string, unknown> {
    const shape = SHAPES[language];
    const affects = { py: ["orders_cli.py"], ts: ["src/**", "build.mjs", "package.json"], rust: ["src/**", "Cargo.toml"] }[language]; // build/config inputs are declared (F3)
    return {
        version: 1,
        projects: [{
            id: "orders", root: ".", protectedInputs: affects, mode: "required", gates: { stop: "warn", commit: "require" },
            suites: [{ id: "cli", adapter: "managed-contracts", prepare: shape.prepare, artifacts: shape.artifacts }],
            scenarios: [{ id: "order-persists", suite: "cli", description: "add persists an order the driver can read back", affects, contractIds: ["orders.create", "orders.invalid"], required: true, boundary: { entry: "process", real: ["application"] } }],
        }],
        expectations: [],
    };
}
/** Fresh copy of a fixture project with manifest + policy written. Contracts start PROPOSED (no contract-policy) unless `accept`. */
export function fixtureProject(language: FixtureLanguage, options: { accept?: boolean } = {}): FixtureProject {
    const shape = SHAPES[language];
    const root = realpathSync(mkdtempSync(join(tmpdir(), `e2e-${language}-`)));
    cpSync(join(FIXTURES, shape.directory), root, { recursive: true });
    mkdirSync(join(root, ".interlinked"), { recursive: true });
    const requirementSha = contractDigest(readFileSync(join(root, "REQUIREMENTS.md"), "utf8"));
    const manifest = { version: 1, cases: cases(shape, requirementSha) };
    parseContractManifest(JSON.stringify(manifest));
    writeFileSync(join(root, CONTRACT_MANIFEST), JSON.stringify(manifest, null, 2));
    writeFileSync(join(root, E2E_POLICY_PATH), JSON.stringify(fixturePolicy(language), null, 2));
    if (options.accept) acceptAllContracts(root);
    return { root, language, sourceFile: shape.sourceFile };
}
/** Records configured acceptance for every manifest case digest (what `expectations accept` does for the bound ids). */
export function acceptAllContracts(root: string): void {
    const manifest = parseContractManifest(readFileSync(join(root, CONTRACT_MANIFEST), "utf8"));
    const accepted = Object.fromEntries(manifest.cases.map(row => [contractDigest(row), "fixture acceptance"]));
    writeFileSync(join(root, CONTRACT_POLICY), JSON.stringify({ version: 1, accepted }));
}
/** Injects the "return success without saving" defect into the fixture's public executable. */
export function injectPersistenceDefect(project: FixtureProject): void {
    const path = join(project.root, project.sourceFile);
    const content = readFileSync(path, "utf8");
    const patched = { ts: content.replace('writeFileSync("data/orders.json", JSON.stringify(orders));', "/* defect: not saved */"),
        py: content.replace("json.dump(orders, handle, separators=(\",\", \":\"))", "pass  # defect: not saved"),
        rust: content.replace('fs::write("data/orders.txt", content).expect("write");', "/* defect: not saved */") }[project.language];
    if (patched === content) throw new Error(`defect anchor not found in ${project.sourceFile}`);
    writeFileSync(path, patched);
}
/** A behavior-preserving edit to the same source file (comment only) — still a new generation. */
export function touchSource(project: FixtureProject): void {
    const path = join(project.root, project.sourceFile);
    const comment = project.language === "py" ? "# touched\n" : "// touched\n";
    writeFileSync(path, `${readFileSync(path, "utf8")}${comment}`);
}
