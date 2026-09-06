import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    loadManualDebtMarkerSnapshotReceipts,
    manualDebtMarkerSnapshotsPath,
} from "../lib/manual-debt-marker-record.js";
import { debtMarkersCommand } from "./debt-markers.js";

let root = "";
let output: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "debt-markers-command-"));
    mkdirSync(join(root, "src"), { recursive: true });
    output = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
        output.push(String(value));
    });
});

afterEach(() => {
    logSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
});

describe("interlinked debt markers", () => {
    it("emits a structured read-only JSON report", async () => {
        writeFileSync(
            join(root, "src", "cache.ts"),
            '// interlinked-debt: {"decision":"one cache","ceiling":"10k keys","trigger":"keys >= 10000 items"}\n',
        );
        await debtMarkersCommand({ cwd: root, json: true });
        const parsed: unknown = JSON.parse(output.join("\n"));
        expect(parsed).toMatchObject({
            schema_version: 1,
            source: "source-comments",
            repository: { root },
            obligation_ledger: { consulted: false, mutated: false },
            read_only: true,
        });
        expect(existsSync(manualDebtMarkerSnapshotsPath(root))).toBe(false);
    });

    it("qualifies an empty result by its covered scope", async () => {
        await debtMarkersCommand({ cwd: root });
        const rendered = output.join("\n");
        expect(rendered).toContain("No markers found in the covered source scope");
        expect(rendered).toContain("Obligation ledger: not consulted; not modified");
    });

    it("records only when explicitly requested while preserving canonical JSON stdout", async () => {
        writeFileSync(
            join(root, "src", "cache.ts"),
            '// interlinked-debt: {"id":"cache","decision":"one cache","ceiling":"10k keys","trigger":"keys >= 10000 items"}\n',
        );
        await debtMarkersCommand({ cwd: root, json: true, record: true, reason: "baseline" });
        const parsed: unknown = JSON.parse(output.join("\n"));
        expect(parsed).toMatchObject({ source: "source-comments", read_only: true });
        const receipts = loadManualDebtMarkerSnapshotReceipts(root);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ reason: "baseline" });
        expect(receipts[0]?.transitions).toHaveLength(1);
    });

    it("rejects --reason without --record", async () => {
        await expect(debtMarkersCommand({ cwd: root, reason: "orphan reason" })).rejects.toThrow(
            "--reason requires --record",
        );
        expect(existsSync(manualDebtMarkerSnapshotsPath(root))).toBe(false);
    });

    it("renders full marker detail, an advisory row, and a recorded snapshot line", async () => {
        writeFileSync(
            join(root, "src", "cache.ts"),
            '// interlinked-debt: {"id":"cache-1","decision":"one cache","ceiling":"10k keys",'
                + '"trigger":"keys >= 10000 items","owner":"team-owalt","issue":"ISSUE-42",'
                + '"review":"quarterly","review_after":"2020-01-01"}\n',
        );
        await debtMarkersCommand({ cwd: root, full: true, record: true, reason: "campaign" });
        const rendered = output.join("\n");

        // Summary line counts the one valid marker and its stale-review advisory.
        expect(rendered).toContain("Manual debt markers: 1 valid, 1 advisory");

        // markerLine: explicit id suffix, file:line, and decision text.
        expect(rendered).toMatch(
            /^ {2}debt-[0-9a-f]{20} id=cache-1 {2}src\/cache\.ts:1 {2}one cache$/m,
        );

        // The lifecycle advisory row for the past review_after date.
        expect(rendered).toMatch(
            /\[advisory:stale-review\] src\/cache\.ts:1 — review_after 2020-01-01 is before \d{4}-\d{2}-\d{2}/,
        );

        // Repository line always renders, git-backed or not.
        expect(rendered).toMatch(/Repository: head (unavailable|[0-9a-f]{40}); tree (unavailable|[0-9a-f]{40})/);

        // recordingLines: the recorded-snapshot summary for a first-ever record (all opened).
        expect(rendered).toMatch(
            /Recorded snapshot [0-9a-f]{12} — 1 opened, 0 changed, 0 closed → /,
        );
        expect(rendered).toContain(manualDebtMarkerSnapshotsPath(root));

        // markerDetailLines: every populated optional field renders its own labeled line.
        expect(rendered).toContain("  decision: one cache");
        expect(rendered).toContain("  ceiling:  10k keys");
        expect(rendered).toContain("  trigger:  keys >= 10000 items");
        expect(rendered).toContain("  id:       cache-1");
        expect(rendered).toContain("  owner:    team-owalt");
        expect(rendered).toContain("  issue:    ISSUE-42");
        expect(rendered).toContain("  review:   quarterly");
        expect(rendered).toContain("  review-after: 2020-01-01");

        // renderFull's own trailing line: the skipped-by-reason breakdown.
        expect(rendered).toContain(
            '  Skipped by reason: {"binary":0,"excluded":0,"outside_project":0,"symlink":0,"too_large":0,"unreadable":0,"unsupported":0}'.trim(),
        );
    });

    it("renders the short summary with a recorded-snapshot suffix", async () => {
        writeFileSync(
            join(root, "src", "cache.ts"),
            '// interlinked-debt: {"decision":"one cache","ceiling":"10k keys","trigger":"keys >= 10000 items"}\n',
        );
        await debtMarkersCommand({ cwd: root, short: true, record: true, reason: "baseline" });
        const rendered = output.join("\n");
        expect(rendered).toBe(
            "1 manual debt marker(s), 0 advisory; 1 file(s) scanned; 1 opened, 0 changed, 0 closed recorded",
        );
    });
});
