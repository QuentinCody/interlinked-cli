import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { computeFunctionTokens, functionTokenAnalyzerStatus } from "../function-tokens/index.js";
import { CANONICAL_TOKENIZER_ID, type FunctionTokenEntry } from "../function-tokens/types.js";
import { isCappableFile } from "../large-file-policy.js";
import { maxFunctionTokensFor } from "../metric-caps.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import type { HarnessEvent } from "../types.js";
import { isFileWrite } from "./tool-classifiers.js";

const MAX_STASH_ENTRIES = 256;
const MAX_FILES_PER_EVENT = 4;
const REVIEW_BAND_START = 251;

interface FunctionTokenSnapshot {
    before: FunctionTokenEntry[];
    after: FunctionTokenEntry[];
    afterHash: string;
}

const stash = new Map<string, FunctionTokenSnapshot>();

function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function key(sessionId: string, path: string): string {
    return `${sessionId}\0${path}`;
}

export function recordFunctionTokenPulse(
    sessionId: string,
    absolutePath: string,
    before: FunctionTokenEntry[],
    after: FunctionTokenEntry[],
    afterContent: string,
): void {
    const stashKey = key(sessionId, absolutePath);
    stash.delete(stashKey);
    stash.set(stashKey, { before, after, afterHash: hash(afterContent) });
    if (stash.size > MAX_STASH_ENTRIES) {
        const oldest = stash.keys().next().value;
        if (oldest !== undefined) stash.delete(oldest);
    }
}

function consume(sessionId: string, path: string, content: string): FunctionTokenSnapshot | null {
    const stashKey = key(sessionId, path);
    const snapshot = stash.get(stashKey);
    if (snapshot === undefined) return null;
    stash.delete(stashKey);
    return snapshot.afterHash === hash(content) ? snapshot : null;
}

function maximum(entries: readonly FunctionTokenEntry[]): FunctionTokenEntry | undefined {
    return [...entries].sort((a, b) => b.canonicalTokens - a.canonicalTokens
        || a.qualifiedName.localeCompare(b.qualifiedName))[0];
}

function signed(value: number): string {
    return value > 0 ? `+${value}` : String(value);
}

export function formatFunctionTokenPulse(
    displayPath: string,
    before: readonly FunctionTokenEntry[] | null,
    after: readonly FunctionTokenEntry[],
    cap: number,
): string | null {
    if (after.length === 0 && (before?.length ?? 0) === 0) return null;
    const currentMax = maximum(after);
    const priorMax = before === null ? undefined : maximum(before);
    let line = `[interlinked:function-tokens] ${displayPath}: ${after.length} fns`;
    if (currentMax !== undefined) {
        line += `, max ${currentMax.qualifiedName}=${currentMax.canonicalTokens}`;
        if (before !== null) line += ` (Δ${signed(currentMax.canonicalTokens - (priorMax?.canonicalTokens ?? 0))})`;
        line += `, cap ${cap}`;
    }
    const reviewBand = after.filter((entry) => entry.canonicalTokens >= REVIEW_BAND_START && entry.canonicalTokens <= cap).length;
    const overCap = after.filter((entry) => entry.canonicalTokens > cap).length;
    if (reviewBand > 0) line += `; review band ${reviewBand}`;
    if (overCap > 0) line += `; over cap ${overCap}`;
    return `${line}; tokenizer ${CANONICAL_TOKENIZER_ID}`;
}

function pulseForFile(sessionId: string, cwd: string, absolutePath: string): string | null {
    let content: string;
    try {
        content = readFileSync(absolutePath, "utf8");
    } catch {
        return null;
    }
    const snapshot = consume(sessionId, absolutePath, content);
    let before: readonly FunctionTokenEntry[] | null;
    let after: FunctionTokenEntry[] | null;
    if (snapshot !== null) {
        before = snapshot.before;
        after = snapshot.after;
    } else {
        if (!isCappableFile({ filePath: absolutePath, content, root: cwd })) return null;
        before = null;
        after = computeFunctionTokens(content, absolutePath);
    }
    const rel = relative(cwd, absolutePath);
    const display = rel === "" || rel.startsWith("..") ? absolutePath : rel;
    if (after === null) {
        const status = functionTokenAnalyzerStatus(absolutePath);
        return status.language === "unknown"
            ? null
            : `[interlinked:function-tokens:not-measured] ${display}: ${status.language} exact adapter unavailable`;
    }
    return formatFunctionTokenPulse(display, before, after, maxFunctionTokensFor(cwd));
}

export function collectFunctionTokenPulseWarnings(event: HarnessEvent): string[] {
    if (!isFileWrite(event.tool_name || "")) return [];
    const cwd = event.cwd || process.cwd();
    const warnings: string[] = [];
    for (const path of extractAllEditedFilePaths(event).slice(0, MAX_FILES_PER_EVENT)) {
        const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
        const warning = pulseForFile(event.session_id, cwd, absolutePath);
        if (warning !== null) warnings.push(warning);
    }
    return warnings;
}

export function resetFunctionTokenPulseForTesting(): void {
    stash.clear();
}
