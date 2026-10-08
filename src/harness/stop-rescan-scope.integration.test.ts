import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { makeSession } from "./__tests__/fixtures/evaluator.js";
import { ProjectGraph } from "./project-graph.js";
import { rescanSessionFiles } from "./stop-rescan.js";

it("keeps native Stop detectors inside the selected repository even with a parent package and escaping symlink", () => {
    const home = mkdtempSync(join(tmpdir(), "stop-scope-"));
    const root = join(home, "repository");
    mkdirSync(root);
    writeFileSync(join(home, "package.json"), "{}");
    writeFileSync(join(root, "package.json"), "{}");
    const external = join(home, "memory.ts");
    writeFileSync(external, "app.get('/api/private', async (req, res) => { res.json(await db.findMany()); });");
    symlinkSync(external, join(root, "link.ts"));
    writeFileSync(join(root, "valid.ts"), "export const value = 1;\n");
    const session = makeSession();
    session.files_written = new Set([external, "link.ts", "valid.ts"]);
    const unavailable = vi.fn(), observation = vi.fn();
    const graphScan = vi.spyOn(ProjectGraph.prototype, "initialize");
    try {
        rescanSessionFiles(session, root, { dryRun: true, onUnavailable: unavailable, onObservation: observation });
        expect(unavailable.mock.calls.filter(([check]) => check === "stop-rescan:scope")).toHaveLength(2);
        expect(observation).toHaveBeenCalledTimes(1);
        expect(observation.mock.calls[0]?.[0].file).toBe("valid.ts");
        expect(graphScan).not.toHaveBeenCalled();
    } finally {
        graphScan.mockRestore();
        rmSync(home, { recursive: true, force: true });
    }
});
