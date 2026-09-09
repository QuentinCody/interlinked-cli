import { lstatSync, readFileSync } from "node:fs";
import { digest } from "./receipts.js";

export interface CoworkFileState { exists: boolean; sha256: string | null }

/** A bounded snapshot, not a filesystem lock or proof of a shared mount. */
export function coworkFileState(path: string): CoworkFileState {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return { exists: false, sha256: null };
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error("Unsupported bridge file snapshot");
    return { exists: true, sha256: digest(readFileSync(path)) };
}

export function sameCoworkFileState(left: CoworkFileState, right: unknown): boolean {
    if (!right || typeof right !== "object" || !("exists" in right) || !("sha256" in right)) return false;
    return left.exists === right.exists && left.sha256 === right.sha256;
}
