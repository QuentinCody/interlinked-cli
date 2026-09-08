import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Fail closed on contention/crash residue. Never evict another process's lease. */
export function withPromotionLock(directory: string, action: () => boolean): boolean {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "promotion.lock");
    let descriptor: number;
    try { descriptor = openSync(path, "wx", 0o600); } catch { return false; }
    try { return action(); }
    finally { closeSync(descriptor); unlinkSync(path); }
}
