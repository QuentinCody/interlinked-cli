import { computeFunctionTokens } from "../../harness/function-tokens/index.js";
import { cyclomaticOfFunction, parseTsSource, type ParsedTsSource } from "../../harness/checks/cyclomatic-ast.js";
import type * as TS from "typescript";
import { visitCognitiveFunctions } from "../../harness/checks/cognitive-ast.js";
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

/** First changed line at or after the start, compared with this inclusive function span. */
function hasChangedLine(changed: readonly number[], start: number, end: number): boolean {
    let low = 0, high = changed.length;
    while (low < high) {
        const mid = low + Math.floor((high - low) / 2);
        if (changed[mid]! < start) low = mid + 1;
        else high = mid;
    }
    return low < changed.length && changed[low]! <= end;
}

function sourceIdentity(
    source: ChangedSource, parsed: ParsedTsSource | null,
): Pick<EvidenceRecord, "repository" | "revision" | "timestamp" | "file" | "provenance"> {
    const metricsVersion = `interlinked-code-v2:semantic-evidence-v4:typescript-${parsed?.ts.version ?? "unavailable"}`;
    return {
        repository: source.repository,
        revision: source.revision,
        timestamp: source.timestamp,
        file: source.file,
        provenance: {
            extractor: "semantic-evidence-v4",
            sourceHash: digest(source.after),
            metricsVersion,
        },
    };
}

export function extractChangedEvidence(source: ChangedSource): EvidenceRecord[] {
    const parsed = /\.[cm]?[jt]sx?$/.test(source.file)
        ? parseTsSource(source.after, source.file)
        : null;
    const identity = sourceIdentity(source, parsed);
    const hunks = parseHunks(source.diff);
    const changed = [...changedLines(hunks)].sort((a, b) => a - b);
    const entries = computeFunctionTokens(source.after, source.file) ?? [];
    const details = functionDetails(source.after, parsed);
    const rows: EvidenceRecord[] = entries
        .filter(
            (entry) =>
                source.allFunctions ||
                hasChangedLine(changed, details.get(entry.startOffset)?.comment?.startLine ?? entry.line, entry.endLine),
        )
        .map((entry) => {
            const body = source.after.slice(entry.startOffset, entry.endOffset);
            const detail = details.get(entry.startOffset);
            const comment = detail?.comment;
            const related = hunks.filter(
                (h) =>
                    h.newStart <= entry.endLine &&
                    h.newStart + Math.max(1, h.newCount) > entry.line,
            );
            const metrics: Record<string, Json> = {
                lines: entry.endLine - entry.line + 1,
                tokens: entry.canonicalTokens,
            };
            if (detail) Object.assign(metrics, detail.metrics);
            const id = `${source.file}::${entry.qualifiedName}:${entry.identityKind === "named" ? entry.declarationKind : entry.line}`;
            return {
                ...identity,
                id,
                unit: "function",
                line: entry.line,
                evidence: {
                    body,
                    ...(comment ? { comment: comment.text, commentLocation: { startLine: comment.startLine, endLine: comment.endLine } } : {}),
                    signature: entry.qualifiedName,
                    hunk: related.map((h) => h.text).join("\n"),
                    message: source.message,
                    metrics,
                },
            };
        });
    for (const hunk of hunkEvidence(source, identity, hunks)) rows.push(hunk);
    return rows;
}

interface AttachedComment { text: string; startLine: number; endLine: number; }

/** Only syntactically adjacent comments attach; a separated header is not a function claim. */
function attachedComment(content: string, parsed: ParsedTsSource, node: TS.Node): AttachedComment | undefined {
    const { ts, sf } = parsed;
    let owner = node;
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent) && ts.isVariableDeclarationList(parent.parent)
        && parent.parent.declarations.length === 1 && ts.isVariableStatement(parent.parent.parent)) owner = parent.parent.parent;
    else if (parent && ts.isPropertyAssignment(parent)) owner = parent;
    const ranges = ts.getLeadingCommentRanges(content, owner.getFullStart()) ?? [];
    const adjacent: TS.CommentRange[] = [];
    let end = owner.getStart(sf);
    for (const range of [...ranges].reverse()) {
        const gap = content.slice(range.end, end);
        if (gap.trim() || (gap.match(/\n/g)?.length ?? 0) > 1) break;
        adjacent.unshift(range);
        end = range.pos;
    }
    const first = adjacent[0], last = adjacent.at(-1);
    if (!first || !last) return undefined;
    return {
        text: adjacent.map(range => content.slice(range.pos, range.end)).join("\n"),
        startLine: sf.getLineAndCharacterOfPosition(first.pos).line + 1,
        endLine: sf.getLineAndCharacterOfPosition(last.end).line + 1,
    };
}

interface FunctionDetail {
    metrics: { cyclomatic: number; cognitive: number; nesting: number };
    comment: AttachedComment | undefined;
}

function functionDetails(content: string, parsed: ParsedTsSource | null): Map<number, FunctionDetail> {
    const details = new Map<number, FunctionDetail>();
    if (!parsed) return details;
    const { ts, sf } = parsed;
    visitCognitiveFunctions(ts, sf, (node, entry) => {
        details.set(node.getStart(sf), {
            metrics: { cyclomatic: cyclomaticOfFunction(ts, node), cognitive: entry.cognitive, nesting: entry.maxNesting },
            comment: attachedComment(content, parsed, node),
        });
    });
    return details;
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
