import assert from "node:assert/strict";
import test from "node:test";
import { evidenceWindows, citationFor, groundingQuestion, citationQuestions, selectedCitations, bundleQuestion, choiceSupport, type GroundingCase } from "./grounding.mjs";

const example: GroundingCase = { id: "pricing", claim: "Input costs $0.042 per million tokens and output is free.", expectedSupport: true,
    origin: "authored", evidence: [{ tool: "Bash", input: "curl pricing", error: false,
        result_tail: "Header\nInput tokens: $0.042 / MTok.\nOutput tokens: FREE.\nFooter" }] };

test("retrieved windows keep exact offsets and include adjoining qualifiers", () => {
    const windows = evidenceWindows(example.claim, example.evidence);
    assert(windows.length > 0 && windows.length <= 12);
    assert(windows.some(window => window.text.includes("$0.042") && window.text.includes("FREE")));
    for (const window of windows) {
        const source = example.evidence[window.receiptIndex]!.result_tail;
        assert.equal(source.slice(...window.span), window.text);
    }
    assert.deepEqual(evidenceWindows("Tests passed", [{ tool: "Bash", input: "npm test", result_tail: "", error: false }]), []);
});

test("a citation must still match retained evidence; none and unknown IDs yield no citation", () => {
    const windows = evidenceWindows(example.claim, example.evidence);
    const choice = windows[0]!.id;
    assert(citationFor(choice, windows, example.evidence));
    assert.equal(citationFor("none", windows, example.evidence), null);
    assert.equal(citationFor("invented", windows, example.evidence), null);
    const changed = [{ ...example.evidence[0]!, result_tail: "changed" }];
    assert.throws(() => citationFor(choice, windows, changed));
});

test("question includes each excerpt directly, preserves an abstention option and excludes labels", () => {
    const windows = evidenceWindows(example.claim, example.evidence);
    const question = groundingQuestion(example, windows, true);
    assert.equal(question.type, "choice");
    assert("none" in question.criteria);
    assert.equal(Object.keys(question.criteria).length, windows.length + 1);
    assert(!JSON.stringify(question).includes("expectedSupport"));
    assert(JSON.stringify(question).includes("$0.042"));
});

test("independent citation judgments preserve missing results and require exact surviving sources", () => {
    const windows = evidenceWindows(example.claim, example.evidence);
    const questions = citationQuestions(example, windows);
    assert.equal(Object.keys(questions).length, windows.length);
    const response = { model: "test", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
    assert.equal(selectedCitations(response, windows, example.evidence), null);
    const answers = Object.fromEntries(windows.map((_window, i) => [`w${i}`, { type: "noul" as const, noul: i === 0 ? 0.95 : 0.1 }]));
    const selected = selectedCitations({ ...response, answers }, windows, example.evidence);
    assert.equal(selected?.length, 1);
    assert.equal(bundleQuestion(example, selected!).type, "noul");
    assert(!JSON.stringify(questions).includes("expectedSupport"));
});

test("unknown citation IDs and non-finite confidence are not successful judgments", () => {
    const windows = evidenceWindows(example.claim, example.evidence);
    assert.equal(choiceSupport({ type: "choice", choice: "invented", confidence: 0.99, probabilities: {} }, windows, example.evidence), null);
    assert.equal(choiceSupport({ type: "choice", choice: windows[0]!.id, confidence: NaN, probabilities: {} }, windows, example.evidence), null);
    assert.equal(choiceSupport({ type: "choice", choice: windows[0]!.id, confidence: 0.99, probabilities: {} }, windows, example.evidence), true);
});
