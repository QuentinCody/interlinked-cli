import { describe, it } from "vitest";
import { namedEffectCleanupCase } from "./__fixtures__/effect-cleanup-registration.js";
import { effectCleanupScenarios } from "./__fixtures__/effect-cleanup-scenarios.js";
import { checkMissingEffectCleanup } from "./missing-effect-cleanup.js";

const run = namedEffectCleanupCase(effectCleanupScenarios(checkMissingEffectCleanup));

describe("checkMissingEffectCleanup — early-return gates", () => {
	it("returns [] for a test file (.test.tsx) regardless of content", run);
	it("returns [] for a path inside a __tests__/ directory", run);
	it("returns [] for a non-tsx/jsx extension (.ts) even with a leaky effect", run);
	it("returns [] for a .js (non-jsx) extension even with a leaky effect", run);
	it("returns [] when there are no useEffect calls at all", run);
	it("returns [] for empty content", run);
});

describe("checkMissingEffectCleanup — positive cases (.tsx, leak flagged)", () => {
	it("flags addEventListener with no cleanup return", run);
	it("flags one-line effects whose return is bare or `null`, not one that returns a cleanup", run);
	it("flags setInterval with no cleanup return", run);
	it("flags setTimeout with no cleanup return", run);
	it("flags subscribe(...) with no cleanup return", run);
	it("flags .on(...) event-emitter style with no cleanup return", run);
	it("fires on .jsx files too (the other allowed extension)", run);
	it("truncates the reported source line to 100 chars", run);
});

describe("checkMissingEffectCleanup — distinguishing cleanup from component returns", () => {
	it("does NOT fire when a `return () => {...}` cleanup is present", run);
	it("does NOT fire when a `return function() {...}` cleanup is present", run);
	it("does NOT fire when a `return cleanup;` identifier cleanup is present", run);
	it("still flags a subscription when the component later returns its render value", run);
	it("does NOT fire when there is no subscription call (plain effect)", run);
});

describe("checkMissingEffectCleanup — multi-effect block boundaries", () => {
	it("scopes each effect to the span up to the NEXT useEffect (second has end=next-start)", run);
	it("flags BOTH effects when both leak (last effect uses end = lines.length)", run);
	it("a clean effect followed by a leaking effect flags only the leaking one", run);
});
