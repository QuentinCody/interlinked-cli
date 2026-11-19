import { expect, it } from "vitest";
import { CATALOG, evidenceField, evidenceInput, questionSet, selectEvidence } from "./contracts.js";

it("selects only declared evidence and distinguishes absent from empty", () => {
    expect(selectEvidence({ body: "code", tests: [] }, ["/body", "/tests"])).toEqual({
        body: "code",
        tests: [],
    });
    expect(() => selectEvidence({ body: "code" }, ["/tests"])).toThrow(/missing evidence/);
    expect(selectEvidence({ "a/b": { "~x": false } }, ["/a~1b/~0x"])).toEqual({ "~x": false });
    expect(() => selectEvidence({}, ["/__proto__"])).toThrow();
});

it("compiles contracts into a ThinkThen 0.2 annotate toolbox", () => {
    expect(questionSet([CATALOG.name_matches!, CATALOG.behavior_change!, CATALOG.intent!, CATALOG.smells!])).toEqual({
        questions: {
            // Several evidence fields: one derived field, because a 0.2 question reads one pointer.
            name_matches: {
                function: "decide",
                question: CATALOG.name_matches!.question,
                field: "/interlinked.evidence:name_matches",
            },
            // One evidence field: read it directly.
            behavior_change: { function: "decide", question: CATALOG.behavior_change!.question, field: "/hunk" },
            intent: {
                function: "choose",
                question: CATALOG.intent!.question,
                field: "/interlinked.evidence:intent",
                choices: [
                    { name: "fix", description: "Corrects wrong behavior" },
                    { name: "feature", description: "Adds behavior" },
                    { name: "refactor", description: "Structure without behavior change" },
                    { name: "revert", description: "Undoes a change" },
                    { name: "chore", description: "Maintenance" },
                    { name: "insufficient_evidence", description: "Intent not established" },
                ],
            },
            smells: { function: "tag", question: CATALOG.smells!.question, field: "/body", labels: CATALOG.smells!.labels },
        },
    });
    const score = Object.values(CATALOG).find((contract) => contract.kind === "score")!;
    expect(questionSet([score]).questions).toEqual({
        [score.id]: { function: "score", question: score.question, field: evidenceField(score), levels: score.levels },
    });
    // No threshold is sent: Interlinked interprets the raw probabilities with its own band.
    expect(JSON.stringify(questionSet(Object.values(CATALOG)))).not.toContain("threshold");
});

it("adds one derived evidence field per multi-field question and escapes the pointer", () => {
    const evidence = { signature: "f()", body: "return 1;", hunk: "+x" };
    expect(evidenceInput(evidence, [CATALOG.name_matches!, CATALOG.behavior_change!])).toEqual({
        ...evidence,
        "interlinked.evidence:name_matches": { signature: "f()", body: "return 1;" },
    });
    expect(evidenceField({ id: "a/b~c", on: ["/x", "/y"] })).toBe("/interlinked.evidence:a~1b~0c");
    expect(evidenceField({ id: "a/b~c", on: ["/x"] })).toBe("/x");
    expect(() => evidenceInput({ body: "code" }, [CATALOG.name_matches!])).toThrow(/missing evidence/);
    expect(() =>
        evidenceInput({ ...evidence, "interlinked.evidence:name_matches": 1 }, [CATALOG.name_matches!]),
    ).toThrow(/collides/);
});

it("keeps catalog contracts complete", () => {
    for (const q of Object.values(CATALOG)) {
        expect(q.validation.length).toBeGreaterThan(5);
        expect(q.version).toBe("1");
        expect(q.population).toBeTruthy();
    }
});
