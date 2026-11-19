import type { JevEntry, JevQuestion } from "../../harness/jev/types.js";
import { isJsonObject } from "../json-types.js";
import { FINDING_DISPOSITIONS } from "./finding-contracts.js";
import { digest } from "./store.js";

export interface FindingQuestionProfile {
	schema: "interlinked.finding-question-profile/1";
	id: string;
	name: string;
	questions: Record<string, JevQuestion>;
}

function jsonPropertyValue(key: string, descriptor: PropertyDescriptor): unknown {
	if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe nested question property");
	if (descriptor.get || descriptor.set || !descriptor.enumerable) throw new Error("Question content requires enumerable data properties");
	return descriptor.value;
}

function contentChildren(value: object): unknown[] {
	const array = Array.isArray(value);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) throw new Error("Question content requires plain JSON objects");
	if (Object.getOwnPropertySymbols(value).length) throw new Error("Question content cannot contain symbol properties");
	const children: unknown[] = [];
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (array && key === "length") continue;
		children.push(jsonPropertyValue(key, descriptor));
	}
	if (array && Object.keys(value).some((key, index) => key !== String(index))) throw new Error("Question arrays require dense numeric entries");
	if (array && Object.keys(value).length !== value.length) throw new Error("Question arrays cannot contain holes");
	return children;
}

function validateContent(value: unknown): asserts value is JevEntry {
	const queue = [value], seen = new WeakSet<object>();
	while (queue.length) {
		const current = queue.pop();
		if (current === null || typeof current === "string" || typeof current === "boolean") continue;
		if (typeof current === "number" && Number.isFinite(current)) continue;
		if (typeof current !== "object") throw new Error("Questions require finite JSON content");
		if (seen.has(current)) continue;
		seen.add(current);
		for (const child of contentChildren(current)) queue.push(child);
	}
	try {
		JSON.stringify(value);
	} catch (error) {
		throw new Error("Question content must be acyclic JSON", { cause: error });
	}
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
	const keys = Object.keys(value);
	if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new Error("Unexpected question profile properties or outcome keys");
}

function question(value: unknown, choices: readonly string[]): JevQuestion {
	if (!isJsonObject(value) || value.type !== "choice" || !isJsonObject(value.criteria)) throw new Error("Finding profiles require complete choice questions");
	exactKeys(value, ["type", "instructions", "criteria"]);
	exactKeys(value.criteria, choices);
	validateContent(value.instructions);
	const criteria: Record<string, JevEntry> = {};
	for (const key of choices) {
		const criterion = value.criteria[key];
		validateContent(criterion);
		criteria[key] = structuredClone(criterion);
	}
	return { type: "choice", instructions: structuredClone(value.instructions), criteria };
}

/** Freeze alternate wording and criteria while retaining comparable outcome keys. */
export function createFindingQuestionProfile(name: string, questions: unknown): FindingQuestionProfile {
	if (typeof name !== "string" || !name.trim() || !isJsonObject(questions)) throw new Error("Invalid finding question profile");
	validateContent(questions);
	exactKeys(questions, ["disposition", "priority"]);
	const body = {
		schema: "interlinked.finding-question-profile/1" as const, name,
		questions: { disposition: question(questions.disposition, FINDING_DISPOSITIONS), priority: question(questions.priority, ["low", "material", "critical", "unknown"]) },
	};
	return { id: digest(body), ...body };
}

/** Metadata and prompt content are both checked before accepting the immutable artifact. */
export function parseFindingQuestionProfile(value: unknown): FindingQuestionProfile {
	if (!isJsonObject(value) || value.schema !== "interlinked.finding-question-profile/1" || typeof value.name !== "string") throw new Error("Invalid finding question profile artifact");
	exactKeys(value, ["schema", "id", "name", "questions"]);
	const profile = createFindingQuestionProfile(value.name, value.questions);
	if (profile.id !== value.id) throw new Error("Finding question profile identity mismatch");
	return profile;
}
