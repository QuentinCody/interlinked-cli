/** Respect smaller absolute NODE_OPTIONS caps; ambiguous overrides cannot certify a bounded heap. */
export function boundedNodeHeap(options: string, ceilingMiB: number): number | null {
    if (!/--max[-_]old[-_]space[-_]size/.test(options)) return ceilingMiB;
    if (/["'\\]/.test(options)) return null;
    const args = options.split(/\s+/);
    let limit = ceilingMiB;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index] ?? "";
        if (/^--max[-_]old[-_]space[-_]size[-_]percentage(?:=|$)/.test(arg)) return null;
        const absolute = /^--max[-_]old[-_]space[-_]size(?:=(.*))?$/.exec(arg);
        if (!absolute) continue;
        const value = absolute[1] ?? args[++index];
        if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) return null;
        limit = Math.min(limit, Number(value));
    }
    return limit;
}
