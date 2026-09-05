import { resolve, sep } from "node:path";

/** Catch fixture leaks without changing process cwd or collapsing per-test roots. */
export function assertCaptureIsolation(target: string): void {
    if (process.env.VITEST !== "true") return;
    const projectData = resolve(process.env.INTERLINKED_TEST_PROJECT_ROOT ?? process.cwd(), ".interlinked");
    const path = resolve(target);
    if (path === projectData || path.startsWith(`${projectData}${sep}`)) throw new Error("test capture attempted to write the real project data directory; use an explicit temporary project root");
}
