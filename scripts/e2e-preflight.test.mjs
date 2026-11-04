import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("esbuild", () => ({ build: mocked.build }));
import { preflightE2e } from "./e2e-preflight.mjs";

describe("script-side E2E preflight loader", () => {
    it("loads the source preflight without producing a generated artifact", async () => {
        mocked.build.mockResolvedValueOnce({ outputFiles: [{ text: "export async function preflightE2eRun(root, options) { return { root, options, measured: false }; }" }] });
        await expect(preflightE2e("/project", { requireBaseline: true })).resolves.toEqual({ root: "/project", options: { requireBaseline: true }, measured: false });
        expect(mocked.build).toHaveBeenCalledWith(expect.objectContaining({ absWorkingDir: "/project", entryPoints: ["src/harness/e2e-preflight.ts"], write: false }));
    });
});
