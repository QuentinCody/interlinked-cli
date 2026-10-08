import { expect, it } from "vitest";
import { decodeAnnotated } from "./thinkthen.js";
import { CATALOG } from "./contracts.js";

it("preserves partial failures and never treats a missing answer as abstention", () => {
    const row = {
        schema: "thinkthen.result/1",
        input: { id: "unit" },
        answers: {
            name_matches: { answer: { kind: "yes_no", probability: 0.91 }, request: "abc" },
            behavior_change: { failure: { kind: "backend" } },
        },
        meta: { model: "clef-pinned", tool: "thinkthen 0.1.2" },
    };
    const results = decodeAnnotated(JSON.stringify(row), "unit", [
        CATALOG.name_matches!,
        CATALOG.behavior_change!,
        CATALOG.intent!,
    ]);
    expect(results[0]).toMatchObject({ raw: { probability: 0.91 }, servedModel: "clef-pinned" });
    expect(results[1]?.failure).toContain("failed");
    expect(results[2]?.failure).toContain("missing");
    expect(() => decodeAnnotated(JSON.stringify(row), "other", [CATALOG.name_matches!])).toThrow(
        /identity/,
    );
});
