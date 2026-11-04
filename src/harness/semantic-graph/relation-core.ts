import { createHash } from "node:crypto";
import type { RelationPolicy } from "./relation-types.js";

export function canonical(value: unknown): string {
    if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
        return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    throw new Error("relation identity requires finite JSON values");
}
export function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function textHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
    return value as Record<string, unknown>;
}
export function text(value: unknown): string { if (typeof value !== "string" || !value.trim()) throw new Error("expected nonempty string"); return value; }
export function strings(value: unknown): string[] { if (!Array.isArray(value)) throw new Error("expected string array"); return value.map(text); }
export function integer(value: unknown, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`expected integer ${min}..${max}`);
    return value;
}
export function unique(values: string[], what: string): void { if (new Set(values).size !== values.length) throw new Error(`duplicate ${what}`); }
export function parsePolicy(value: unknown): RelationPolicy {
    const input = record(value);
    if (input.version !== 1 || !Array.isArray(input.invariants) || !Array.isArray(input.scenarios)) throw new Error("invalid relation policy version/arrays");
    const invariants = input.invariants.map(value => {
        const r = record(value);
        if (!Array.isArray(r.groups)) throw new Error("groups must be explicit");
        const groups = r.groups.map(strings);
        for (const group of groups) { integer(group.length, 2, 6); unique(group, "group participant"); }
        const clauses = strings(r.clauses);
        if (!clauses.length) throw new Error("invariant requires clauses");
        return { id: text(r.id), version: text(r.version), statement: text(r.statement), applicability: text(r.applicability), clauses, exceptions: strings(r.exceptions), participants: strings(r.participants), groups, contextFiles: strings(r.contextFiles) };
    });
    unique(invariants.map(r => r.id), "invariant");
    const scenarios = input.scenarios.map(value => {
        const r = record(value);
        const out = { id: text(r.id), version: text(r.version), statement: text(r.statement), applicability: text(r.applicability), invariantId: text(r.invariantId) };
        if (!invariants.some(i => i.id === out.invariantId)) throw new Error("scenario references unknown invariant");
        return out;
    });
    unique(scenarios.map(r => r.id), "scenario");
    return { version: 1, invariants, scenarios };
}
