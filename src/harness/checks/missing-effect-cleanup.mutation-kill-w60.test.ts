import { describe, it } from "vitest";
import { namedEffectCleanupCase } from "./__fixtures__/effect-cleanup-registration.js";
import { effectCleanupMutationScenarios } from "./__fixtures__/effect-cleanup-mutation-scenarios.js";
import { checkMissingEffectCleanup } from "./missing-effect-cleanup.js";

const run = namedEffectCleanupCase(effectCleanupMutationScenarios(checkMissingEffectCleanup));

describe("checkMissingEffectCleanup — mutation-kill w60", () => {
	it("returns an empty array when there is no useEffect at all", run);
	it("detects `.on (` with a space before the paren as a subscription", run);
	it("detects `addEventListener (` with a space before the paren as a subscription", run);
	it("still recognizes `useEffect (` with a space before the paren as an effect start", run);
	it("reports the trimmed useEffect start line with no leading whitespace", run);
	it("recognizes `return identifier;` as cleanup mid-line", run);
	it("recognizes `return  identifier;` with extra whitespace after return", run);
	it("recognizes `return ()=>{...}` with zero spaces around the arrow", run);
	it("recognizes `return ( ) => {...}` with a space inside the parens", run);
	it("recognizes `return () => {...}` with a space before the arrow", run);
	it("recognizes `return identifier ;` with a space before the semicolon", run);
	it("does NOT treat a mid-line comment mentioning `return` as cleanup", run);
});
