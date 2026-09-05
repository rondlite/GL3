import { describe, expect, it } from "vitest";
import type { PlayerAttributesDto } from "@gl3/shared";
import { attributeTiles } from "../src/pages/Stats.js";

const attributes: PlayerAttributesDto = {
  energy: 5, energyMax: 12, will: 80, willMax: 100, brave: 3, braveMax: 5,
  level: 4,
  strength: "1234", agility: "56", guard: "7", labour: "0", iq: "9001", crimeExp: "42",
  energyRegenAt: null, willRegenAt: null, braveRegenAt: null,
};

// The pools already have bars in the HUD; the stats page is where the
// trained stats, IQ and crime exp become visible at all (found live
// 2026-09-05: agility only appeared on the gym page, IQ and crime exp nowhere).
describe("attributeTiles", () => {
  it("lists level, the four trained stats, IQ and crime exp in that order", () => {
    expect(attributeTiles(attributes).map((t) => t.label)).toEqual([
      "Level", "Strength", "Agility", "Guard", "Labour", "IQ", "Crime exp",
    ]);
  });

  it("carries each figure through as its wire string, untouched", () => {
    const byLabel = Object.fromEntries(attributeTiles(attributes).map((t) => [t.label, t.value]));
    expect(byLabel).toEqual({
      Level: "4", Strength: "1234", Agility: "56", Guard: "7", Labour: "0", IQ: "9001", "Crime exp": "42",
    });
  });
});
