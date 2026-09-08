import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BiomeOverlayOutcome } from "../check-engine/tool-runners/biome.js";
import type { CheckResult } from "../check-engine/types.js";

const engine = vi.hoisted(() => ({
    getBiomeDiagnosticsForOverlayTyped: vi.fn<() => BiomeOverlayOutcome>(),
    getTscDiagnosticsForOverlayTyped: vi.fn(() => ({ status: "ok", findings: [] })),
}));
vi.mock("../check-engine/index.js", () => ({ getOrCreateEngine: () => engine }));

import { gateProposedContent } from "../content-gate.js";
import { evaluateBiomeDiffOverlay } from "../diff-overlay.js";

let root: string;
let file: string;
const before = "export const value = 1;\n";
const after = "export const value = 2;\n";

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "interlinked-biome-contract-"));
    file = join(root, "value.js");
    writeFileSync(file, before);
    engine.getBiomeDiagnosticsForOverlayTyped.mockReset();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function diagnostic(line: number): CheckResult {
    return { tool: "biome", file: "value.js", ruleId: "lint/suspicious/noDoubleEquals", line, severity: "warning", message: "Use strict equality" };
}

describe("Biome gate evidence", () => {
    it("rejects a transaction when its baseline cannot be measured", () => {
        engine.getBiomeDiagnosticsForOverlayTyped.mockReturnValue({ status: "unavailable", reason: "timeout" });
        const result = gateProposedContent([{ path: file, content: after }], { projectRoot: root });
        expect(result.ok).toBe(false);
        expect(result.failures).toContainEqual(expect.objectContaining({ code: "biome-overlay-unavailable", severity: "error" }));
        expect(readFileSync(file, "utf-8")).toBe(before);
        expect(engine.getBiomeDiagnosticsForOverlayTyped).toHaveBeenCalledTimes(1);
    });

    it("does not turn a clean baseline followed by an unavailable proposal into a pass", () => {
        engine.getBiomeDiagnosticsForOverlayTyped
            .mockReturnValueOnce({ status: "ok", findings: [] })
            .mockReturnValueOnce({ status: "unavailable", reason: "signal" });
        expect(evaluateBiomeDiffOverlay(file, after, root)).toMatchObject({ checkerUnavailable: "signal", proposedFindings: null });
    });

    it("reports an additional occurrence of a rule even when one already existed", () => {
        engine.getBiomeDiagnosticsForOverlayTyped
            .mockReturnValueOnce({ status: "ok", findings: [diagnostic(1)] })
            .mockReturnValueOnce({ status: "ok", findings: [diagnostic(5), diagnostic(9)] });
        const result = evaluateBiomeDiffOverlay(file, after, root);
        expect(result.newFindings).toEqual([diagnostic(9)]);
        expect(result.proposedFindings).toEqual([diagnostic(5), diagnostic(9)]);
    });

    it("permits existing debt to move without declaring it newly introduced", () => {
        engine.getBiomeDiagnosticsForOverlayTyped
            .mockReturnValueOnce({ status: "ok", findings: [diagnostic(1)] })
            .mockReturnValueOnce({ status: "ok", findings: [diagnostic(5)] });
        expect(evaluateBiomeDiffOverlay(file, after, root)).toMatchObject({ newFindings: [], proposedFindings: [diagnostic(5)] });
        expect(engine.getBiomeDiagnosticsForOverlayTyped).toHaveBeenNthCalledWith(1, file, before, expect.any(Number));
        expect(engine.getBiomeDiagnosticsForOverlayTyped).toHaveBeenNthCalledWith(2, file, after, expect.any(Number));
    });

    it("leaves unconfigured projects explicitly unmeasured", () => {
        engine.getBiomeDiagnosticsForOverlayTyped.mockReturnValue({ status: "skipped", reason: "no config" });
        expect(evaluateBiomeDiffOverlay(file, after, root)).toMatchObject({ newFindings: [], proposedFindings: null });
    });

    it("checks new files against an empty baseline", () => {
        engine.getBiomeDiagnosticsForOverlayTyped.mockReturnValue({ status: "ok", findings: [diagnostic(1)] });
        expect(evaluateBiomeDiffOverlay(join(root, "new.js"), after, root).newFindings).toEqual([diagnostic(1)]);
        expect(engine.getBiomeDiagnosticsForOverlayTyped).toHaveBeenCalledTimes(1);
    });
});
