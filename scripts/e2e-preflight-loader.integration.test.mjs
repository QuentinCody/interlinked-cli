import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { preflightE2e } from "./e2e-preflight.mjs";

it("preserves the script runtime's module identity through the in-memory loader", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "preflight-loader-")));
    try {
        mkdirSync(join(root, "src/harness"), { recursive: true });
        mkdirSync(join(root, "scripts"));
        writeFileSync(join(root, "scripts/e2e-evidence.mjs"), "export const location = import.meta.url;\n");
        writeFileSync(join(root, "src/harness/e2e-preflight.ts"),
            'import { location } from "../../scripts/e2e-evidence.mjs"; export async function preflightE2eRun() { return location; }\n');
        expect(await preflightE2e(root)).toBe(pathToFileURL(join(root, "scripts/e2e-evidence.mjs")).href);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
