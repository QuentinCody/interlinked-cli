import { expect, it } from "vitest";
import { binaryStatistics, fitLogistic, predictLogistic } from "./statistics.js";

it("calculates Brier, reliability bins, and tied AUC from saved probabilities", () => {
    const stats = binaryStatistics([
        { probability: 0.1, positive: false },
        { probability: 0.9, positive: true },
    ]);
    expect(stats.brier).toBeCloseTo(0.01);
    expect(stats.auc).toBe(1);
    expect(stats.ece).toBeCloseTo(0.1);
    expect(
        binaryStatistics([
            { probability: 0.5, positive: false },
            { probability: 0.5, positive: true },
        ]).auc,
    ).toBe(0.5);
    expect(binaryStatistics([{ probability: 0, positive: false }]).auc).toBeNull();
    expect(binaryStatistics([]).brier).toBeNull();
});

it("fits a training-only head and handles constant features", () => {
    const head = fitLogistic(
        [
            [0, 1],
            [1, 1],
            [2, 1],
            [3, 1],
        ],
        [false, false, true, true],
    );
    expect(predictLogistic(head, [3, 1])).toBeGreaterThan(predictLogistic(head, [0, 1]));
    expect(() => predictLogistic(head, [1])).toThrow();
});
