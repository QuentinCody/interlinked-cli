import { expect, it } from "vitest";
import { CATALOG } from "./contracts.js";
import { interpretAnswer, parseAnswer } from "./answers.js";

it("keeps exact band boundaries and allows probability replay at a new band", () => {
    const q = CATALOG.behavior_change!;
    expect(interpretAnswer(q, { kind: "yes_no", probability: 0.2 }, [0.2, 0.8]).status).toBe(
        "abstained",
    );
    expect(interpretAnswer(q, { kind: "yes_no", probability: 0.8 }, [0.2, 0.8]).value).toBe(true);
    expect(interpretAnswer(q, { kind: "yes_no", probability: 0.7 }, [0.4, 0.6]).value).toBe(true);
});

it("retains score dispersion and rejects malformed distributions", () => {
    const q = CATALOG.error_handling!;
    const raw = parseAnswer(
        { kind: "score", probabilities: { "0": 0.5, "1": 0, "2": 0.5, "3": 0 }, confidence: 0.99 },
        q,
    );
    expect(interpretAnswer(q, raw, [0.2, 0.8]).value).toBe(1);
    expect(raw).toMatchObject({ probabilities: { "0": 0.5, "2": 0.5 } });
    expect(() => parseAnswer({ kind: "score", probabilities: { "0": 0.5 } }, q)).toThrow();
    expect(() =>
        parseAnswer({ kind: "yes_no", probability: 1.2 }, CATALOG.name_matches!),
    ).toThrow();
});

it("decodes the live ThinkThen choice and named-score wire shapes", () => {
    const q = CATALOG.intent!;
    const probabilities = Object.fromEntries(
        Object.keys(q.options!).map((label) => [label, label === "fix" ? 1 : 0]),
    );
    expect(
        interpretAnswer(q, parseAnswer({ kind: "choice", probabilities }, q), [0.2, 0.8]).value,
    ).toBe("fix");
    const score = CATALOG.error_handling!;
    const named = Object.fromEntries(score.levels!.map((level, i) => [level, i === 2 ? 1 : 0]));
    expect(
        interpretAnswer(
            score,
            parseAnswer({ kind: "score", probabilities: named }, score),
            [0.2, 0.8],
        ).value,
    ).toBe(2);
});
