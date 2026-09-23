import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type * as TS from "typescript";
import { isJsonObject } from "../../lib/json-types.js";
import { functionName, hasParseErrors, isImplementationFunction, parseTsSource } from "./cyclomatic-ast.js";
import { REPEATED_IMPLEMENTATION_PYTHON } from "./repeated-implementation-python.js";
import { getExtension, isGeneratedFile, isTestFile, JS_TS_EXTS, type InlineMatch } from "./shared.js";

interface Implementation { name: string; line: number; shape: string; literals: string[]; }
export interface RepeatedImplementationMatch extends InlineMatch { fingerprint: string; }
const cache = new Map<string, RepeatedImplementationMatch[]>();
const MAX_BYTES = 256 * 1024;

function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function pythonImplementations(content: string): Implementation[] {
    const run = spawnSync("python3", ["-I", "-S", "-B", "-c", REPEATED_IMPLEMENTATION_PYTHON], {
        input: content, encoding: "utf8", timeout: 1_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (run.error || run.status !== 0) throw new Error("Python parser unavailable");
    const rows: unknown = JSON.parse(run.stdout);
    if (!Array.isArray(rows)) throw new Error("Invalid parser output");
    return rows.map((row: unknown) => {
        if (!isJsonObject(row) || typeof row.name !== "string" || typeof row.shape !== "string"
            || typeof row.line !== "number" || !Number.isSafeInteger(row.line) || row.line < 1
            || !Array.isArray(row.literals) || !row.literals.every(x => typeof x === "string")) {
            throw new Error("Invalid implementation");
        }
        return { name: row.name, shape: row.shape, line: row.line, literals: row.literals.filter((item): item is string => typeof item === "string") };
    });
}

interface ShapeContext {
    parsed: NonNullable<ReturnType<typeof parseTsSource>>;
    statements: number; nested: boolean; names: Map<string, number>; literals: string[];
}

function identifierShape(node: TS.Identifier, context: ShapeContext): unknown {
    const { ts } = context.parsed;
    const parent = node.parent;
    const fixed = (ts.isCallExpression(parent) && parent.expression === node)
        || (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node);
    if (fixed) return [node.kind, node.text];
    if (!context.names.has(node.text)) context.names.set(node.text, context.names.size);
    return [node.kind, context.names.get(node.text)];
}

function nodeShape(node: TS.Node, context: ShapeContext): unknown {
    const { ts, sf } = context.parsed;
    if (isImplementationFunction(ts, node)) context.nested = true;
    if (ts.isStatement(node) && !ts.isBlock(node)) context.statements++;
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        context.literals.push(node.getText(sf).slice(0, 48));
        return [node.kind, "literal"];
    }
    if (ts.isIdentifier(node)) return identifierShape(node, context);
    const children = node.getChildren(sf).filter(c => c.kind !== ts.SyntaxKind.SemicolonToken);
    return [node.kind, children.map(child => nodeShape(child, context))];
}

function tsImplementation(node: TS.Node, parsed: ShapeContext["parsed"]): Implementation | null {
    const { ts, sf } = parsed;
    if (!isImplementationFunction(ts, node)) return null;
    const body = node.getChildren(sf).find(child => ts.isBlock(child));
    if (!body) return null;
    const context: ShapeContext = { parsed, statements: 0, nested: false, names: new Map(), literals: [] };
    const shape = nodeShape(body, context);
    if (context.nested || context.statements < 5) return null;
    return { name: functionName(ts, node, sf), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        shape: JSON.stringify(shape), literals: context.literals };
}

function typescriptImplementations(content: string, path: string): Implementation[] {
    const parsed = parseTsSource(content, path);
    if (!parsed || hasParseErrors(parsed.sf)) throw new Error("TypeScript parser unavailable");
    const rows: Implementation[] = [];
    function visit(node: TS.Node): void {
        const row = tsImplementation(node, parsed!);
        if (row) rows.push(row);
        parsed!.ts.forEachChild(node, visit);
    }
    visit(parsed.sf);
    return rows;
}

function groupImplementations(rows: Implementation[]): RepeatedImplementationMatch[] {
    const groups = new Map<string, Implementation[]>();
    for (const row of rows) {
        const group = groups.get(row.shape) ?? [];
        group.push(row);
        groups.set(row.shape, group);
    }
    const findings: RepeatedImplementationMatch[] = [];
    for (const [shape, group] of groups) {
        if (group.length < 2) continue;
        const members = group.map(row => `${row.name}@L${row.line}`).join(", ");
        const varying = group[0]!.literals.map((_, index) => index)
            .filter(index => new Set(group.map(row => row.literals[index])).size > 1);
        const differences = varying.length ? group.slice(0, 4).map(row => `${row.name}: ${JSON.stringify(varying.map(index => row.literals[index])).slice(0, 160)}`).join("; ") : "no literal differences";
        findings.push({ line: group[0]!.line,
            fingerprint: hash(JSON.stringify([shape, group.map(row => [row.name, row.literals])])),
            text: `${group.length} similar implementations (${members}). Literal values: ${differences}. Consider one shared operation with the differing values as parameters; keep separate if contracts differ. Advisory only.`,
        });
    }
    return findings;
}

/** Whole-function AST shapes, five or more statements; never a correctness verdict. */
export function checkRepeatedImplementation(content: string, path: string): RepeatedImplementationMatch[] {
    const extension = getExtension(path);
    if ((!JS_TS_EXTS.has(extension) && extension !== ".py") || isTestFile(path) || isGeneratedFile(content)) return [];
    const unavailable = (reason: string): RepeatedImplementationMatch[] => [{ line: 1, fingerprint: hash(reason),
        text: `Repeated implementation NOT CHECKED: ${reason}. No duplication conclusion is available.` }];
    if (Buffer.byteLength(content) > MAX_BYTES) return unavailable("source exceeds 256 KiB budget");
    const key = hash(`${extension}\0${content}`);
    const hit = cache.get(key);
    if (hit) return hit.map(row => ({ ...row }));
    try {
        const findings = groupImplementations(extension === ".py" ? pythonImplementations(content) : typescriptImplementations(content, path));
        if (cache.size >= 32) cache.delete(cache.keys().next().value!);
        cache.set(key, findings);
        return findings.map(row => ({ ...row }));
    } catch { return unavailable("parser missing, timed out, or source syntax invalid"); }
}
