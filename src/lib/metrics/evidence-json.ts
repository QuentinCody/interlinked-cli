import { isAbsolute, relative, resolve } from "node:path";
import { isJsonObject, type JsonObject } from "../json-types.js";

export function record(value: unknown, label: string): JsonObject {
    if (!isJsonObject(value)) throw new Error(`${label} must be an object`);
    return value;
}
export function textField(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.length) throw new Error(`${label} must be a nonempty string`);
    return value;
}
export function natural(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
    return value;
}
export function stringList(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value.map(item => textField(item, label));
}
export function artifactSourcePath(root: string, value: string): string {
    const path = relative(root, resolve(root, value)).replaceAll("\\", "/");
    if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) throw new Error(`Artifact source outside root: ${value}`);
    return path;
}
export function sourceSpan(value: unknown): { line: number; column: number; endLine: number; endColumn: number } {
    const span = record(value, "location"), start = record(span.start, "start"), end = record(span.end, "end");
    const line = natural(start.line, "start.line"), column = natural(start.column, "start.column");
    const endLine = natural(end.line, "end.line"), endColumn = natural(end.column, "end.column");
    if (!line || endLine < line || (endLine === line && endColumn < column)) throw new Error("Invalid source span");
    return { line, column, endLine, endColumn };
}
