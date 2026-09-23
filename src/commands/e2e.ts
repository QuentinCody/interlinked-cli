import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getOutputMode, outputError } from "../lib/output.js";

interface ScaffoldOptions { cwd?: string; event?: string; tool?: string; dryRun?: boolean; json?: boolean }

function scaffoldContent(name: string, event: string, tool: string): string {
    const input = tool === "Bash" ? '{ command: "pwd" }' : '{ file_path: "README.md" }';
    return `import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

describe(${JSON.stringify(`${name} — MUST-FIRE`)}, () => {
    let fixture: E2eFixture;
    beforeAll(async () => { fixture = await createFixture(); });
    afterAll(async () => { await fixture?.close(); });
    it("asserts the public boundary contract", async () => {
        const result = await fixture.hook({ event: ${JSON.stringify(event)}, tool: ${JSON.stringify(tool)}, input: ${input} });
        fixture.assertServed(result);
        const rows = fixture.ledger("activity.jsonl");
        expect(rows).toBeInstanceOf(Array);
        expect.fail("Replace this failure with a behavior assertion grounded in the requirement; add MUST-NOT-FIRE cases.");
    });
});
`;
}

export function scaffoldE2e(name: string, options: ScaffoldOptions): { path: string; content: string } {
    assert(/^[a-z][a-z0-9-]*$/.test(name), "Scaffold name must be lowercase kebab-case");
    const event = options.event ?? "PreToolUse";
    assert(["PreToolUse", "PostToolUse", "Stop"].includes(event), "Unsupported scaffold event");
    const path = resolve(options.cwd ?? process.cwd(), "src/e2e", `${name}.e2e.test.ts`);
    const content = scaffoldContent(name, event, options.tool ?? "Edit");
    if (!options.dryRun) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, { flag: "wx" });
    }
    return { path, content };
}

export function e2eScaffoldCommand(name: string, options: ScaffoldOptions): void {
    try {
        const result = scaffoldE2e(name, options);
        process.stdout.write(options.dryRun ? result.content : `Created ${result.path}. Replace the failing assertion before running npm run test:e2e.\n`);
    } catch (error) {
        outputError(getOutputMode(options), error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
