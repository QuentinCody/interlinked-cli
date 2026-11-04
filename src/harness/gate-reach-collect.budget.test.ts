import { expect, it, vi } from "vitest";
vi.mock("./manifest-file-walk.js", () => ({ findManifestFiles: (_root: string, _match: unknown, options: { onLimit(): void }) => {
    options.onLimit(); return [];
} }));
import { collectGateReachSnapshot } from "./gate-reach-collect.js";

it("MUST-NOT claim a complete denominator when the Stop scan reaches its budget", () => {
    const snapshot = collectGateReachSnapshot({ cwd: "/unused", sessionId: "s", now: 0, perEditCoverageEnabled: true });
    expect(snapshot.gates).toHaveLength(2);
    for (const gate of snapshot.gates) expect(gate).toMatchObject({ status: "source_unavailable", reason: "eligible_domain_exceeded_50000_entry_budget" });
});
