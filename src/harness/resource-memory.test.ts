import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { readResourceMemory } from "./resource-memory.js";
import { readDarwinAvailable } from "./resource-memory-darwin.js";

vi.mock("./resource-memory-darwin.js", () => ({ readDarwinAvailable: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it("uses an 8 GiB container limit on a larger physical host", () => {
    vi.spyOn(os, "totalmem").mockReturnValue(48 * 1024 ** 3);
    vi.spyOn(process, "constrainedMemory").mockReturnValue(8 * 1024 ** 3);
    vi.spyOn(process, "availableMemory").mockReturnValue(3 * 1024 ** 3);
    expect(readResourceMemory()).toEqual({ totalBytes: 8 * 1024 ** 3, availableBytes: 3 * 1024 ** 3 });
});

it("uses physical RAM when no container limit is reported", () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    vi.spyOn(os, "totalmem").mockReturnValue(16 * 1024 ** 3);
    vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
    vi.spyOn(process, "availableMemory").mockReturnValue(5 * 1024 ** 3);
    expect(readResourceMemory()).toEqual({ totalBytes: 16 * 1024 ** 3, availableBytes: 5 * 1024 ** 3 });
});
it("uses native available memory on an unconstrained Mac instead of Node's free-page reading", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "totalmem").mockReturnValue(48 * 1024 ** 3);
    vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
    vi.spyOn(process, "availableMemory").mockReturnValue(512 * 1024 ** 2);
    vi.mocked(readDarwinAvailable).mockReturnValue(12 * 1024 ** 3);
    expect(readResourceMemory()).toEqual({ totalBytes: 48 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 });
});
