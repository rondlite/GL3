import { describe, expect, it } from "vitest";
import { widgetNeedsFrame } from "../src/pages/Dashboard.js";

// A `core.dashboard` widget's view is usually a `panel` carrying the same
// title as the widget; PageRenderer already frames that as a Panel, so the
// dashboard must not wrap it a second time (nested "Crimes > Crimes", seen
// live 2026-09-05). A bare leaf still needs the dashboard's frame.
describe("widgetNeedsFrame", () => {
  it("is false for a panel view — the renderer draws that frame", () => {
    expect(widgetNeedsFrame({ kind: "panel", title: "Crimes", children: [] })).toBe(false);
  });

  it("is true for a bare leaf view", () => {
    expect(widgetNeedsFrame({ kind: "text", value: "hi" })).toBe(true);
  });
});
