import { expect, it } from "vitest";
import { FINDING_QUESTIONS } from "./finding-assessment.js";
import { createFindingQuestionProfile, parseFindingQuestionProfile } from "./finding-question-profile.js";

it("freezes changed instructions and per-choice criteria, including structured JSON", () => {
	const questions = structuredClone(FINDING_QUESTIONS);
	questions.disposition!.instructions = { task: "Establish the premise before judging the rule", order: ["premise", "scope", "exception", "failure"] };
	if (questions.disposition!.type === "choice") questions.disposition!.criteria.violation = "The supplied behavior demonstrably conflicts with the applicable adopted invariant.";
	const profile = createFindingQuestionProfile("premise-first", questions);
	expect(profile.questions).toEqual(questions);
	expect(parseFindingQuestionProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
	expect(() => parseFindingQuestionProfile({ ...profile, name: "renamed" })).toThrow();
});

it.each([
	JSON.parse('{"disposition":{"type":"choice","instructions":{"nested":{"__proto__":{"value":1}}},"criteria":{}},"priority":{}}'),
	{ ...FINDING_QUESTIONS, extra: FINDING_QUESTIONS.disposition },
	{ ...FINDING_QUESTIONS, disposition: { ...FINDING_QUESTIONS.disposition, arbitrary: true } },
	{ ...FINDING_QUESTIONS, priority: { type: "choice", instructions: "Question", criteria: { low: "low" } } },
])("rejects prototype keys, arbitrary question properties and changed outcome keys", questions => {
	expect(() => createFindingQuestionProfile("invalid", questions)).toThrow();
});

it("rejects non-JSON nested content and cyclic data", () => {
	const questions = structuredClone(FINDING_QUESTIONS);
	questions.disposition!.instructions = { invalid: Number.NaN };
	expect(() => createFindingQuestionProfile("invalid", questions)).toThrow();
	const cyclic: Record<string, unknown> = {};
	cyclic.value = cyclic;
	expect(() => createFindingQuestionProfile("invalid", { ...FINDING_QUESTIONS, disposition: { ...FINDING_QUESTIONS.disposition, instructions: cyclic } })).toThrow();
});
