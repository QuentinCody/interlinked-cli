// ===========================================
// Policy parser primitives — constructing, refusing, field-naming
// ===========================================
// Extracted from policy.ts (line cap). Every primitive either returns an
// exact typed value or throws with the field named; nothing is coerced or
// guessed. Shared by policy.ts, policy-suites.ts and policy-stability.ts.

import type { E2eArgvStep } from "./policy.js";

export const E2E_PLACEHOLDERS = ["{run-directory}", "{fixture-directory}"] as const;
/** `{port}` is the loopback port the supervisor allocates for ONE owned service; only a service's own argv/env may name it (§5.3). */
export const SERVICE_PLACEHOLDERS = [...E2E_PLACEHOLDERS, "{port}"] as const;
const ID = /^[a-zA-Z0-9_.-]{1,100}$/;

export function fail(message: string): never { throw new Error(`e2e policy: ${message}`); }
export function record(value: unknown, where: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
    // SAFETY: the guard above proves a non-null, non-array object.
    return value as Record<string, unknown>;
}
export function onlyKeys(row: Record<string, unknown>, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(row)) if (!allowed.includes(key)) fail(`${where} has unknown key "${key}"`);
}
export function id(value: unknown, where: string): string {
    if (typeof value !== "string" || !ID.test(value)) fail(`${where} needs an id matching ${ID}`);
    return value;
}
function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0 && !item.includes("\0"));
}
export function stringList(value: unknown, where: string, max = 256): string[] {
    if (!isStringList(value) || value.length > max) fail(`${where} must be a list of at most ${max} non-empty strings`);
    return value;
}
export function relativePath(value: unknown, where: string): string {
    if (typeof value !== "string") fail(`${where} must be a string`);
    if (!value || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\0") || value.split(/[\\/]/).includes("..")) fail(`${where} must be a confined project-relative path`);
    return value.replaceAll("\\", "/");
}
export function globList(value: unknown, where: string): string[] {
    return stringList(value, where).map(glob => relativePath(glob, where));
}
export function unique(ids: string[], where: string): void {
    if (new Set(ids).size !== ids.length) fail(`${where} ids must be unique`);
}
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
    if (!allowed.includes(value as T)) fail(`${where} must be one of ${allowed.join(", ")}`);
    // SAFETY: membership in `allowed` was just checked.
    return value as T;
}
export function checkPlaceholders(token: string, where: string, allowed: readonly string[] = E2E_PLACEHOLDERS): void {
    for (const match of token.matchAll(/\{[^}]*\}?/g)) {
        if (!allowed.includes(match[0])) fail(`${where} uses unknown placeholder ${match[0]}; allowed: ${allowed.join(", ")}`);
    }
}
export function argvStep(value: unknown, where: string): E2eArgvStep {
    const row = record(value, where);
    onlyKeys(row, ["argv"], where);
    const argv = stringList(row.argv, `${where}.argv`, 128);
    if (!argv.length) fail(`${where}.argv must not be empty`);
    for (const token of argv) checkPlaceholders(token, `${where}.argv`);
    return { argv };
}
