import { spawnSync } from "node:child_process";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import type { FunctionTokenEntry } from "./types.js";

const PYTHON_ADAPTER = String.raw`
import ast, io, json, sys, token, tokenize

source = sys.stdin.read()
lines = source.splitlines(keepends=True)
line_starts = []
offset = 0
for line in lines:
    line_starts.append(offset)
    offset += len(line)
if not lines or (source and not source.endswith(("\n", "\r"))):
    line_starts.append(offset)

def char_pos(line, col):
    if line <= 0:
        return 0
    base = line_starts[min(line - 1, len(line_starts) - 1)] if line_starts else 0
    return base + col

def ast_char_col(line, byte_col):
    text = lines[line - 1] if 0 < line <= len(lines) else ""
    return len(text.encode("utf-8")[:byte_col].decode("utf-8", "ignore"))

def ast_pos(line, byte_col):
    return char_pos(line, ast_char_col(line, byte_col))

def utf16_pos(index):
    return len(source[:index].encode("utf-16-le")) // 2

ignored = {
    token.ENDMARKER, token.INDENT, token.DEDENT, token.NEWLINE,
    tokenize.NL, tokenize.COMMENT, tokenize.ENCODING,
}
tokens = []
try:
    for item in tokenize.generate_tokens(io.StringIO(source).readline):
        start = char_pos(item.start[0], item.start[1])
        end = char_pos(item.end[0], item.end[1])
        if item.type not in ignored and not (item.type == token.ERRORTOKEN and item.string.isspace()):
            tokens.append((start, end))
except (tokenize.TokenError, IndentationError):
    pass

try:
    tree = ast.parse(source)
except (SyntaxError, ValueError, TypeError):
    print(json.dumps({"ok": False, "reason": "python parse failed"}))
    raise SystemExit(0)

rows = []

class Visitor(ast.NodeVisitor):
    def __init__(self):
        self.stack = []

    def record(self, node, name, kind):
        decorators = getattr(node, "decorator_list", [])
        first = min(decorators, key=lambda item: (item.lineno, item.col_offset)) if decorators else node
        first_col = max(0, first.col_offset - 1) if decorators else first.col_offset
        start = ast_pos(first.lineno, first_col)
        end = ast_pos(node.end_lineno, node.end_col_offset)
        qualified = ".".join([part[0] for part in self.stack] + [name])
        rows.append({
            "name": name,
            "qualifiedName": qualified,
            "declarationKind": kind,
            "language": "python",
            "startOffset": utf16_pos(start),
            "endOffset": utf16_pos(end),
            "line": first.lineno,
            "endLine": node.end_lineno,
            "canonicalTokens": sum(1 for token_start, token_end in tokens if token_start >= start and token_end <= end),
            "identityKind": "named",
        })

    def function_kind(self, node):
        if node.name == "__init__":
            return "constructor"
        if self.stack and self.stack[-1][1] == "function":
            return "closure"
        if self.stack and self.stack[-1][1] == "class":
            return "method"
        return "function"

    def visit_ClassDef(self, node):
        self.stack.append((node.name, "class"))
        self.generic_visit(node)
        self.stack.pop()

    def visit_FunctionDef(self, node):
        self.record(node, node.name, self.function_kind(node))
        self.stack.append((node.name, "function"))
        self.generic_visit(node)
        self.stack.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Lambda(self, node):
        name = "(callback)"
        self.record(node, name, "lambda")
        self.stack.append((f"<lambda>@{node.lineno}:{node.col_offset}", "function"))
        self.generic_visit(node)
        self.stack.pop()

Visitor().visit(tree)
rows.sort(key=lambda row: (row["startOffset"], row["endOffset"]))
counts = {}
for row in rows:
    counts[row["qualifiedName"]] = counts.get(row["qualifiedName"], 0) + 1
for row in rows:
    if row["name"] == "(callback)":
        row["identityKind"] = "anonymous"
    elif counts[row["qualifiedName"]] > 1:
        row["identityKind"] = "colliding"
print(json.dumps({"ok": True, "entries": rows}, separators=(",", ":")))
`;

function isTokenCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parsePositions(value: JsonObject): Pick<FunctionTokenEntry, "startOffset" | "endOffset" | "line" | "endLine" | "canonicalTokens"> | null {
    const { startOffset, endOffset, line, endLine, canonicalTokens } = value;
    if (!isTokenCount(startOffset) || !isTokenCount(endOffset) || !isTokenCount(line)
        || !isTokenCount(endLine) || !isTokenCount(canonicalTokens)) return null;
    return { startOffset, endOffset, line, endLine, canonicalTokens };
}

function parseEntry(value: unknown): FunctionTokenEntry | null {
    if (!isJsonObject(value)) return null;
    const { name, qualifiedName, language } = value;
    if (typeof name !== "string" || typeof qualifiedName !== "string" || language !== "python") return null;
    const declarationKind = (["function", "method", "constructor", "closure", "lambda"] as const)
        .find((kind) => kind === value.declarationKind);
    const identityKind = (["named", "anonymous", "colliding"] as const).find((kind) => kind === value.identityKind);
    const positions = parsePositions(value);
    if (!declarationKind || !identityKind || !positions) return null;
    return { name, qualifiedName, language, declarationKind, identityKind, ...positions };
}

function parseAdapterOutput(value: unknown): FunctionTokenEntry[] | null {
    if (!isJsonObject(value) || value.ok !== true || !Array.isArray(value.entries)) return null;
    const entries: FunctionTokenEntry[] = [];
    for (const valueEntry of value.entries) {
        const entry = parseEntry(valueEntry);
        if (!entry) return null;
        entries.push(entry);
    }
    return entries;
}

export function computePythonFunctionTokens(
    content: string,
    _filePath: string,
): FunctionTokenEntry[] | null {
    const result = spawnSync("python3", ["-c", PYTHON_ADAPTER], {
        encoding: "utf8",
        input: content,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 2_000,
    });
    if (result.status !== 0 || result.error || !result.stdout) return null;
    try {
        return parseAdapterOutput(JSON.parse(result.stdout));
    } catch {
        return null;
    }
}
