export interface BinaryObservation {
    probability: number;
    positive: boolean;
}
export interface ReliabilityBin {
    low: number;
    high: number;
    count: number;
    meanProbability: number | null;
    positiveRate: number | null;
}
export interface BinaryStatistics {
    count: number;
    positives: number;
    brier: number | null;
    auc: number | null;
    ece: number | null;
    bins: ReliabilityBin[];
}

function auc(observations: BinaryObservation[]): number | null {
    const positives = observations.filter((row) => row.positive);
    const negatives = observations.filter((row) => !row.positive);
    if (!positives.length || !negatives.length) return null;
    let wins = 0;
    for (const a of positives)
        for (const b of negatives)
            wins +=
                a.probability > b.probability ? 1 : Number(a.probability === b.probability) * 0.5;
    return wins / (positives.length * negatives.length);
}

export function binaryStatistics(observations: BinaryObservation[]): BinaryStatistics {
    if (
        observations.some(
            (row) =>
                !Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1,
        )
    )
        throw new Error("invalid probability in audit");
    const bins = Array.from({ length: 10 }, (_, i): ReliabilityBin => {
        const members = observations.filter(
            (row) => Math.min(9, Math.floor(row.probability * 10)) === i,
        );
        return {
            low: i / 10,
            high: (i + 1) / 10,
            count: members.length,
            meanProbability: members.length
                ? members.reduce((sum, row) => sum + row.probability, 0) / members.length
                : null,
            positiveRate: members.length
                ? members.filter((row) => row.positive).length / members.length
                : null,
        };
    });
    return {
        count: observations.length,
        positives: observations.filter((row) => row.positive).length,
        brier: observations.length
            ? observations.reduce(
                  (sum, row) => sum + (row.probability - Number(row.positive)) ** 2,
                  0,
              ) / observations.length
            : null,
        auc: auc(observations),
        ece: observations.length
            ? bins.reduce(
                  (sum, bin) =>
                      sum +
                      bin.count * Math.abs((bin.meanProbability ?? 0) - (bin.positiveRate ?? 0)),
                  0,
              ) / observations.length
            : null,
        bins,
    };
}

export interface LogisticHead {
    version: "logistic-v1";
    mean: number[];
    scale: number[];
    weights: number[];
    intercept: number;
}

function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, x))));
}

export function predictLogistic(head: LogisticHead, vector: number[]): number {
    if (vector.length !== head.weights.length || vector.some((n) => !Number.isFinite(n)))
        throw new Error("invalid linear-head features");
    return sigmoid(
        head.intercept +
            vector.reduce(
                (sum, value, i) =>
                    sum + (head.weights[i]! * (value - head.mean[i]!)) / head.scale[i]!,
                0,
            ),
    );
}

function gradientStep(head: LogisticHead, xs: number[][], ys: boolean[]): void {
    const gradients = head.weights.map(() => 0);
    let intercept = 0;
    for (const [index, x] of xs.entries()) {
        const error = predictLogistic(head, x) - Number(ys[index]);
        intercept += error;
        for (let i = 0; i < gradients.length; i++)
            gradients[i]! += (error * (x[i]! - head.mean[i]!)) / head.scale[i]!;
    }
    head.intercept -= (0.1 * intercept) / xs.length;
    for (let i = 0; i < gradients.length; i++)
        head.weights[i]! -= 0.1 * (gradients[i]! / xs.length + 0.01 * head.weights[i]!);
}

export function fitLogistic(xs: number[][], ys: boolean[]): LogisticHead {
    const dimension = xs[0]?.length ?? 0;
    if (
        !xs.length ||
        !dimension ||
        xs.length !== ys.length ||
        xs.some((x) => x.length !== dimension || x.some((n) => !Number.isFinite(n)))
    )
        throw new Error("invalid training cohort");
    const mean = Array.from(
        { length: dimension },
        (_, i) => xs.reduce((sum, x) => sum + x[i]!, 0) / xs.length,
    );
    const scale = mean.map(
        (value, i) =>
            Math.sqrt(xs.reduce((sum, x) => sum + (x[i]! - value) ** 2, 0) / xs.length) || 1,
    );
    const head: LogisticHead = {
        version: "logistic-v1",
        mean,
        scale,
        weights: Array<number>(dimension).fill(0),
        intercept: 0,
    };
    for (let iteration = 0; iteration < 300; iteration++) gradientStep(head, xs, ys);
    return head;
}
