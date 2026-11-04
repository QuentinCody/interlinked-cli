import { createHash } from "node:crypto";
import { extractFunctionShingles, type FunctionShingles } from "./dry.js";

const MAX_ENTRIES = 128;
const cache = new Map<string, { hash: string; functions: FunctionShingles[] }>();
/** Bounded plain-data cache; every source edit invalidates its own entry. */
export function cachedFunctionShingles(content: string, file: string): FunctionShingles[] {
    const hash = createHash("sha256").update(content).digest("hex");
    const prior = cache.get(file);
    if (prior?.hash === hash) {
        cache.delete(file); cache.set(file, prior);
        return prior.functions;
    }
    const functions = extractFunctionShingles(content, file);
    cache.delete(file); cache.set(file, { hash, functions });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    return functions;
}
