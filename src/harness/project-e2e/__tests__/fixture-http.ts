// Copies the ts-http fixture (a TypeScript HTTP service with disposable
// persistence) into a fresh workspace and writes its service-bound contract
// manifest + e2e policy there: create → restart → read-back through the OWNED
// service (plan 31 §18 "TypeScript HTTP", §5.3 example). Shares no
// implementation with the enforcement code.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contractDigest, CONTRACT_MANIFEST } from "../../contracts/paths.js";
import { parseContractManifest } from "../../contracts/schema.js";
import type { ContractCase } from "../../contracts/types.js";
import { E2E_POLICY_PATH } from "../policy.js";
import { acceptAllContracts, type FixtureProject } from "./fixture-projects.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "ts-http");
export const HTTP_QUOTE = "persists the order so it can be read back after the service restarts";

function httpCases(requirementSha: string): ContractCase[] {
    const source = { kind: "requirement" as const, path: "REQUIREMENTS.md", sha256: requirementSha, quote: HTTP_QUOTE };
    return [
        { id: "orders.create", description: "POST persists the order and answers 201", source, inputs: [], runner: { kind: "http", service: "api", path: "/orders", method: "POST", body: JSON.stringify({ name: "widget" }) }, expect: { status: 201, json: { ok: true, order: { id: 1, name: "widget" } } } },
        { id: "orders.read-after-restart", description: "the order survives a service restart", source, inputs: [], steps: [{ kind: "restart", service: "api" }], runner: { kind: "http", service: "api", path: "/orders/1", method: "GET" }, expect: { status: 200, json: { id: 1, name: "widget" } } },
        { id: "orders.invalid", description: "POST without a name answers 400", source: { ...source, quote: "answers 400 and writes nothing" }, inputs: [], runner: { kind: "http", service: "api", path: "/orders", method: "POST", body: "{}" }, expect: { status: 400, json: { error: "name required" } } },
    ];
}
export function httpFixturePolicy(): Record<string, unknown> {
    const affects = ["src/**", "build.mjs", "package.json"];
    return {
        version: 1,
        projects: [{
            id: "orders", root: ".", protectedInputs: affects, mode: "required", gates: { stop: "warn", commit: "require" },
            suites: [{
                id: "api", adapter: "managed-contracts", prepare: [{ argv: ["node", "build.mjs"] }], artifacts: ["dist/**"],
                services: [{ id: "api", argv: ["node", "dist/server.js", "--port", "{port}"], env: { DATA_DIR: "{fixture-directory}" }, ready: { kind: "http", path: "/health", status: 200 } }],
            }],
            scenarios: [{ id: "order-persists", suite: "api", description: "an order created through the API survives a restart", affects, contractIds: ["orders.create", "orders.read-after-restart", "orders.invalid"], required: true, boundary: { entry: "http", service: "api", real: ["application", "fixture-store"] } }],
        }],
        expectations: [],
    };
}
/** Fresh copy of the HTTP fixture with manifest + policy written; contracts are accepted unless `accept: false`. */
export function httpFixtureProject(options: { accept?: boolean } = {}): FixtureProject {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-http-")));
    cpSync(FIXTURE, root, { recursive: true });
    mkdirSync(join(root, ".interlinked"), { recursive: true });
    const requirementSha = contractDigest(readFileSync(join(root, "REQUIREMENTS.md"), "utf8"));
    const manifest = { version: 1, cases: httpCases(requirementSha) };
    parseContractManifest(JSON.stringify(manifest));
    writeFileSync(join(root, CONTRACT_MANIFEST), JSON.stringify(manifest, null, 2));
    writeFileSync(join(root, E2E_POLICY_PATH), JSON.stringify(httpFixturePolicy(), null, 2));
    if (options.accept !== false) acceptAllContracts(root);
    return { root, language: "ts", sourceFile: "src/server.ts" };
}
/** The "passing response with lost state" defect (PE-20/23): POST still answers 201, nothing is written. */
export function injectHttpPersistenceDefect(project: FixtureProject): void {
    const path = join(project.root, project.sourceFile), content = readFileSync(path, "utf8");
    const patched = content.replace("    save(orders);\n    send(response, 201", "    /* defect: not saved */\n    send(response, 201");
    if (patched === content) throw new Error("defect anchor not found in src/server.ts");
    writeFileSync(path, patched);
}
