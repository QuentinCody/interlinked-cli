import { posix, win32 } from "node:path";

/** Persist one portable relative selector for the runner output, including in cache identity. */
export function normalizeEvidenceArtifact(value: string): string {
    if (!value || value.includes("\0") || posix.isAbsolute(value) || win32.isAbsolute(value)) throw new Error("Artifact must be a relative file inside the workspace");
    const path = posix.normalize(value.replaceAll("\\", "/"));
    if (path === "." || path === ".." || path.startsWith("../") || path.endsWith("/")) throw new Error("Artifact must be a relative file inside the workspace");
    return path;
}
