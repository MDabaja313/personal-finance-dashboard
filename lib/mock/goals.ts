import { toCents, type Goal } from "@/lib/types";

/** Covers partially-funded, exactly-complete, over-funded (>100%), and far-off cases. */
export const mockGoals: readonly Goal[] = Object.freeze([
  { id: "goal-emergency-fund", name: "Emergency Fund", targetCents: toCents(1500000), savedCents: toCents(975000), targetDate: "2026-12-31" },
  { id: "goal-europe-trip", name: "Europe Trip", targetCents: toCents(500000), savedCents: toCents(500000), targetDate: "2026-10-01" }, // exactly complete
  { id: "goal-car-down-payment", name: "New Car Down Payment", targetCents: toCents(800000), savedCents: toCents(210000), targetDate: "2027-06-01" },
  { id: "goal-home-renovation", name: "Home Renovation", targetCents: toCents(300000), savedCents: toCents(345000) }, // over-funded, no target date
]);
