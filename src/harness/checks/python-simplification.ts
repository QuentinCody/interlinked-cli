import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isJsonObject } from "../../lib/json-types.js";
import type { InlineMatch } from "./shared.js";
import { PYTHON_SIMPLIFICATION_SCRIPT } from "./python-simplification-script.js";

interface PythonAdvice extends InlineMatch { kind: string; }
const cache = new Map<string, PythonAdvice[]>();
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_CACHED_FILES = 32;
const MAX_ADVICE = 5;

function parseAdvice(output: string): PythonAdvice[] {
    const value: unknown = JSON.parse(output);
    if (!Array.isArray(value)) throw new Error("Invalid AST response");
    return value.map(row => {
        if (!isJsonObject(row) || typeof row.line !== "number" || !Number.isSafeInteger(row.line) || row.line < 1 || typeof row.text !== "string" || typeof row.kind !== "string") throw new Error("Invalid AST finding");
        return { line: row.line, text: row.text, kind: row.kind };
    });
}

/** Small content-addressed cache shared by the two advisory registry entries. */
export function pythonSimplificationAdvice(content: string, filePath: string): PythonAdvice[] {
    if (!filePath.endsWith(".py")) return [];
    if (Buffer.byteLength(content) > MAX_SOURCE_BYTES) return [{ line: 1, kind: "unavailable", text: "Python simplification NOT CHECKED: source exceeds the bounded AST input budget." }];
    const key = createHash("sha256").update(content).digest("hex");
    const cached = cache.get(key);
    if (cached) return cached;
    try {
        const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-S", "-B", "-c", PYTHON_SIMPLIFICATION_SCRIPT], {
            input: content, encoding: "utf8", timeout: 1000, maxBuffer: 1024 * 1024,
        });
        if (result.error || result.status !== 0) throw new Error("Python AST unavailable");
        const rows = parseAdvice(result.stdout);
        if (cache.size >= MAX_CACHED_FILES) cache.delete(cache.keys().next().value!);
        cache.set(key, rows);
        return rows;
    } catch { return [{ line: 1, kind: "unavailable", text: "Python simplification NOT CHECKED: isolated Python parser unavailable, timed out, or source could not be parsed." }]; }
}

export function checkPythonSimplification(content: string, filePath: string): InlineMatch[] {
    return pythonSimplificationAdvice(content, filePath).filter(row => row.kind !== "helper").slice(0, MAX_ADVICE);
}

export function checkPythonTrivialHelper(content: string, filePath: string): InlineMatch[] {
    return pythonSimplificationAdvice(content, filePath).filter(row => row.kind === "helper").slice(0, MAX_ADVICE);
}
