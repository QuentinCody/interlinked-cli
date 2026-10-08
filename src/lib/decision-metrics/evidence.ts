import { computeFunctionTokens } from "../../harness/function-tokens/index.js";
import { computeCyclomaticAst, parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { computeCognitiveAst } from "../../harness/checks/cognitive-ast.js";
import { object } from "./answers.js";
import { digest } from "./store.js";
import type { EvidenceRecord, Json } from "./types.js";

export interface Hunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    text: string;
}
export interface ChangedSource {
    file: string;
    before: string;
    after: string;
    diff: string;
    repository: string;
    revision: string;
    timestamp: string;
    message: string;
    allFunctions?: boolean;
}

export function parseHunks(diff: string): Hunk[] {
    const hunks: Hunk[] = [];
    for (const line of diff.split("\n")) {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (match)
            hunks.push({
                oldStart: Number(match[1]),
                oldCount: Number(match[2] ?? 1),
                newStart: Number(match[3]),
                newCount: Number(match[4] ?? 1),
                text: line,
            });
        else if (hunks.length && !line.startsWith("diff --git") && !line.startsWith("index "))
            hunks.at(-1)!.text += `\n${line}`;
    }
    return hunks;
}

function changedLines(hunks: Hunk[]): Set<number> {
    const lines = new Set<number>();
    for (const hunk of hunks) {
        let line = hunk.newStart;
        for (const text of hunk.text.split("\n").slice(1)) {
            if (text.startsWith("+")) lines.add(line++);
            else if (text.startsWith("-")) lines.add(Math.max(1, line));
            else if (text.startsWith(" ")) line++;
        }
    }
    return lines;
}

function sourceIdentity(
    source: ChangedSource,
): Pick<EvidenceRecord, "repository" | "revision" | "timestamp" | "file" | "provenance"> {
    const parsed = /\.[cm]?[jt]sx?$/.test(source.file)
        ? parseTsSource(source.after, source.file)
        : null;
    const metricsVersion = `interlinked-code-v2:semantic-evidence-v2:typescript-${parsed?.ts.version ?? "unavailable"}`;
    return {
        repository: source.repository,
        revision: source.revision,
        timestamp: source.timestamp,
        file: source.file,
        provenance: {
            extractor: "semantic-evidence-v2",
            sourceHash: digest(source.after),
            metricsVersion,
        },
    };
}

export function extractChangedEvidence(source: ChangedSource): EvidenceRecord[] {
    const identity = sourceIdentity(source);
    const hunks = parseHunks(source.diff);
    const changed = changedLines(hunks);
    const entries = computeFunctionTokens(source.after, source.file) ?? [];
    const cyclomatic = /\.[cm]?[jt]sx?$/.test(source.file)
        ? (computeCyclomaticAst(source.after, source.file) ?? [])
        : [];
    const cognitive = /\.[cm]?[jt]sx?$/.test(source.file)
        ? (computeCognitiveAst(source.after, source.file) ?? [])
        : [];
    const rows: EvidenceRecord[] = entries
        .filter(
            (entry) =>
                source.allFunctions ||
                [...changed].some((line) => line >= entry.line && line <= entry.endLine),
        )
        .map((entry) => {
            const body = source.after.slice(entry.startOffset, entry.endOffset);
            const cc = cyclomatic.find((item) => item.line === entry.line);
            const cog = cognitive.find((item) => item.line === entry.line);
            const related = hunks.filter(
                (h) =>
                    h.newStart <= entry.endLine &&
                    h.newStart + Math.max(1, h.newCount) > entry.line,
            );
            const metrics: Record<string, Json> = {
                lines: entry.endLine - entry.line + 1,
                tokens: entry.canonicalTokens,
            };
            if (cc) metrics.cyclomatic = cc.cyclomatic;
            if (cog) {
                metrics.cognitive = cog.cognitive;
                metrics.nesting = cog.maxNesting;
            }
            const id = `${source.file}::${entry.qualifiedName}:${entry.identityKind === "named" ? entry.declarationKind : entry.line}`;
            return {
                ...identity,
                id,
                unit: "function",
                line: entry.line,
                evidence: {
                    body,
                    signature: entry.qualifiedName,
                    hunk: related.map((h) => h.text).join("\n"),
                    message: source.message,
                    metrics,
                },
            };
        });
    rows.push(...hunkEvidence(source, identity, hunks));
    return rows;
}

function hunkEvidence(
    source: ChangedSource,
    identity: ReturnType<typeof sourceIdentity>,
    hunks: Hunk[],
): EvidenceRecord[] {
    if (!hunks.length) return [];
    const declarations = declarationSpans(source.after, source.file);
    const previousDeclarations = declarationSpans(source.before, source.file);
    return hunks.map((hunk, index) => ({
        ...identity,
        id: `${source.file}::hunk:${index}`,
        unit: "hunk",
        line: Math.max(1, hunk.newStart),
        evidence: {
            hunk: hunk.text,
            message: source.message,
            symbols: [
                ...new Set([
                    ...namesInRange(declarations, hunk.newStart, hunk.newCount),
                    ...namesInRange(previousDeclarations, hunk.oldStart, hunk.oldCount),
                ]),
            ],
        },
    }));
}

interface DeclarationSpan {
    name: string;
    start: number;
    end: number;
}
function declarationSpans(content: string, file: string): DeclarationSpan[] {
    if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
    const parsed = parseTsSource(content, file);
    if (!parsed) return [];
    return parsed.sf.statements
        .filter(
            (statement) =>
                parsed.ts.isTypeAliasDeclaration(statement) ||
                parsed.ts.isInterfaceDeclaration(statement) ||
                parsed.ts.isEnumDeclaration(statement),
        )
        .map((statement) => ({
            name: statement.name.text,
            start: parsed.sf.getLineAndCharacterOfPosition(statement.getStart(parsed.sf)).line + 1,
            end: parsed.sf.getLineAndCharacterOfPosition(statement.end).line + 1,
        }));
}

function namesInRange(declarations: DeclarationSpan[], start: number, count: number): string[] {
    return declarations
        .filter(
            (declaration) =>
                declaration.start < start + Math.max(1, count) && declaration.end >= start,
        )
        .map((declaration) => declaration.name);
}

function assertEvidence(value: unknown): asserts value is EvidenceRecord {
    const row = object(value);
    for (const key of ["id", "repository", "revision", "timestamp", "file"])
        if (typeof row[key] !== "string" || !row[key]) throw new Error(`evidence requires ${key}`);
    if (!["function", "hunk", "commit", "pair", "claim"].includes(String(row.unit)))
        throw new Error("invalid evidence unit");
    if (typeof row.line !== "number" || !Number.isSafeInteger(row.line) || row.line < 1)
        throw new Error("invalid evidence line");
    if (!Number.isFinite(Date.parse(String(row.timestamp))))
        throw new Error("invalid evidence timestamp");
    object(row.evidence);
    const provenance = object(row.provenance);
    for (const key of ["extractor", "sourceHash", "metricsVersion"])
        if (typeof provenance[key] !== "string") throw new Error(`missing provenance ${key}`);
    if (row.eligible !== undefined && typeof row.eligible !== "boolean")
        throw new Error("invalid eligibility");
    if (row.reason !== undefined && typeof row.reason !== "string")
        throw new Error("invalid evidence reason");
}

export function validateEvidence(value: unknown): EvidenceRecord {
    assertEvidence(value);
    return value;
}
