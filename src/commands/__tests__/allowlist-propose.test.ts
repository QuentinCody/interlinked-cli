import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { proposeAllowlistCommand } from "../allowlist-propose.js";
vi.mock("../../lib/output.js", () => ({ getOutputMode: () => "json", output: vi.fn(), outputError: vi.fn() }));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it("records a request while preserving the allowlist bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "package-proposal-")); roots.push(root);
    const state = join(root, ".interlinked"); mkdirSync(state);
    const policy = join(state, "package-allowlist.json"); writeFileSync(policy, "operator-owned-policy");
    proposeAllowlistCommand("npm", "example-package", { cwd: root, version: "1.2.3", reason: "Public API requires parsing", json: true });
    expect(readFileSync(policy, "utf8")).toBe("operator-owned-policy");
    const directory = join(state, "package-proposals"), names = readdirSync(directory);
    expect(names).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(directory, names[0]!), "utf8"))).toMatchObject({ status: "pending", requestedVersion: "1.2.3", writer: "unknown" });
});
