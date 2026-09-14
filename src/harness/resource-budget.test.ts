import { afterEach, expect, it, vi } from "vitest";
import { readResourceBudget } from "./resource-budget.js";
import { readResourceMemory } from "./resource-memory.js";

vi.mock("./resource-memory.js", () => ({ readResourceMemory: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const GIB = 1024 ** 3;

it("caps a 48 GiB host at 4 GiB while preserving 6 GiB for other workloads", () => {
    vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 48 * GIB, availableBytes: 32 * GIB });
    expect(readResourceBudget()).toEqual({ reserveBytes: 6 * GIB, maxRssBytes: 4 * GIB });
});
it("does not start a heavy runner alongside a model that leaves only 7 GiB available", () => {
    vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 48 * GIB, availableBytes: 7 * GIB });
    expect(readResourceBudget()).toBeNull();
});
it("shrinks the runner budget to current capacity", () => {
    vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 48 * GIB, availableBytes: 9 * GIB });
    expect(readResourceBudget()).toEqual({ reserveBytes: 6 * GIB, maxRssBytes: 3 * GIB });
});
it("admits a light check with a smaller enforced ceiling while the heavy lane remains deferred", () => {
    vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 48 * GIB, availableBytes: 4 * GIB });
    expect(readResourceBudget()).toBeNull();
    expect(readResourceBudget("light")).toEqual({ reserveBytes: 2 * GIB, maxRssBytes: GIB });
});
it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])("refuses invalid total memory %s", totalBytes => {
    vi.mocked(readResourceMemory).mockReturnValue({ totalBytes, availableBytes: 32 * GIB });
    expect(readResourceBudget()).toBeNull();
});
it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])("refuses invalid available memory %s", availableBytes => {
    vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 48 * GIB, availableBytes });
    expect(readResourceBudget()).toBeNull();
});
