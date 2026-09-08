import { describe, expect, it } from "vitest";
import { describeHookCapability, hookProfileDigest } from "./hook-contract.js";
import { CODEX_CAPABILITIES } from "./provider-capabilities.js";

const runtime = { provider: "codex", host: "cli", mode: "headless" } as const;

describe("capability evidence", () => {
    it("does not certify enforcement merely because a configured hook emitted", () => {
        const receipt = describeHookCapability(CODEX_CAPABILITIES, runtime, { name: "PreToolUse", observed: true });
        expect(receipt.subscription).toBe("selected");
        expect(receipt.emission).toBe("observed");
        expect(receipt.enforcement).toBe("unmeasured");
    });

    it("keeps a foreign or newer event unknown even when it was observed", () => {
        const receipt = describeHookCapability(CODEX_CAPABILITIES, runtime, { name: "FileChanged", observed: true });
        expect(receipt.declaration).toBe("unknown");
        expect(receipt.controls).toEqual([]);
        expect(receipt.controls_evidence).toBe("unmeasured");
        expect(receipt.subscription).toBe("unknown");
    });

    it("distinguishes an explicit absence of controls from an unmeasured declaration", () => {
        const capabilities = { ...CODEX_CAPABILITIES, events: [
            { ...CODEX_CAPABILITIES.events[0]!, controls: [], install: false },
        ] };
        const receipt = describeHookCapability(capabilities, runtime, { name: "SessionStart" });
        expect(receipt.controls_evidence).toBe("explicit");
        expect(receipt.subscription).toBe("parse_only");
        expect(receipt.emission).toBe("unmeasured");
    });

    it("binds evidence to capabilities rather than declaration ordering", () => {
        const original = hookProfileDigest(CODEX_CAPABILITIES);
        expect(hookProfileDigest({ ...CODEX_CAPABILITIES, events: [...CODEX_CAPABILITIES.events].reverse() })).toBe(original);
        expect(hookProfileDigest({ ...CODEX_CAPABILITIES, events: CODEX_CAPABILITIES.events.map(event => ({ ...event, install: false })) })).not.toBe(original);
        expect(hookProfileDigest({ ...CODEX_CAPABILITIES, events: CODEX_CAPABILITIES.events.map(event => ({ ...event, controls: ["wake"] })) })).not.toBe(original);
    });
});
