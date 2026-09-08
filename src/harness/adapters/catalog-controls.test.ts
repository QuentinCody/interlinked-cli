import { describe, expect, it } from "vitest";
import { catalogControls } from "./catalog-controls.js";

describe("independent declared controls", () => {
    it("distinguishes an observer from an unknown contract", () => {
        expect(catalogControls(".claude/settings.json", "FileChanged")).toEqual([]);
        expect(catalogControls(".claude/settings.json", "future-event")).toBeUndefined();
    });
    it("resolves aliases for actual Cursor and OpenCode profile IDs", () => {
        expect(catalogControls(".cursor/hooks.json", "beforeShellExecution")).toContain("deny");
        expect(catalogControls(".opencode/plugins/interlinked.ts", "tool.execute.before")).toContain("rewrite_input");
    });
});
