import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readBoundedTextFile } from "../lib/bounded-file-core.js";
import { parseJsonObjectText, type JsonObject } from "../lib/json-types.js";
import { isDirectFileEditTool } from "../lib/write-tool-registry.js";
import { detectBashCodeFileWrite, resolveBashWriteTarget } from "./pre-checks-bash-write-detect.js";
import { extractAllEditedFilePaths, extractApplyPatchRaw } from "./server-tool-helpers.js";
import type { HarnessEvent } from "./types.js";

export const TOUCHED_LEDGER_MAX_BYTES = 1024 * 1024;
export interface TouchedFileRecord { session_id: string; tool_use_id: string; path: string; bytes: number; ts: string; }
export interface TouchedLedger { available: boolean; complete: boolean; rows: TouchedFileRecord[]; }

export function touchedLedgerPath(root: string, session: string): string {
    return join(root, ".interlinked", "touched-files", `${createHash("sha256").update(session).digest("hex")}.jsonl`);
}

function declaredTargetPaths(event: HarnessEvent, root: string): string[] {
    if (isDirectFileEditTool(event.tool_name)) {
        const declared = { ...event };
        delete declared.change_set;
        const paths = extractAllEditedFilePaths(declared);
        if (event.tool_name !== "apply_patch") return paths;
        // The edit checks select rename destinations; the ledger also records source paths.
        const patch = extractApplyPatchRaw(event.tool_input);
        for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm)) paths.push(match[1]!.trim());
        return paths;
    }
    if (!["Bash", "Shell", "shell", "run_command", "exec_command"].includes(event.tool_name ?? "")) return [];
    const command = typeof event.tool_input?.command === "string" ? event.tool_input.command : "";
    const found = detectBashCodeFileWrite(command);
    const target = found && resolveBashWriteTarget(command, found.target, root);
    return target ? [target] : [];
}

/** Declared targets only: a concurrent writer's workspace diff is not authorship. */
export function touchedTargets(event: HarnessEvent, root: string): string[] {
    if (event.dry_run || event.tool_outcome === "error" || !["PostToolUse", "AfterTool"].includes(event.hook_event)) return [];
    const paths = declaredTargetPaths(event, root);
    return [...new Set(paths.map(path => relative(root, resolve(root, path)).replaceAll("\\", "/")))]
        .filter(path => path.length > 0 && path.length <= 4096 && path !== ".." && !path.startsWith("../") && !isAbsolute(path));
}

/** A metadata-only ledger. Failed/dry-run calls never create it; restart needs no memory state. */
export function captureTouchedFiles(event: HarnessEvent, fallbackRoot: string): void {
    if (event.dry_run || !event.session_id) return;
    const root = resolve(event.cwd || fallbackRoot), paths = touchedTargets(event, root);
    const start = event.hook_event === "SessionStart";
    if (!start && !paths.length) return;
    const path = touchedLedgerPath(root, event.session_id);
    try {
        mkdirSync(dirname(path), { recursive: true });
        if (!existsSync(path)) {
            try { writeFileSync(path, JSON.stringify({ schema: 1, session_id: event.session_id, started: start, ts: event.timestamp }) + "\n", { flag: "wx" }); }
            catch (error) { if (!existsSync(path)) throw error; }
        }
        if (!paths.length) return;
        const ledger = readTouchedLedger(root, event.session_id);
        const seen = new Set(ledger.rows.map(row => `${row.tool_use_id}\0${row.path}`));
        const records = paths.slice(0, 256).flatMap(file => {
            const id = event.tool_use_id || `timestamp:${event.timestamp}`;
            if (seen.has(`${id}\0${file}`)) return [];
            let bytes = 0;
            try { bytes = statSync(resolve(root, file)).size; } catch (error) { void error; }
            return [{ session_id: event.session_id, tool_use_id: id, path: file, bytes, ts: event.timestamp } satisfies TouchedFileRecord];
        });
        const text = records.map(row => JSON.stringify(row) + "\n").join("");
        if (paths.length > 256 || statSync(path).size + Buffer.byteLength(text) > TOUCHED_LEDGER_MAX_BYTES) {
            writeFileSync(`${path}.overflow`, "incomplete\n"); return;
        }
        if (text) appendFileSync(path, text);
    } catch (error) { void error; /* telemetry must not fail a completed tool call */ }
}

function isTouchedRecord(row: JsonObject | null, session: string): row is JsonObject & TouchedFileRecord {
    return row !== null && row.session_id === session && typeof row.path === "string" && typeof row.tool_use_id === "string"
        && typeof row.bytes === "number" && typeof row.ts === "string";
}

function parseTouchedLedger(text: string, session: string, until: number): TouchedLedger | null {
    const [first, ...entries] = text.trimEnd().split("\n");
    if (!first) return null;
    const header = parseJsonObjectText(first);
    if (!header || header.schema !== 1 || header.session_id !== session || typeof header.ts !== "string") return null;
    const startedAt = Date.parse(header.ts);
    if (!Number.isFinite(startedAt) || startedAt > until) return null;
    const rows: TouchedFileRecord[] = [];
    for (const line of entries) {
        const row = parseJsonObjectText(line);
        if (!isTouchedRecord(row, session)) return null;
        const timestamp = Date.parse(row.ts);
        if (!Number.isFinite(timestamp)) return null;
        if (timestamp <= until) rows.push(row);
    }
    return { available: true, complete: header.started === true, rows };
}

export function readTouchedLedger(root: string, session: string, until = Number.POSITIVE_INFINITY): TouchedLedger {
    const unavailable: TouchedLedger = { available: false, complete: false, rows: [] };
    if (!Number.isFinite(until) && until !== Number.POSITIVE_INFINITY) return unavailable;
    const path = touchedLedgerPath(root, session);
    try {
        if (existsSync(path + ".overflow")) return unavailable;
        const text = readBoundedTextFile(path, TOUCHED_LEDGER_MAX_BYTES);
        return text === null ? unavailable : parseTouchedLedger(text, session, until) ?? unavailable;
    } catch {
        return unavailable;
    }
}
