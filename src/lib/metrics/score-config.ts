import { isJsonObject } from "../json-types.js";
import type { RepositoryInventory } from "./measurement-types.js";
import type { ImportBoundary } from "./adapter-architecture.js";

export interface ScoreContract { kind: "file" | "export" | "script"; path: string; name: string; }
export interface ScoreConfiguration { boundaries: ImportBoundary[]; contracts: ScoreContract[]; entries: string[]; issues: string[]; }

function pathValue(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split(/[\\/]/).includes("..");
}

function boundary(value: unknown): ImportBoundary {
    if (!isJsonObject(value) || !pathValue(value.from) || !pathValue(value.forbidden)) throw new Error("Boundary requires relative from and forbidden paths");
    return { from: value.from, forbidden: value.forbidden };
}

function contract(value: unknown): ScoreContract {
    if (!isJsonObject(value) || !pathValue(value.path)) throw new Error("Contract requires a relative path");
    if (value.kind !== "file" && value.kind !== "export" && value.kind !== "script") throw new Error("Unknown contract kind");
    if (value.kind !== "file" && typeof value.name !== "string") throw new Error("Export/script contract requires name");
    return { kind: value.kind, path: value.path, name: typeof value.name === "string" ? value.name : "" };
}

function list(value: unknown): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("Expected an array");
    return value;
}

function parseConfiguration(content: string): ScoreConfiguration {
    const json: unknown = JSON.parse(content);
    if (!isJsonObject(json) || json.schemaVersion !== 1) throw new Error("Expected schemaVersion: 1");
    const entries = list(json.entries).map(value => {
        if (!pathValue(value)) throw new Error("Entry must be a relative path");
        return value;
    });
    return { boundaries: list(json.boundaries).map(boundary), contracts: list(json.contracts).map(contract), entries, issues: [] };
}

export function readScoreConfiguration(inventory: RepositoryInventory): ScoreConfiguration {
    const empty: ScoreConfiguration = { boundaries: [], contracts: [], entries: [], issues: [] };
    const source = inventory.files.find(file => file.path === "interlinked.metrics.json");
    if (!source) return empty;
    try { return parseConfiguration(source.content); }
    catch (error) { empty.issues.push(error instanceof Error ? error.message : "Invalid scoring configuration"); return empty; }
}
