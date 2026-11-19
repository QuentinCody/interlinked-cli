import { expect, it } from "vitest";
import { isWriteCapableToolName } from "./write-tool-registry.js";

// test-contract: invariant — an MCP tool whose last name segment carries the "save" verb writes files, so the write gates must treat it as write-capable; missing it lets an unknown runner's save tool skip every write gate
it("classifies an MCP save tool as write-capable", () => {
	expect(isWriteCapableToolName("mcp__notes__save_note")).toBe(true);
	expect(isWriteCapableToolName("saveDocument")).toBe(true);
});
