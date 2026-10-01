import { describe, expect, it } from "vitest";
import { indexedVitestCommand } from "./index-command.js";

const root = process.cwd();

/** The inline `startVitest` options object the command embeds, parsed back out of the eval script. */
function embeddedOptions(argv: string[]): Record<string, unknown> {
    const script = argv.at(-1) ?? "";
    const match = /startVitest\("test", \[[^\]]*\], (\{.*\}), \{ cacheDir/.exec(script);
    if (!match?.[1]) throw new Error(`no options object in: ${script}`);
    return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("indexedVitestCommand — positive (must fire)", () => {
    // test-contract: public-api — the indexed capture runs under the caller's worker cap when one is given (the host governor's memory-bounded budget), and otherwise leaves the runner's default in place
    it("P1: embeds the worker cap in the startVitest options", () => {
        const options = embeddedOptions(indexedVitestCommand(root, "/tmp/capture", ["a.test.ts"], { maxWorkers: 3 }));
        expect(options.maxWorkers).toBe(3);
        expect(options).toMatchObject({ root, watch: false, run: true, cache: false });
    });
});

describe("indexedVitestCommand — negative (must not fire)", () => {
    it("N1: leaves maxWorkers unset without a cap", () => {
        expect("maxWorkers" in embeddedOptions(indexedVitestCommand(root, "/tmp/capture"))).toBe(false);
    });
});
