// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PageRenderer } from "../src/plugins/PageRenderer.js";
import { configureClient, resetClientConfigForTests, type RenderInstruction } from "@gl3/client";

afterEach(() => { cleanup(); resetClientConfigForTests(); });
beforeEach(() => {
  configureClient({
    baseUrl: "", wsUrl: "ws://test/ws",
    tokenStore: { get: () => null, set: () => {}, clear: () => {} },
    onGate: () => {},
  });
});

const page = (collapsed: boolean | null): RenderInstruction[] => [
  { kind: "panelHeader", title: "How heat works", layout: null, collapsed },
  { kind: "text", value: "Heat is set by what you hold." },
];

function mount(instructions: RenderInstruction[]): void {
  render(createElement(MemoryRouter, null, createElement(PageRenderer, { instructions })));
}

/**
 * A `collapsed` panel is a native <details>: the title is its <summary> and
 * the body is hidden while closed. `null` keeps the plain <section> every
 * page authored before the field got.
 */
describe("collapsible panels", () => {
  it("collapsed: true renders a closed <details> whose summary is the title", () => {
    mount(page(true));
    const details = screen.getByText("How heat works").closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(screen.getByText("How heat works").tagName).toBe("SUMMARY");
    expect(screen.getByText("Heat is set by what you hold.")).toBeTruthy();
  });

  it("collapsed: false renders the <details> open", () => {
    mount(page(false));
    expect(screen.getByText("How heat works").closest("details")?.open).toBe(true);
  });

  it("null keeps the plain titled section", () => {
    mount(page(null));
    expect(screen.getByText("How heat works").closest("details")).toBeNull();
    expect(screen.getByText("How heat works").tagName).toBe("H2");
  });
});
