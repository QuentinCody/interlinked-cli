export function reportString(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) throw new Error("Incomplete lint diagnostic");
    return value;
}

export function reportLine(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Missing lint source location");
    return value;
}

export function reportArray(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new Error("Invalid lint report array");
    return value;
}
