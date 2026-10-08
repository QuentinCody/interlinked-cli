import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { decisionHookAdvice, captureDecisionPreimages } from "./hook.js";
import { parseConfig } from "./config.js";
import { digest } from "./store.js";
import { measureWithBackend } from "./pipeline.js";
import type { WorkspaceFileEffect } from "../../harness/workspace-effects.js";

it("does not invoke a model when disabled or substitute HEAD for a missing pre-edit baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "decision-hook-"));
    const measure = vi.fn();
    try {
        expect(await decisionHookAdvice(root, [], { measure })).toEqual([]);
        mkdirSync(join(root, ".interlinked"));
        writeFileSync(
            join(root, ".interlinked/decision-metrics.json"),
            JSON.stringify(parseConfig({ version: 1, enabled: true, hook: { enabled: true } })),
        );
        const source = "function honest() { return 1; }\n";
        writeFileSync(join(root, "a.ts"), source);
        const effect: WorkspaceFileEffect = {
            path: "a.ts",
            kind: "modified",
            before_sha256: digest("unknown"),
            after_sha256: digest(source),
        };
        const warnings = await decisionHookAdvice(root, [effect], { measure });
        expect(warnings.join(" ")).toContain("exact pre-edit source unavailable");
        expect(measure).not.toHaveBeenCalled();
        expect(captureDecisionPreimages(root, [effect], () => "wrong").size).toBe(0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("compares exact before/after evidence, preserves legacy debt, and warns without blocking", async () => {
    const root = mkdtempSync(join(tmpdir(), "decision-hook-"));
    try {
        mkdirSync(join(root, ".interlinked"));
        writeFileSync(
            join(root, ".interlinked/decision-metrics.json"),
            JSON.stringify(
                parseConfig({
                    version: 1,
                    enabled: true,
                    hook: { enabled: true, deadlineMs: 10000 },
                }),
            ),
        );
        const before = "function add(a: number) { return a + 1; }\n",
            after = "function add(a: number) { return a - 1; }\n";
        writeFileSync(join(root, "a.ts"), after);
        const effect: WorkspaceFileEffect = {
            path: "a.ts",
            kind: "modified",
            before_sha256: digest(before),
            after_sha256: digest(after),
        };
        const preimages = captureDecisionPreimages(root, [effect], () => before);
        const measure: NonNullable<Parameters<typeof decisionHookAdvice>[2]>["measure"] = (
            cwd,
            records,
            config,
            options,
        ) =>
            measureWithBackend(cwd, records, config, {
                ...options,
                identity: "pinned",
                backend: async (record) => [
                    {
                        metric: "name_matches",
                        raw: {
                            kind: "yes_no",
                            probability: record.id.startsWith("before:") ? 0.99 : 0.01,
                        },
                        servedModel: "pinned",
                        adapterVersion: "fixture",
                        requestHash: null,
                    },
                ],
            });
        const warnings = await decisionHookAdvice(root, [effect], { preimages, measure });
        expect(warnings.join(" ")).toContain("adverse judgment increased");
        expect(warnings.every((warning) => warning.includes("Advisory"))).toBe(true);
        expect(await decisionHookAdvice(root, [effect], { dryRun: true, measure })).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
