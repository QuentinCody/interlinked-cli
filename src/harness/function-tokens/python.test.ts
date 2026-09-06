import { describe, expect, it, vi } from "vitest";

// spawnSync is mocked (never the SUT itself) so the "adapter printed
// something that is not valid JSON" catch branch is reachable without
// depending on the real Python adapter script ever misbehaving. Every
// other call passes through to the real node:child_process implementation.
const spawnControl = vi.hoisted(() => ({ forceInvalidJson: false }));

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	return {
		...actual,
		spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
			if (spawnControl.forceInvalidJson) {
				return {
					status: 0,
					pid: 0,
					output: [null, Buffer.from("not-json-at-all"), Buffer.from("")],
					stdout: "not-json-at-all",
					stderr: "",
					signal: null,
					// SAFETY: this canned result only exercises the caller's
					// status/stdout handling; the omitted fields are never read.
				} as ReturnType<typeof actual.spawnSync>;
			}
			return actual.spawnSync(...args);
		},
	};
});

import { computePythonFunctionTokens } from "./python.js";

function entries(source: string) {
    const result = computePythonFunctionTokens(source, "src/example.py");
    expect(result).not.toBeNull();
    return result ?? [];
}

describe("interlinked-code-v1 Python adapter", () => {
    it("extracts decorated, nested, method, constructor, and lambda implementations", () => {
        const result = entries(`
@decorator
def outer(value: str) -> str:
    def inner():
        return value
    callback = lambda item: item + 1
    return inner()

class Service:
    def __init__(self):
        self.value = 1

    def read(self):
        return self.value
`);
        expect(result.map((entry) => [entry.qualifiedName, entry.declarationKind])).toEqual([
            ["outer", "function"],
            ["outer.inner", "closure"],
            ["outer.(callback)", "lambda"],
            ["Service.__init__", "constructor"],
            ["Service.read", "method"],
        ]);
        expect(result[0]?.startOffset).toBe(1);
    });

    it("ignores trivia and treats a string literal as one canonical token", () => {
        const compact = entries("def f():\n    return 'many words'\n")[0];
        const commented = entries("def f( ):\n    # ignored\n    return 'many words'\n")[0];
        expect(compact?.canonicalTokens).toBe(commented?.canonicalTokens);
        expect(compact?.canonicalTokens).toBe(7);
    });

    it("returns UTF-16 offsets for Unicode before and inside a function", () => {
        const source = "title = '😀'\n\ndef café(value='😀'):\n    return value\n";
        const entry = entries(source)[0];
        expect(source.slice(entry?.startOffset, entry?.endOffset)).toContain("def café");
    });

    it("fails open on malformed source", () => {
        expect(computePythonFunctionTokens("def broken(:\n", "broken.py")).toBeNull();
    });

    it("fails open when the adapter exits cleanly but prints non-JSON stdout", () => {
        spawnControl.forceInvalidJson = true;
        try {
            expect(computePythonFunctionTokens("def f():\n    return 1\n", "f.py")).toBeNull();
        } finally {
            spawnControl.forceInvalidJson = false;
        }
    });
});
