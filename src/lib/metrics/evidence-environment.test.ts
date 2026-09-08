import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureEvidenceEnvironment } from "./evidence-environment.js";
import { runEvidenceProcess } from "./evidence-process.js";

afterEach(() => vi.unstubAllEnvs());

it("canonicalizes the child environment without merging absent and empty values", () => {
    const first = captureEvidenceEnvironment({ B: "second", A: "first", OMITTED: undefined });
    const reordered = captureEvidenceEnvironment({ A: "first", B: "second" });
    expect(first).toEqual(reordered);
    expect(first.environment).toEqual({ A: "first", B: "second" });
    expect(captureEvidenceEnvironment({ A: "first", B: "second", OMITTED: "" }).environmentHash).not.toBe(first.environmentHash);
});

it("takes a snapshot instead of retaining a mutable environment reference", () => {
    const inherited = { FEATURE_MODE: "before" }, captured = captureEvidenceEnvironment(inherited);
    inherited.FEATURE_MODE = "after";
    expect(captured.environment).toEqual({ FEATURE_MODE: "before" });
    expect(captureEvidenceEnvironment(inherited).environmentHash).not.toBe(captured.environmentHash);
});

it("prevents Node from injecting a coverage variable set after the snapshot", async () => {
    vi.stubEnv("NODE_V8_COVERAGE", undefined);
    const captured = captureEvidenceEnvironment();
    const root = mkdtempSync(join(tmpdir(), "metrics-environment-propagation-"));
    try {
        vi.stubEnv("NODE_V8_COVERAGE", root);
        const result = await runEvidenceProcess({ cwd: root, environment: captured.environment,
            argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify({coverage: process.env.NODE_V8_COVERAGE ?? null}))"], timeoutMs: 5000 });
        expect(result.outcome).toBe("passed");
        expect(JSON.parse(result.output)).toEqual({ coverage: null });
        expect(captured.environment.NODE_V8_COVERAGE).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
});
