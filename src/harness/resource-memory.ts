import os from "node:os";

/** Respect container limits as well as physical RAM. Missing readings defer work. */
export function readResourceMemory(): { totalBytes: number; availableBytes: number } {
    const physical = os.totalmem();
    const constrained = process.constrainedMemory?.() ?? 0;
    return {
        totalBytes: constrained > 0 ? Math.min(physical, constrained) : physical,
        availableBytes: process.availableMemory?.() ?? os.freemem(),
    };
}
