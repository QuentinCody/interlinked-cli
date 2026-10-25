import { createHash } from "node:crypto";
import type { Annotation, AnnotatedClaim, Span } from "./annotation-metrics.mjs";
import type { CurrentInputs, ProvenanceGraph } from "./provenance-graph.mjs";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const split = (i: number) => i % 4 === 0 ? "development" : "holdout";
const subjects = [
    { name: "parser", prose: "text decoding", test: "parser.test.ts" },
    { name: "formatter", prose: "source layout", test: "formatter.test.ts" },
    { name: "cache", prose: "stored response reuse", test: "cache.test.ts" },
    { name: "router", prose: "request dispatch", test: "router.test.ts" },
];
function receiptGraph(name: string, test: string, passed: boolean) {
    const graph: ProvenanceGraph = { nodes: [
        { id: "claim", kind: "claim", text: "All 2 executed tests passed.", interpretation: "explicit",
            scope: { receiptId: name, sourceIdentity: "revision-1", selection: [test] } },
        { id: name, kind: "receipt", origin: "tool_result", result: { id: name, completion: "completed", sourceIdentity: "revision-1", selection: [test],
            runner: { success: passed, numTotalTests: 2, numPassedTests: passed ? 2 : 1, numFailedTests: passed ? 0 : 1, numPendingTests: 0, numTodoTests: 0 } } },
        { id: "run", kind: "run", completed: true, captureComplete: true, stableDuringRun: true, nondeterministic: false,
            environment: "node-fixture-1", selectionIdentity: test },
        { id: "test", kind: "input", path: test, sha256: hash(test), dependenciesComplete: true },
        { id: "source", kind: "input", path: test.replace(".test", ""), sha256: hash("source"), dependenciesComplete: true },
        { id: "config", kind: "input", path: "test.config.json", sha256: hash("config"), dependenciesComplete: true },
    ], edges: [
        ["claim", name, "cites"], [name, "run", "generated_by"], ["run", "test", "executed"], ["test", "source", "depends_on"],
        ["run", "test", "used"], ["run", "source", "used"], ["run", "config", "used"],
    ].map(([from, to, kind], i) => ({ id: `e${i}`, from: from!, to: to!, kind: kind as ProvenanceGraph["edges"][number]["kind"], basis: "observed" })) };
    const current: CurrentInputs = { environment: "node-fixture-1", selectionIdentity: test,
        files: { [test]: hash(test), [test.replace(".test", "")]: hash("source"), "test.config.json": hash("config") } };
    return { graph, current };
}
function varyProvenance(data: ReturnType<typeof receiptGraph>, test: string, variant: string): void {
    const run = data.graph.nodes[2]!, receipt = data.graph.nodes[1]!;
    if (run.kind !== "run" || receipt.kind !== "receipt") throw Error("fixture");
    if (variant === "dependency_edit") data.current.files[test.replace(".test", "")] = hash("edited");
    if (variant === "configuration_edit") data.current.files["test.config.json"] = hash("edited-config");
    if (variant === "summary") receipt.origin = "assistant";
    if (variant === "missing_input") data.graph.edges = data.graph.edges.filter(e => e.id !== "e5");
    if (variant === "execution_race") run.stableDuringRun = false;
    if (variant === "environment_change") data.current.environment = "node-fixture-2";
    if (variant === "missing_environment") data.current.environment = null;
    if (variant === "unrelated_edit") data.current.files["unrelated.md"] = hash("new");
    if (variant === "reordered") data.graph.edges.reverse();
}

export function provenanceCases() {
    const rows = [];
    const variants = ["current_pass", "unrelated_edit", "reverted_edit", "reordered", "failure", "dependency_edit", "configuration_edit", "summary", "missing_input", "execution_race", "environment_change", "missing_environment"];
    for (let i = 0; i < 48; i++) {
        const subject = subjects[Math.floor(i / 12)]!, variant = variants[i % variants.length]!;
        const target = `r${hash(`${i}:target`).slice(0, 8)}`, data = receiptGraph(target, subject.test, variant !== "failure");
        varyProvenance(data, subject.test, variant);
        const distractor = subjects[(Math.floor(i / 12) + 1) % subjects.length]!;
        rows.push({ id: `p${i}`, split: split(Math.floor(i / 12)), variant, target, expected: ["current_pass", "unrelated_edit", "reverted_edit", "reordered"].includes(variant),
            claim: `The ${subject.prose} checks pass for the current checkout.`,
            receipts: [{ id: target, description: `${subject.name} tests`, ...data },
                { id: `r${hash(`${i}:other`).slice(0, 8)}`, description: `${distractor.name} tests`,
                    ...receiptGraph(`r${hash(`${i}:other`).slice(0, 8)}`, distractor.test, true) }].sort((a, b) => hash(`${i}:${a.id}`).localeCompare(hash(`${i}:${b.id}`))) });
    }
    return rows;
}

export function extractionCases() {
    const rows = [];
    for (let i = 0; i < 24; i++) {
        const subject = subjects[i % 4]!, count = 7 + i;
        const parts = [
            `All ${count} ${subject.name} tests passed.`,
            "Type checking completed cleanly.",
            "The formatting check passed.",
            i % 2 ? `The ${subject.name} result excludes integration tests.` : `Only unit cases were included in the ${subject.name} test result.`,
            "I will run the integration tests next.",
            "Would you like a release?",
        ];
        const order = i % 3 === 0 ? [0, 3, 1, 4, 2, 5] : [0, 1, 4, 2, 3, 5];
        const spans = new Map<number, Span>(); let source = "";
        for (const index of order) { if (source) source += i % 2 ? "\n" : " "; const start = source.length; source += parts[index]; spans.set(index, [start, source.length]); }
        const claims: AnnotatedClaim[] = [0, 1, 2].map(index => ({ id: `${i}-c${index}`, spans: [spans.get(index)!], kind: "completion", polarity: "positive",
            scope: index === 0 ? "unit" : "explicit", interpretation: parts[index]!, qualifiers: index === 0 ? [{ spans: [spans.get(3)!], relation: "scope" }] : [],
            labels: { operational: "unsupported", curated: "unsupported" }, evidenceIds: { operational: [], curated: [] },
            rationale: { operational: "Extraction-only construction control", curated: "Extraction-only construction control" }, confidence: "construction" }));
        const annotation: Annotation = { id: `x${i}`, sourceSha256: hash(source), annotator: "construction-v1", schemaVersion: 1,
            annotationComplete: true, claims, nonClaims: [4, 5].map(index => ({ spans: [spans.get(index)!], reason: "future plan or question" })), unresolved: [] };
        rows.push({ id: `x${i}`, split: split(i), source, annotation });
    }
    return rows;
}

export function instructionCases() {
    const rows = [];
    for (let i = 0; i < 24; i++) {
        const subject = subjects[i % 4]!, other = subjects[(i + 1) % 4]!, kind = i % 6;
        const messages = [
            { id: "m1", role: "user", quoted: false, text: `Use a retry limit of 3 for ${subject.name}. Do not retry authentication failures.` },
            { id: "m2", role: "user", quoted: false, text: `Use a retry limit of 8 for ${other.name}.` },
            { id: "m3", role: kind === 1 ? "assistant" : "user", quoted: kind === 2,
                text: kind === 3 ? `Keep the ${subject.name} retry limit unchanged; change only its delay to 5 seconds.`
                    : kind === 4 ? `For ${other.name}, increase the retry limit to 5.`
                    : kind === 5 ? `For ${subject.name}, choose an appropriate retry limit later. The earlier value is withdrawn.`
                    : `For ${subject.name}, replace the retry limit with 5. The authentication exception still applies.` },
        ];
        rows.push({ id: `i${i}`, split: split(Math.floor(i / 6)), messages, query: `Which message supplies the currently instructed numeric retry limit for ${subject.name}?`,
            subject: subject.name, expected: kind === 0 ? "m3" : kind === 5 ? "none" : "m1", expectedException: true });
    }
    return rows;
}

export function documentationCases() {
    const rows = [];
    for (let i = 0; i < 16; i++) {
        const subject = subjects[i % 4]!, kind = Math.floor(i / 4);
        const target = `${subject.name}.ts`;
        const files: Record<string, string> = {
            "entry.ts": kind === 0 ? `import "./registry.js";` : kind === 3 ? `const name = process.env.PLUGIN; import(name);` : 'export const main = true;',
            "registry.ts": `import "./${subject.name}.js";`,
            [target]: `/** Implements ${subject.prose}. */ export const ${subject.name} = () => true;`,
            "orphan.ts": `import "./${subject.name}.js";`,
        };
        if (kind === 2) files["entry.ts"] = `import "./${subject.name}.js";`;
        rows.push({ id: `d${i}`, split: split(i), files, entry: "entry.ts", target,
            query: `Is the module implementing ${subject.prose} reachable from the entry module?`,
            expected: kind === 3 ? "unknown" : kind === 1 ? "unreachable" : "reachable" });
    }
    return rows;
}
