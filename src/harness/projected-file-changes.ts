import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { extractApplyPatchRaw, looksLikeApplyPatch, parseApplyPatchSections, reconstructAfterContent, type ApplyPatchSection } from "./apply-patch-content.js";
import { projectLineCount } from "./line-count-projection.js";

/** Proposed effects, never proof of an executed write. Unknown inputs stay unmeasured. */
export interface ProjectedFileChange {
    path: string;
    sourcePath: string;
    before: string;
    after: string;
    existed: boolean;
    deleted: boolean;
}

export function projectPatchSection(section: ApplyPatchSection, cwd: string): ProjectedFileChange | null {
    const path = resolve(cwd, section.path);
    const sourcePath = resolve(cwd, section.fromPath ?? section.path);
    try {
        const existed = existsSync(sourcePath);
        if (section.op !== "add" && !existed) return null;
        const before = existed ? readFileSync(sourcePath, "utf8") : "";
        const reconstructed = reconstructAfterContent(section, before);
        if (reconstructed === null) return null;
        // Native Add File writes a terminating newline for every body line.
        const after = section.op === "add" && section.body.length > 0 ? `${reconstructed}\n` : reconstructed;
        return { path, sourcePath, before, after, existed, deleted: section.op === "delete" };
    } catch { return null; }
}

export function projectDirectChange(input: JsonObject, path: string): ProjectedFileChange | null {
    const projected = projectLineCount(input, path);
    if (!projected || projected.afterText === null) return null;
    return { path, sourcePath: path, before: projected.beforeText, after: projected.afterText,
        existed: existsSync(path), deleted: false };
}

/** Normalize native Write/Edit/MultiEdit and patch tools to before/after effects. */
export function projectFileChanges(input: JsonObject, cwd: string): ProjectedFileChange[] {
    const raw = extractApplyPatchRaw(input);
    const named = typeof input.file_path === "string" ? input.file_path : input.path;
    if (typeof named === "string" && named) {
        const change = projectDirectChange(input, resolve(cwd, named));
        return change ? [change] : [];
    }
    if (!looksLikeApplyPatch(raw)) return [];
    return parseApplyPatchSections(raw).flatMap(section => {
        const change = projectPatchSection(section, cwd);
        return change ? [change] : [];
    });
}
