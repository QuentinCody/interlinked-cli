import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readObservationWindow } from "./check-observation-window.js";
it("bounds bytes and records, drops partial and oversized lines, and reports the omitted prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "observation-window-"));
    const path = join(root, "log.jsonl");
    try {
        writeFileSync(path, "x".repeat(4096) + "\n");
        appendFileSync(path, '1\n2\n3\n4\n{"torn":');
        const window = readObservationWindow(path, { bytes: 1024, records: 2, lineBytes: 128 });
        expect(window.lines).toEqual(["3", "4"]);
        expect(window.scanned_bytes).toBeLessThanOrEqual(1024);
        expect(window.omitted_prefix).toBe(true);
        expect(window.incomplete_lines).toBe(1);
        expect(window.omitted_records).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
it("returns an explicit empty window for an absent log", () => {
    const root = mkdtempSync(join(tmpdir(), "observation-missing-"));
    try { expect(readObservationWindow(join(root, "missing")).lines).toEqual([]); }
    finally { rmSync(root, { recursive: true, force: true }); }
});
