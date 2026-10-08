import { describe, expect, it, vi } from "vitest";
const { runProcessAsync } = vi.hoisted(() => ({ runProcessAsync: vi.fn() }));
vi.mock("../spawn-async.js", () => ({ runProcessAsync }));
import { runAsyncTool } from "../index-runtime.js";

describe("file process verdict at the check-engine boundary", () => {
    it.each(["shellcheck", "taplo"] as const)("keeps failed %s execution out of completed tool evidence", async id => {
        runProcessAsync.mockResolvedValue({ code: null, stdout: "", stderr: "spawn failed", timedOut: false, killed: false });
        const run = await runAsyncTool({ id, available: true }, { mode: "file", targetFile: `/repo/input.${id === "taplo" ? "toml" : "sh"}`, projectRoot: "/repo" }, 1000);
        expect(run.results).toEqual([]);
        expect(run.skipped).toEqual({ check: id, category: "error", reason: expect.stringContaining("no check verdict") });
    });
});
