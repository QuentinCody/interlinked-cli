import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import type { AnalyzedFile, RepositoryAnalysis } from "./analysis.js";
import { qualityFinding, ratioReading } from "./adapter-values.js";
import { hashBytes } from "./inventory.js";
import type { AdapterResult } from "./measurement-types.js";
import { syntaxSequence } from "./syntax-sequence.js";

interface CloneMember { file: AnalyzedFile; line: number; endLine: number; exposure: number; hash: string; }

/** Exact written-token sequences, preserving identifiers/literals. Near-clones stay advisory. */
function functionHashes(file: AnalyzedFile): CloneMember[] {
    const parsed = parseTsSource(file.input.content, file.input.path);
    if (!parsed) return [];
    const bodies = new Map<number, string[]>();
    function visit(node: import("typescript").Node): void {
        if (parsed && parsed.ts.isFunctionLike(node) && "body" in node && node.body) {
            bodies.set(node.getStart(parsed.sf), syntaxSequence(node.body, parsed));
        }
        parsed?.ts.forEachChild(node, visit);
    }
    visit(parsed.sf);
    const out: CloneMember[] = [];
    for (const fn of file.structure?.functions ?? []) {
        if (fn.tokens < 30) continue;
        const tokens = bodies.get(fn.startOffset);
        if (!tokens) continue;
        out.push({ file, line: fn.line, endLine: fn.endLine, exposure: fn.exposure, hash: hashBytes(JSON.stringify(tokens)) });
    }
    return out;
}

export function measureExactClones(analysis: RepositoryAnalysis): AdapterResult {
    const groups = new Map<string, CloneMember[]>();
    let exposure = 0;
    for (const file of analysis.files) {
        exposure += (file.structure?.functions ?? []).reduce((sum, fn) => sum + fn.exposure, 0);
        for (const member of functionHashes(file)) groups.set(member.hash, [...(groups.get(member.hash) ?? []), member]);
    }
    const duplicate = [...groups.values()].flatMap(group => group.slice(1));
    const findings = duplicate.map(member => qualityFinding({ metric: "redundancy.clones", file: member.file.input,
        line: member.line, endLine: member.endLine, message: "Implementation repeats an exact syntax-token sequence; confirm shared behavior before consolidating",
        related: (groups.get(member.hash) ?? []).map(peer => `${peer.file.input.path}:${peer.line}`) }));
    const reading = ratioReading("redundancy.clones", duplicate.reduce((sum, member) => sum + member.exposure, 0), exposure);
    reading.limitations.push("Counts redundant exclusive exposure once per exact group; functions below 30 tokens and near-clones remain unscored.");
    return { metrics: [reading], findings };
}
