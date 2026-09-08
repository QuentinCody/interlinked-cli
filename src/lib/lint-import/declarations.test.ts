import { describe, expect, it } from "vitest";
import { lintRuleDeclarations } from "./declarations.js";

describe("static lint declarations", () => {
    it("records rule levels and selectors without mistaking dependency versions for rule levels", () => {
        const source = ['"version": "0.1.0",', '"eslint": "10.9.1",', '"no-eval": ["error", {}],', 'unwrap_used = "deny"', 'select = ["E", "F"]'].join("\n");
        expect(lintRuleDeclarations(source)).toEqual([
            { id: "no-eval", value: '["error", {}],', line: 3, interpretation: "declaration" },
            { id: "unwrap_used", value: '"deny"', line: 4, interpretation: "declaration" },
            { id: "select", value: '["E", "F"]', line: 5, interpretation: "selector" },
        ]);
    });
});
