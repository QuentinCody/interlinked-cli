// Copies the ts-browser fixture (a TypeScript web service with a page a user
// drives) into a fresh workspace and writes its policy there: a playwright
// suite that OWNS the app as a service, one scenario binding the browser case
// plus one portable http contract (plan 31 §10.2 "Playwright + managed
// application"). Shares no implementation with the enforcement code.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contractDigest, CONTRACT_MANIFEST } from "../../contracts/paths.js";
import { parseContractManifest } from "../../contracts/schema.js";
import type { ContractCase } from "../../contracts/types.js";
import { E2E_POLICY_PATH } from "../policy.js";
import { acceptAllContracts, type FixtureProject } from "./fixture-projects.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "ts-browser");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
/** The browser case id exactly as the Playwright JSON reporter names it: file › describe › title [project]. */
export const BROWSER_CASE_ID = "orders.spec.mjs › orders page › creates an order through the page [chromium]";
/** The closure of @playwright/test as npm lays it out; copied (never linked) into the fixture when the repo has it. */
const PLAYWRIGHT_PACKAGES = ["@playwright/test", "playwright", "playwright-core"];

function browserCases(requirementSha: string): ContractCase[] {
    return [{ id: "orders.invalid", description: "POST without a name answers 400", source: { kind: "requirement", path: "REQUIREMENTS.md", sha256: requirementSha, quote: "answers 400 and writes nothing" }, inputs: [], runner: { kind: "http", service: "web", path: "/orders", method: "POST", body: "{}" }, expect: { status: 400, json: { error: "name required" } } }];
}
/** The package-local CLI (`playwright/cli.js`), which resolves its own `./lib/program`; never the npm `.bin` shim. */
export const PACKAGE_LOCAL_PLAYWRIGHT = ["node", "node_modules/playwright/cli.js", "test"];
export function browserFixturePolicy(runArgv: string[] = ["npx", "playwright", "test"]): Record<string, unknown> {
    const affects = ["src/**", "tests/**", "playwright.config.mjs", "build.mjs", "package.json"];
    return {
        version: 1,
        projects: [{
            id: "orders", root: ".", protectedInputs: affects, mode: "required", gates: { stop: "warn", commit: "require" },
            suites: [{
                id: "ui", adapter: "playwright", prepare: [{ argv: ["node", "build.mjs"] }], artifacts: ["dist/**"], run: { argv: runArgv },
                services: [{ id: "web", argv: ["node", "dist/server.js", "--port", "{port}"], env: { DATA_DIR: "{fixture-directory}" }, ready: { kind: "http", path: "/health", status: 200 } }],
            }],
            scenarios: [{ id: "order-via-page", suite: "ui", description: "a user creates an order through the page", affects, contractIds: ["orders.invalid"], caseIds: [BROWSER_CASE_ID], required: true, boundary: { entry: "browser", service: "web", real: ["application"], requests: [{ method: "POST", path: "/orders" }] } }],
        }],
        expectations: [],
    };
}
/** True when this checkout carries @playwright/test (the live browser route is asserted only then). */
export function repoHasPlaywright(): boolean { return existsSync(join(REPO_ROOT, "node_modules", "@playwright", "test", "package.json")); }
/** Fresh copy of the browser fixture with manifest + policy written; @playwright/test's closure is copied in when the repo has it. */
export function browserFixtureProject(options: { accept?: boolean; withPlaywright?: boolean } = {}): FixtureProject {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-browser-")));
    cpSync(FIXTURE, root, { recursive: true });
    mkdirSync(join(root, ".interlinked"), { recursive: true });
    // Live route: copy the package closure only. The npm `.bin/playwright` launcher resolves `./lib/program` relative to
    // itself, so a relocated copy breaks; the policy invokes the package-local CLI directly instead (review: live controls).
    const live = options.withPlaywright === true && repoHasPlaywright();
    if (live) for (const name of PLAYWRIGHT_PACKAGES) cpSync(join(REPO_ROOT, "node_modules", name), join(root, "node_modules", name), { recursive: true, dereference: true });
    const requirementSha = contractDigest(readFileSync(join(root, "REQUIREMENTS.md"), "utf8"));
    const manifest = { version: 1, cases: browserCases(requirementSha) };
    parseContractManifest(JSON.stringify(manifest));
    writeFileSync(join(root, CONTRACT_MANIFEST), JSON.stringify(manifest, null, 2));
    writeFileSync(join(root, E2E_POLICY_PATH), JSON.stringify(browserFixturePolicy(live ? PACKAGE_LOCAL_PLAYWRIGHT : undefined), null, 2));
    if (options.accept !== false) acceptAllContracts(root);
    return { root, language: "ts", sourceFile: "src/server.ts" };
}
