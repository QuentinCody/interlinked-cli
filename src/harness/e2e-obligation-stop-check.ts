import { isAbsolute, relative } from "node:path";
import { isBoundaryFile } from "./e2e-boundary.js";

export function formatE2eObligationWarning(input: { cwd: string; files: Iterable<string>; lanes: readonly string[] }): string | null {
    if (input.lanes.includes("e2e")) return null;
    const boundaries = [...input.files].map((path) => isAbsolute(path) ? relative(input.cwd, path) : path).filter(isBoundaryFile);
    if (boundaries.length === 0) return null;
    return `[interlinked:e2e-obligation] ${boundaries.length} boundary file(s) changed without an e2e invocation in this session. Run npm run test:e2e from this session (${boundaries.slice(0, 5).join(", ")}).`;
}
