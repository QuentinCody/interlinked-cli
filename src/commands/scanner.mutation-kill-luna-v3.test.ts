import { parseWire, wireBoolean, wireObject, wireRecord, wireUnknown } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheKey, readDecision, writeReview } from "../harness/content-scanner/review-files.js";
import type { ScanFinding } from "../harness/content-scanner/types.js";
import { scannerOnCommand, scannerReviewCommand, scannerStatusCommand, scannerToggleCommand } from "./scanner.js";

let cwd: string;
let previousHome: string | undefined;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "scanner-mutation-"));
    previousHome = process.env.INTERLINKED_HOME;
    process.env.INTERLINKED_HOME = cwd;
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    if (previousHome === undefined) delete process.env.INTERLINKED_HOME;
    else process.env.INTERLINKED_HOME = previousHome;
    process.exitCode = 0;
    rmSync(cwd, { recursive: true, force: true });
});

function file(name: string): string {
    return join(cwd, name);
}

function output(): Record<string, unknown> {
    const text = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    return parseWire(JSON.parse(text), wireRecord(wireUnknown), "test JSON value");
}

function seedReview(url = "https://example.com/data"): string {
    const key = cacheKey(url, "");
    const finding: ScanFinding = {
        label: "private_email",
        start: 0,
        end: 17,
        text: "alice@example.com",
        source: "WebFetch.response",
    };
    writeReview({
        cwd,
        key,
        url,
        prompt: "",
        toolName: "WebFetch",
        body: "alice@example.com",
        redactedBody: "<PRIVATE_EMAIL>",
        findings: [finding],
    });
    return key;
}

describe("scanner mutation contracts", () => {
    // test-contract: an enabled scanner remains enabled and reports its prior state on an idempotent enable.
    it("distinguishes unchanged enable from first enable", async () => {
        await scannerOnCommand({ json: true });
        logSpy.mockClear();
        await scannerOnCommand({ json: true });
        expect(output()).toMatchObject({ enabled: true, changed: false, previous: true });
        const rows = readFileSync(file("content-scanner.audit.jsonl"), "utf-8").trim().split("\n");
        expect(JSON.parse(nonNull(rows.at(-1)))).toMatchObject({ action: "no_change", from: true, to: true });
    });

    // test-contract: toggling an enabled scanner disables it and reports that the state changed.
    it("reports changed toggle and persists false", async () => {
        await scannerOnCommand({ json: true });
        logSpy.mockClear();
        await scannerToggleCommand({ json: true });
        expect(output()).toMatchObject({ enabled: false, changed: true, previous: true });
        const rules = parseWire(JSON.parse(readFileSync(file("guard-rules.local.json"), "utf-8")), wireObject({ "content_scanner": wireObject({ "enabled": wireBoolean }) }), "test JSON value");
        expect(rules.content_scanner.enabled).toBe(false);
    });

    // test-contract: an explicit reason is preserved, while an omitted reason is represented as null.
    it("uses exact reason nullish semantics", async () => {
        await scannerOnCommand({ reason: "because", json: true });
        expect(output().reason).toBe("because");
        logSpy.mockClear();
        await scannerToggleCommand({ json: true });
        expect(output().reason).toBe(null);
    });

    // test-contract: the toggle response includes the documented hot-reload note.
    it("includes the hot-reload note", async () => {
        await scannerOnCommand({ json: true });
        expect(output().note).toContain("Harness hot-reloads guard-rules.local.json");
    });

    // test-contract: invalid scanner blocks are replaced by a plain configuration object.
    it("normalizes null and array scanner blocks", async () => {
        writeFileSync(file("guard-rules.local.json"), JSON.stringify({ content_scanner: null }));
        await scannerOnCommand({ json: true });
        expect(JSON.parse(readFileSync(file("guard-rules.local.json"), "utf-8"))).toMatchObject({ content_scanner: { enabled: true } });
        writeFileSync(file("guard-rules.local.json"), JSON.stringify({ content_scanner: [] }));
        await scannerOnCommand({ json: true });
        expect(JSON.parse(readFileSync(file("guard-rules.local.json"), "utf-8"))).toMatchObject({ content_scanner: { enabled: true } });
    });

    // test-contract: absent configuration, audit, and runtime files produce safe status defaults without throwing.
    it("reports safe defaults when status files are absent", async () => {
        await scannerStatusCommand({ json: true });
        expect(output()).toMatchObject({ enabled: false, runtime_status: null, last_audit: [] });
    });

    // test-contract: a present status file is trimmed and exposed exactly.
    it("reads and trims the runtime status", async () => {
        writeFileSync(file("content-scanner.status"), "  ready  \n");
        await scannerStatusCommand({ json: true });
        expect(output().runtime_status).toBe("ready");
    });

    // test-contract: only schema-valid audit rows are included in status output.
    it("rejects malformed audit values and non-objects", async () => {
        const actor = { user: "u", host: "h", tty: null, via: "cli" };
        const valid = { ts: "2026-01-01", action: "enable", actor, reason: null };
        const invalid = [
            null,
            ["row"],
            { ...valid, action: 1 },
            { ...valid, actor: { ...actor, tty: 4 } },
            { ...valid, from: "yes" },
            { ...valid, to: "yes" },
            { ...valid, reason: 4 },
        ];
        const rows = [...invalid, valid];
        writeFileSync(file("content-scanner.audit.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
        await scannerStatusCommand({ json: true });
        expect(output().last_audit).toEqual([valid]);
    });

    // test-contract: a missing review key is reported as an error and cannot create a decision.
    it("rejects a nonmatching review key", async () => {
        seedReview();
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await scannerReviewCommand({ key: "missing-key", allow: true });
        expect(errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n")).toContain("no pending review with key");
        expect(readDecision(cwd, "missing-key")).toBeUndefined();
        errorSpy.mockRestore();
    });

    // test-contract: JSON review output is structured and includes the selected decision and key.
    it("returns a complete JSON decision payload", async () => {
        const key = seedReview();
        await scannerReviewCommand({ allow: true, json: true, reason: "reviewed" });
        expect(output()).toMatchObject({ pending: 1, cache_key: key, decision: "allow", finding_count: 1, action: "review_allow" });
        expect(readDecision(cwd, key)?.decision).toBe("allow");
    });

    // test-contract: normal review output includes the instruction needed to apply a recorded decision.
    it("includes the re-invocation instruction", async () => {
        seedReview();
        await scannerReviewCommand({ allow: true });
        const rendered = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
        expect(rendered).toContain("Re-invoke the WebFetch in your agent session to apply.");
    });
});
