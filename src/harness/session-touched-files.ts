import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDirectFileEditTool } from "../lib/write-tool-registry.js";
import { detectBashCodeFileWrite, resolveBashWriteTarget } from "./pre-checks-bash-write-detect.js";
import { extractAllEditedFilePaths } from "./server-tool-helpers.js";
import type { HarnessEvent } from "./types.js";

export const TOUCHED_LEDGER_MAX_BYTES = 1024 * 1024;
export interface TouchedFileRecord { session_id: string; tool_use_id: string; path: string; bytes: number; ts: string; }
export interface TouchedLedger { available: boolean; complete: boolean; rows: TouchedFileRecord[]; }

export function touchedLedgerPath(root: string, session: string): string {
    return join(root, ".interlinked", "touched-files", `${createHash("sha256").update(session).digest("hex")}.jsonl`);
}

/** Declared targets only: a concurrent writer's workspace diff is not authorship. */
export function touchedTargets(event: HarnessEvent, root: string): string[] {
    if (event.dry_run || event.tool_outcome === "error" || !["PostToolUse", "AfterTool"].includes(event.hook_event)) return [];
    let paths: string[] = [];
    if (isDirectFileEditTool(event.tool_name)) {
        const declared = { ...event };
        delete declared.change_set;
        paths = extractAllEditedFilePaths(declared);
        if (event.tool_name === "apply_patch") {
            const input = event.tool_input;
            const patch = input?.patch ?? input?.command ?? input?.content ?? input?._raw_patch;
            if (typeof patch === "string") {
                // A rename touches the old name too; quality checks normally
                // select only its destination, but the summary ledger records both.
                for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm)) paths.push(match[1]!.trim());
            }
        }
    }
    else if (["Bash", "Shell", "shell", "run_command", "exec_command"].includes(event.tool_name ?? "")) {
        const cmd = typeof event.tool_input?.command === "string" ? event.tool_input.command : "";
        const found = detectBashCodeFileWrite(cmd);
        const target = found && resolveBashWriteTarget(cmd, found.target, root);
        if (target) paths = [target];
    }
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

export function readTouchedLedger(root: string, session: string, until = Number.POSITIVE_INFINITY): TouchedLedger {
    const result: TouchedLedger = { available: false, complete: false, rows: [] };
    let fd: number | undefined;
    try {
        if (!Number.isFinite(until) && until !== Number.POSITIVE_INFINITY) return result;
        const path = touchedLedgerPath(root, session);
        if (statSync(path).size > TOUCHED_LEDGER_MAX_BYTES || existsSync(`${path}.overflow`)) return result;
        fd = openSync(path, "r");
        const buffer = Buffer.alloc(TOUCHED_LEDGER_MAX_BYTES + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
            const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
            if (!count) break;
            bytes += count;
        }
        if (bytes > TOUCHED_LEDGER_MAX_BYTES) return result;
        const lines = buffer.subarray(0, bytes).toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
        const header = lines.shift();
        if (header?.schema !== 1 || header.session_id !== session || typeof header.ts !== "string"
            || !Number.isFinite(Date.parse(header.ts)) || Date.parse(header.ts) > until) return result;
        for (const row of lines) {
            if (row.session_id !== session || typeof row.path !== "string" || typeof row.tool_use_id !== "string"
                || typeof row.bytes !== "number" || typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts))) return { ...result, rows: [] };
            if (Date.parse(row.ts) <= until) result.rows.push(row as unknown as TouchedFileRecord);
        }
        result.available = true; result.complete = header.started === true;
    } catch (error) { void error; }
    finally { if (fd !== undefined) closeSync(fd); }
    return result;
}
