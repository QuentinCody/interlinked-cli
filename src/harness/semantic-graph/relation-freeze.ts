import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, record } from "./relation-core.js";
import { gitText } from "./relation-history.js";
import { exportBundle, readBundle, readRelationJson } from "./relation-store.js";
import { parseRelationPlan } from "./relation-codec.js";
import { RELATION_CONTRACTS } from "../../lib/decision-metrics/relation-contracts.js";
import { HAIKU_POLICY } from "../../lib/decision-metrics/relation-haiku.js";
import type { RelationPlan } from "./relation-types.js";

export function implementationSources(): Record<string, string> {
    let directory = dirname(fileURLToPath(import.meta.url)), root = "";
    while (dirname(directory) !== directory) {
        if (existsSync(join(directory, "relation-source/src/lib/decision-metrics"))) { root = join(directory, "relation-source"); break; }
        if (existsSync(join(directory, "src/lib/decision-metrics/relation-assess.ts"))) { root = directory; break; }
        directory = dirname(directory);
    }
    if (!root) throw new Error("relation implementation source assets unavailable; rebuild the package");
    const out: Record<string, string> = {};
    const add = (path: string) => {
        const key = relative(root, path);
        if (key.startsWith("..") || Object.hasOwn(out, key) || !existsSync(path) || !statSync(path).isFile()) return;
        const source = readFileSync(path, "utf8"); out[key] = source;
        for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/g)) {
            const base = resolve(dirname(path), match[1]!).replace(/\.js$/, ".ts");
            const dependency = [base, `${base}.ts`, join(base, "index.ts")].find(p => existsSync(p) && statSync(p).isFile());
            if (dependency) add(dependency);
        }
    };
    const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) add(path);
        }
    };
    for (const directory of ["src/harness/semantic-graph", "src/lib/decision-metrics"]) visit(join(root, directory));
    for (const path of ["src/commands/metrics-relations.ts", "src/registrars/metrics-relations.ts", "package.json", "package-lock.json"]) add(join(root, path));
    return out;
}
export function freezeRelations(root: string, planInput: RelationPlan, destination: string): void {
    const plan = parseRelationPlan(planInput), implementation = implementationSources();
    let sourceRevision: string | null = null;
    try { sourceRevision = gitText(root, ["rev-parse", "HEAD"]); } catch { /* exported repository */ }
    exportBundle(destination, { schema: "interlinked.relation-freeze/1", plan, contracts: RELATION_CONTRACTS, toolPolicy: HAIKU_POLICY, implementation, implementationDigest: hash(implementation), sourceRevision, provenance: "Implementation bytes and policy snapshot embedded; Git review/commit authority is separate. All runs remain exploratory." }, "input");
}
export function loadRelationArtifact(path: string): unknown { return statSync(path).isDirectory() ? readBundle(path) : readRelationJson(path); }
export function planFromArtifact(value: unknown, requireImplementation = false): RelationPlan {
    const input = record(value);
    if (input.schema !== "interlinked.relation-freeze/1") {
        if (requireImplementation) throw new Error("assessment requires a frozen input bundle");
        return parseRelationPlan(value);
    }
    if (input.implementationDigest !== hash(input.implementation) || hash(input.contracts) !== hash(RELATION_CONTRACTS) || hash(input.toolPolicy) !== hash(HAIKU_POLICY)) throw new Error("freeze implementation/contract/tool-policy closure mismatch");
    if (requireImplementation && input.implementationDigest !== hash(implementationSources())) throw new Error("implementation changed since freeze; create a new input bundle");
    return parseRelationPlan(input.plan);
}
