import { parseWire, wireArray, wireObject, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
import { mkdirSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanCommand } from "./clean.js";

let root: string;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    root = join(tmpdir(), `clean-${Date.now()}-${Math.random()}`);
    mkdirSync(root, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(root);
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
});

function result(): Record<string, unknown> {
    return parseWire(JSON.parse(String(log.mock.calls[0]?.[0])), wireRecord(wireUnknown), "test JSON value");
}

function oldFile(path: string): void {
    writeFileSync(path, "x");
    const date = new Date(1_000_000);
    utimesSync(path, date, date);
}

function truncateFile(path: string, megabytes: number): void {
    truncateSync(path, megabytes * 1024 * 1024);
}

describe("clean", () => {
    // test-contract: a stale boundary file is reported with day-formatted age rather than an hour-formatted age.
    it("formats a 24-hour-old stale file as one day", async () => {
        const dir = join(root, ".interlinked", "hooks", "agent-sessions");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "boundary");
        oldFile(file);
        vi.spyOn(Date, "now").mockReturnValue(1_000_000 + 24 * 3600000 + 1);
        await cleanCommand({ json: true });
        const items = parseWire(result().stale_items, wireArray(wireObject({ "detail": wireString })), "test JSON value");
        expect(items).toHaveLength(1);
        expect(items[0]?.detail).toBe("Last modified 1d ago");
    });

    // test-contract: a missing activity log is clean and produces no synthetic truncation result.
    it("treats a missing activity log as absent", async () => {
        await cleanCommand({ json: true });
        expect(result().stale_items).toEqual([]);
        expect(result().removed).toEqual([]);
    });

    // test-contract: normal output renders each populated category and does not invent empty-group content.
    it("renders all stale groups and orphan guidance", async () => {
        const base = join(root, ".interlinked");
        const hooks = join(base, "hooks", "agent-sessions");
        const sessions = join(base, "sessions");
        mkdirSync(hooks, { recursive: true });
        mkdirSync(sessions, { recursive: true });
        oldFile(join(hooks, "hook"));
        oldFile(join(sessions, "local.json"));
        const activity = join(base, "activity.jsonl");
        writeFileSync(activity, "log");
        truncateFile(activity, 51);
        mkdirSync(join(root, ".claude"), { recursive: true });
        writeFileSync(join(root, ".claude", "settings.json"), "node /missing/interlinked-activity.mjs");
        await cleanCommand({});
        const rendered = String(log.mock.calls[0]?.[0]);
        expect(rendered).toContain("Large activity log");
        expect(rendered).toContain("Stale hook session files");
        expect(rendered).toContain("Stale local sessions");
        expect(rendered).toContain("Orphaned hook entries");
        expect(rendered).toContain("Found 4 item(s)");
        expect(rendered).not.toContain("Stryker");
        log.mockClear();
        await cleanCommand({ force: true });
        expect(String(log.mock.calls[0]?.[0])).toContain("1 orphaned hook(s) found");
    });

    // test-contract: force truncation keeps final activity lines and resets the sync cursor, while dry-run does not write.
    it("truncates only when forced", async () => {
        const base = join(root, ".interlinked");
        mkdirSync(base, { recursive: true });
        const activity = join(base, "activity.jsonl");
        const sync = join(base, "sync-state.json");
        writeFileSync(activity, Array.from({ length: 10001 }, (_, i) => `line-${i}`).join("\n"));
        truncateFile(activity, 51);
        writeFileSync(sync, "old");
        await cleanCommand({});
        expect(readFileSync(sync, "utf8")).toBe("old");
        log.mockClear();
        await cleanCommand({ force: true, json: true });
        const data = result();
        expect(data.total_found).toBe(1);
        expect(readFileSync(sync, "utf8")).toContain('"synced_through_bytes":0');
        expect(readFileSync(activity, "utf8")).toContain("line-10000");
        expect(readFileSync(activity, "utf8")).not.toContain("line-0");
    });

    // test-contract: each configured client path and client name is observable when its hook script is missing.
    it("detects orphaned hooks for Gemini and Codex settings", async () => {
        for (const [dir, file, name] of [[".gemini", "settings.json", "Gemini CLI"], [".codex", "config.toml", "Codex CLI"]] as const) {
            mkdirSync(join(root, dir), { recursive: true });
            writeFileSync(join(root, dir, file), "node /gone/interlinked-activity.mjs");
            await cleanCommand({ json: true });
            const items = parseWire(result().stale_items, wireArray(wireObject({ "detail": wireString })), "test JSON value");
            expect(items.some((item) => item.detail.startsWith(`${name}: Hook references missing script`))).toBe(true);
            log.mockClear();
        }
    });

    // test-contract: hook detection requires the marker, hook filename, and node-path regex.
    it("ignores incomplete hook settings", async () => {
        mkdirSync(join(root, ".claude"), { recursive: true });
        writeFileSync(join(root, ".claude", "settings.json"), "node /gone/other.mjs");
        await cleanCommand({ json: true });
        expect(result().stale_items).toEqual([]);
        log.mockClear();
        writeFileSync(join(root, ".claude", "settings.json"), "interlinked-activity.mjs");
        await cleanCommand({ json: true });
        expect(result().stale_items).toEqual([]);
    });
});
