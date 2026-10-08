import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

export function digest(value: unknown): string {
    return createHash("sha256")
        .update(typeof value === "string" ? value : JSON.stringify(value))
        .digest("hex");
}

export function privateDirectory(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function saveImmutable(path: string, value: unknown): void {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    try {
        writeFileSync(path, text, { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        if (readFileSync(path, "utf8") !== text)
            throw new Error(`immutable evidence already exists: ${path}`, { cause: error });
    }
}

export function readJson(path: string): unknown {
    if (statSync(path).size > 32000000)
        throw new Error("JSON artifact exceeds the 32MB read budget");
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new Error(`invalid JSON artifact: ${path}`, { cause: error });
    }
}
