import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHooksCommand } from "./install-hooks.js";
import { uninstallHooksCommand } from "./uninstall-hooks.js";

let tmp = "";
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "interlinked-uh-mutation-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
});

afterEach(() => {
    cwdSpy?.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
});

describe("uninstall-hooks mutation contracts", () => {
    // test-contract: an omitted runner filter removes every installed hook and uses a false dry-run request.
    it("removes all installed hooks without a filter", async () => {
        const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        await installHooksCommand({
            runner: "claude-code,copilot-cli",
            binary: "/usr/bin/mutation-all",
        });

        await uninstallHooksCommand({});

        expect(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8")).not.toContain("mutation-all");
        expect(readFileSync(join(tmp, ".github", "hooks", "hooks.json"), "utf-8")).not.toContain("mutation-all");
        expect(output).toHaveBeenCalledWith("[interlinked] removed 2 hook registration(s)\n");
        output.mockRestore();
    });

    // test-contract: the all alias has the same observable removal behavior as no runner filter.
    it("accepts the all runner alias", async () => {
        const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        await installHooksCommand({
            runner: "claude-code",
            binary: "/usr/bin/mutation-all-alias",
        });

        await uninstallHooksCommand({ runner: "all" });

        expect(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8")).not.toContain("mutation-all-alias");
        expect(output).toHaveBeenCalledWith("[interlinked] removed 1 hook registration(s)\n");
        output.mockRestore();
    });

    it("rejects an invalid runner before removing any hooks", async () => {
        const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        await installHooksCommand({
            runner: "claude-code,copilot-cli",
            binary: "/usr/bin/mutation-filter",
        });

        output.mockClear();
        await expect(uninstallHooksCommand({ runner: "claude-code,not-a-runner" })).rejects.toThrow(
            "Unknown runner: not-a-runner; no hooks were removed",
        );

        expect(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8")).toContain("mutation-filter");
        expect(readFileSync(join(tmp, ".github", "hooks", "hooks.json"), "utf-8")).toContain("mutation-filter");
        expect(output).not.toHaveBeenCalled();
        output.mockRestore();
    });

    // test-contract: dry-run reports would-remove but leaves the manifest-backed settings unchanged.
    it("does not modify files during dry-run", async () => {
        const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        await installHooksCommand({
            runner: "claude-code",
            binary: "/usr/bin/mutation-dry",
        });
        const before = readFileSync(join(tmp, ".claude", "settings.json"), "utf-8");

        await uninstallHooksCommand({ runner: "claude-code", dryRun: true });

        expect(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8")).toBe(before);
        expect(output).toHaveBeenCalledWith("[interlinked] would remove 1 hook registration(s)\n");
        output.mockRestore();
    });
});
