/** Timestamp mappings shared by JSONL readers and the searchable data catalog. */
export interface DataTimeField {
    path: string;
    unit: "iso-or-ms" | "seconds";
}

export const DATA_TIME_FIELDS: readonly DataTimeField[] = [
    "ts", "timestamp", "at", "atMs", "emitted_at", "reconciled_at",
    "measuredAt", "captured_at", "recorded_at",
].map((path) => ({ path, unit: "iso-or-ms" }));

const MAX_DATE_MS = 8_640_000_000_000_000;

function timestampValue(value: unknown, unit: DataTimeField["unit"]): number | undefined {
    let ms: number;
    if (typeof value === "number") {
        ms = unit === "seconds" ? value * 1000 : value;
    } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T| |$)/.test(value)) {
        ms = Date.parse(value);
    } else {
        return undefined;
    }
    return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : undefined;
}

/** No magnitude guessing: numeric epochs use the source's declared unit. */
export function dataTimestampMs(
    record: Record<string, unknown>,
    fields: readonly DataTimeField[] = DATA_TIME_FIELDS,
): number | undefined {
    for (const field of fields) {
        const ms = timestampValue(record[field.path], field.unit);
        if (ms !== undefined) return ms;
    }
    return undefined;
}
