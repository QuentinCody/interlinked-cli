import { expect, it } from "vitest";
import { parseDarwinAvailable } from "./resource-memory-darwin.js";

const reading = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 32768.\nPages inactive: 524288.\nPages wired down: 2000000.\n";
it("includes reclaimable inactive pages without counting wired GPU/model allocations", () => {
    expect(parseDarwinAvailable(reading, "1\n")).toBe(8.5 * 1024 ** 3);
});
it.each(["2", "4", "", "NaN", "0"])("defers when native pressure is non-normal or unavailable (%s)", pressure => {
    expect(parseDarwinAvailable(reading, pressure)).toBe(0);
});
it.each(["", "page size of 16384 bytes\nPages free: 12.", reading.replace("16384", "99999999999999999")])("refuses malformed VM statistics", vmStat => {
    expect(parseDarwinAvailable(vmStat, "1")).toBe(0);
});
