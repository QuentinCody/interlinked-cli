/** Exact dirty-file membership without a V8 hash table per edited file. */
export interface TrigramMembership extends Iterable<number> {
    readonly size: number;
    has(value: number): boolean;
}

export class CompactTrigrams implements TrigramMembership {
    private readonly values: Uint32Array;

    constructor(uniqueValues: ReadonlySet<number>) {
        this.values = Uint32Array.from(uniqueValues).sort();
    }

    get size(): number { return this.values.length; }
    get byteLength(): number { return this.values.byteLength; }
    [Symbol.iterator](): IterableIterator<number> { return this.values.values(); }

    has(value: number): boolean {
        let low = 0, high = this.values.length - 1;
        while (low <= high) {
            const mid = (low + high) >>> 1;
            const candidate = this.values[mid];
            if (candidate === value) return true;
            if (candidate !== undefined && candidate < value) low = mid + 1;
            else high = mid - 1;
        }
        return false;
    }
}
