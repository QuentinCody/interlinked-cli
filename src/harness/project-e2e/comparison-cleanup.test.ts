import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixtureProject } from "./__tests__/fixture-projects.js";
import { E2E_POLICY_PATH, type E2ePolicy } from "./policy.js";
import { runProjectE2e } from "./run.js";

const copies = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async importOriginal => {
    const fs = await importOriginal<typeof import("node:fs")>();
    return { ...fs, mkdtempSync(prefix: string) {
        const path = fs.mkdtempSync(prefix);
        if (prefix.includes("interlinked-e2e-comparison-")) copies.push(path);
        return path;
    } };
});
const roots: string[] = [];
afterEach(() => { for (const path of [...roots.splice(0), ...copies.splice(0)]) rmSync(path, { recursive: true, force: true }); });

it("removes every comparison snapshot when recorded faults cannot be applied", async () => {
    const project = fixtureProject("py", { accept: true });
    roots.push(project.root);
    const path = join(project.root, E2E_POLICY_PATH);
    const policy: E2ePolicy = JSON.parse(readFileSync(path, "utf8"));
    policy.projects[0]!.scenarios[0]!.proof = {
        mode: "controlled-fault", designated: [{ id: "orders.create", outcome: ["files"] }],
        faults: ["missing-one", "missing-two"].map(id => ({ id, path: "orders_cli.py", find: id, replace: "", rationale: "absent anchor" })),
    };
    writeFileSync(path, JSON.stringify(policy));
    const result = await runProjectE2e({ root: project.root, timeoutMs: 30_000 });
    expect(result.exitCode).not.toBe(0);
    expect(copies).toHaveLength(2);
    expect(copies.filter(path => existsSync(path))).toEqual([]);
}, 30_000);
