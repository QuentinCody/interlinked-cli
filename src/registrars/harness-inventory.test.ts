import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerHarnessInventory } from "./harness-inventory.js";

const calls = vi.hoisted(() => ({ verify: vi.fn(), coverage: vi.fn(), explain: vi.fn(), checks: vi.fn(), capabilities: vi.fn(), corpus: vi.fn(), health: vi.fn() }));
vi.mock("../commands/harness-coverage-verify.js", () => ({ harnessCoverageVerifyCommand: calls.verify }));
vi.mock("../commands/harness-capabilities.js", () => ({ harnessCoverageCommand: calls.coverage, harnessCapabilitiesCommand: calls.capabilities }));
vi.mock("../commands/harness-explain.js", () => ({ harnessExplainCommand: calls.explain }));
vi.mock("../commands/harness-checks.js", () => ({ harnessChecksCommand: calls.checks }));
vi.mock("../commands/harness-corpus.js", () => ({ harnessCorpusCommand: calls.corpus }));
vi.mock("../commands/harness-health.js", () => ({ harnessHealthCommand: calls.health }));
beforeEach(() => { vi.clearAllMocks(); });

function parse(args: string[]): Promise<Command> {
    const harness = new Command().exitOverride();
    registerHarnessInventory(harness);
    return harness.parseAsync(args, { from: "user" });
}

describe("coverage recovery command arguments", () => {
    it("dispatches inventory inspection with the requested topic and output modes", async () => {
        await parse(["explain", "taint", "--client", "codex", "--json"]);
        expect(calls.explain).toHaveBeenCalledExactlyOnceWith("taint", { client: "codex", json: true });
        await parse(["checks", "--full"]);
        expect(calls.checks).toHaveBeenCalledExactlyOnceWith({ full: true });
        await parse(["capabilities", "--json"]);
        expect(calls.capabilities).toHaveBeenCalledExactlyOnceWith({ json: true });
    });

    it.each(["status", "scan"])("dispatches corpus %s with the requested detector IDs", async action => {
        await parse(["corpus", action, "nan_comparison", "test_legitimacy", "--json"]);
        expect(calls.corpus).toHaveBeenCalledExactlyOnceWith(action, ["nan_comparison", "test_legitimacy"], { json: true });
    });

    it("forwards explicit health recheck files and policy acceptance identity", async () => {
        await parse(["health", "--recheck", "--file", "one.ts", "two.ts", "--json"]);
        expect(calls.health).toHaveBeenCalledExactlyOnceWith({ recheck: true, file: ["one.ts", "two.ts"], json: true });
        await parse(["coverage", "accept-policy", "policy-digest", "--json"]);
        expect(calls.coverage).toHaveBeenCalledExactlyOnceWith({ operation: "accept_policy", digest: "policy-digest" }, { json: true });
    });

    it("requests cached progress explicitly while default status still refreshes", async () => {
        await parse(["coverage", "status", "--progress", "--json"]);
        expect(calls.coverage).toHaveBeenLastCalledWith({ operation: "status", detail: "progress" }, { progress: true, json: true });
        await parse(["coverage", "status", "--json"]);
        expect(calls.coverage).toHaveBeenLastCalledWith({ operation: "status" }, { json: true });
    });
    it("starts background verification when --no-wait is requested", async () => {
        await parse(["coverage", "verify", "--no-wait", "--json"]);
        expect(calls.verify).toHaveBeenCalledExactlyOnceWith({ wait: false, json: true });
    });

    it("passes exact review identity and numeric generation to the daemon", async () => {
        await parse(["coverage", "acknowledge", "id", "7", "hash", "review evidence", "--json"]);
        expect(calls.coverage).toHaveBeenCalledExactlyOnceWith({ operation: "acknowledge", id: "id", generation: 7, identity: "hash", evidence: "review evidence" }, { json: true });
    });

    it.each(["1.5", "invalid"])("rejects an invalid review generation %s before mutation", async generation => {
        await expect(parse(["coverage", "acknowledge", "id", generation, "hash", "review"])).rejects.toThrow("generation must be a nonnegative integer");
        expect(calls.coverage).not.toHaveBeenCalled();
    });
});
