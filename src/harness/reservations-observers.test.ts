import { expect, it, vi } from "vitest";
import { CohortManager } from "./cohort.js";
import { ReservationManager } from "./reservations.js";

it("notifies coverage observers after a grant and permits unsubscribe", () => {
    const reservations = new ReservationManager(), cohort = new CohortManager();
    const observer = vi.fn(() => reservations.getForAgent("writer").length);
    const unsubscribe = reservations.onChange(observer);
    reservations.checkAndReserve("/repo/a.ts", "writer", cohort);
    expect(observer).toHaveReturnedWith(1);
    unsubscribe();
    reservations.checkAndReserve("/repo/b.ts", "writer", cohort);
    expect(reservations.getForAgent("writer")).toHaveLength(2);
    expect(observer).toHaveBeenCalledTimes(1);
});

it("isolates a failing observer from ownership and later observers", () => {
    const reservations = new ReservationManager(), observer = vi.fn();
    reservations.onChange(() => { throw new Error("observer unavailable"); });
    reservations.onChange(observer);
    expect(reservations.checkAndReserve("/repo/a.ts", "writer", new CohortManager())).toBeNull();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(reservations.getForAgent("writer")).toHaveLength(1);
});
