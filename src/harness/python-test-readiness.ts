import { runProcessAsync } from "./check-engine/spawn-async.js";
import { allowedPackageEntry, loadAllowlist } from "./package-allowlist.js";
import { isExactPinnedVersion } from "./package-install-parser-shared.js";
import { resolvePythonTestInvocation, type PythonTestInvocationOptions } from "./python-test-runtime.js";
import { isJsonObject } from "../lib/json-types.js";

const MODULES = { pytest: "pytest", "pytest-cov": "pytest_cov", coverage: "coverage" };
function parseModules(stdout: string): Record<string, unknown> {
    const value: unknown = JSON.parse(stdout);
    if (!isJsonObject(value) || ![...Object.values(MODULES), "pip"].every(name => typeof value[name] === "boolean")) throw new Error("Invalid module probe");
    return value;
}
export interface PythonTestReadiness {
    status: "ready" | "unavailable";
    interpreter: string;
    missing: string[];
    reason: string;
    install: { command: string; args: string[] } | null;
    requiresApproval: string[];
    behavioralEvidence: "not-run";
}

/** A read-only prerequisite probe in the exact selected environment. Never
 * silently borrows system pytest, installs packages, or writes project config. */
export async function pythonTestReadiness(root: string, options: PythonTestInvocationOptions = {}): Promise<PythonTestReadiness> {
    const interpreter = resolvePythonTestInvocation(root, options).command;
    const probe = "import importlib.util,json; print(json.dumps({name: importlib.util.find_spec(name) is not None for name in ['pytest','pytest_cov','coverage','pip']}))";
    const result = await runProcessAsync(interpreter, ["-I", "-B", "-c", probe], { cwd: root, timeout: 3000 });
    if (result.code !== 0 || result.timedOut) return { status: "unavailable", interpreter, missing: [], install: null,
        requiresApproval: [], behavioralEvidence: "not-run", reason: "Selected Python interpreter could not complete the readiness probe." };
    let modules: Record<string, unknown>;
    try { modules = parseModules(result.stdout); } catch { return { status: "unavailable", interpreter, missing: [], install: null,
        requiresApproval: [], behavioralEvidence: "not-run", reason: "Selected interpreter returned invalid readiness evidence." }; }
    const missing = Object.entries(MODULES).filter(([, module]) => modules[module] !== true).map(([name]) => name);
    const allowlist = loadAllowlist(root), pins: string[] = [], requiresApproval: string[] = [];
    for (const name of missing) {
        const version = allowedPackageEntry(allowlist, "pypi", name)?.version_range;
        if (!version || !isExactPinnedVersion(version, "pypi")) requiresApproval.push(name);
        else pins.push(`${name}==${version.replace(/^===?/, "")}`);
    }
    return { status: missing.length ? "unavailable" : "ready", interpreter, missing, requiresApproval, behavioralEvidence: "not-run",
        reason: missing.length ? "Provision the missing test tools in this interpreter, then retain and run public-contract tests. Installing a runner is not a test verdict."
            : "Test tools are available. No test collection, assertions, or coverage have run.",
        install: modules.pip && pins.length && !requiresApproval.length ? { command: interpreter, args: ["-m", "pip", "install", ...pins] } : null };
}
