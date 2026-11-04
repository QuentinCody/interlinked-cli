import { expect, it, vi } from "vitest";
vi.mock("./check-typescript.js", () => ({ loadCheckTypescript: () => null }));
import { analyzeHelperOverlap } from "./helper-overlap.js";
it("MUST-NOT-FIRE: missing optional compiler produces no partial claim", () => {
    expect(analyzeHelperOverlap("function a(){one();two();three();four();five();}", "/repo/a.ts").windows).toEqual([]);
});
