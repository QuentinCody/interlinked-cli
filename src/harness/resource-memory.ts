import os from "node:os";
import { readDarwinAvailable } from "./resource-memory-darwin.js";

function availableMemory(constrained: number): number {
    if (os.platform() === "darwin" && constrained === 0) return readDarwinAvailable();
    return process.availableMemory?.() ?? os.freemem();
}

/** Respect container limits as well as physical RAM. Missing readings defer work. */
export function readResourceMemory(): { totalBytes: number; availableBytes: number } {
    const physical = os.totalmem();
    const constrained = process.constrainedMemory?.() ?? 0;
    return {
        totalBytes: constrained > 0 ? Math.min(physical, constrained) : physical,
        availableBytes: availableMemory(constrained),
    };
}
