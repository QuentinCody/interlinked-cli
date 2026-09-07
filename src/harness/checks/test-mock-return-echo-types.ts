// interlinked-tdd: exempt
// Shared type for the mock-return-echo check family — kept in its own module
// so the orchestrator (test-mock-return-echo.ts) and its sibling helper
// modules (test-mock-return-echo-mocks.ts, test-mock-return-echo-assert.ts)
// can all import it without an import cycle.

/** One `describe`/`it`/`test`/`beforeEach` callsite's brace-balanced extent
 *  in a masked file's character offsets. */
export interface Block {
	kind: "describe" | "it" | "beforeEach";
	keywordStart: number;
	argsStart: number;
	end: number;
}
