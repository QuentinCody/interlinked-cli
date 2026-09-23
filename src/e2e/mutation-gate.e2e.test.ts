import { afterEach, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

describe("mutation gate availability at the daemon boundary", () => {
    let fixture: E2eFixture | undefined;
    afterEach(async () => { await fixture?.close(); });
    it.each(["allow_unmeasured", "block"] as const)("honors unavailable_behavior=%s without inventing a measured result", async (unavailable_behavior) => {
        fixture = await createFixture({ rules: { per_edit_coverage: { enabled: false }, per_edit_mutation: { enabled: true, mode: "block", unavailable_behavior } } });
        const file_path = fixture.file("src/value.ts", "export const value = 1;\n");
        fixture.file("src/value.test.ts", 'import { value } from "./value.js";\n');
        const result = await fixture.hook({ tool: "Edit", input: { file_path, old_string: "value = 1", new_string: "value = 2" } });
        fixture.assertServed(result);
        expect((result.stdout + result.stderr)).toMatch(/mutation.*(?:not.measured|could not be measured)/i);
        expect(result.stdout.includes('"deny"')).toBe(unavailable_behavior === "block");
        expect(fixture.ledger("mutation-receipts.jsonl")).toEqual([]);
    });
});
