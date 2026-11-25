// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));

import { diagramsSettled, enhance } from "./enhance";

function renderLikeMermaid(id: string) {
  return Promise.resolve({ svg: `<svg id="${id}"><marker id="${id}-arrow"></marker></svg>` });
}

function makeRoot(...sources: string[]): HTMLElement {
  const root = document.createElement("div");
  for (const source of sources) {
    const block = document.createElement("div");
    block.className = "mermaid-block";
    block.dataset.source = source;
    root.appendChild(block);
  }
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  mermaid.render.mockReset();
  mermaid.render.mockImplementation(renderLikeMermaid);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("diagramsSettled", () => {
  it("resolves at once when there are no diagrams", async () => {
    const root = makeRoot();
    await expect(diagramsSettled(root, 60_000)).resolves.toBeUndefined();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("resolves only after every diagram has rendered", async () => {
    const root = makeRoot("graph TD; A-->B", "graph TD; C-->D");
    const cleanup = enhance(root, { theme: "light" });

    await diagramsSettled(root, 60_000);

    expect(root.querySelectorAll(".mermaid-block.is-rendered")).toHaveLength(2);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("resolves when a diagram fails, showing the error inline", async () => {
    mermaid.render.mockRejectedValueOnce(new Error("Parse error on line 1"));
    const root = makeRoot("graph TD; A-->");
    const cleanup = enhance(root, { theme: "dark" });

    await diagramsSettled(root, 60_000);

    expect(root.querySelector("pre.mermaid-error")?.textContent).toContain("Parse error on line 1");
    cleanup();
  });

  it("resolves when enhance() is cleaned up before a diagram finishes", async () => {
    mermaid.render.mockImplementation(() => new Promise(() => undefined));
    const root = makeRoot("graph TD; never-finishes");
    const cleanup = enhance(root, { theme: "light" });

    const settled = diagramsSettled(root, 60_000);
    cleanup();

    await expect(settled).resolves.toBeUndefined();
  });

  it("falls back to the timeout when nothing ever renders the block", async () => {
    const root = makeRoot("graph TD; A-->B");
    const started = Date.now();

    await diagramsSettled(root, 50);

    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(root.querySelector(".mermaid-block")?.classList.contains("is-rendered")).toBe(false);
  });

  it("reuses a cached render for the same source and theme, with a fresh id", async () => {
    const source = "graph TD; cache-me-1-->B";
    const first = makeRoot(source);
    const cleanupFirst = enhance(first, { theme: "dark" });
    await diagramsSettled(first, 60_000);
    const renders = mermaid.render.mock.calls.length;

    const second = makeRoot(source);
    const cleanupSecond = enhance(second, { theme: "dark" });
    await diagramsSettled(second, 60_000);

    expect(mermaid.render).toHaveBeenCalledTimes(renders);
    const svg = second.querySelector("svg")!;
    expect(svg.id).not.toBe(first.querySelector("svg")!.id);
    expect(svg.innerHTML).toContain(`${svg.id}-arrow`);
    expect(svg.innerHTML).not.toContain(first.querySelector("svg")!.id);

    cleanupFirst();
    cleanupSecond();
  });

  it("renders again when the theme changes", async () => {
    const source = "graph TD; theme-change-A-->B";
    const light = makeRoot(source);
    const cleanupLight = enhance(light, { theme: "light" });
    await diagramsSettled(light, 60_000);
    const renders = mermaid.render.mock.calls.length;

    const dark = makeRoot(source);
    const cleanupDark = enhance(dark, { theme: "dark" });
    await diagramsSettled(dark, 60_000);

    expect(mermaid.render).toHaveBeenCalledTimes(renders + 1);
    cleanupLight();
    cleanupDark();
  });
});
