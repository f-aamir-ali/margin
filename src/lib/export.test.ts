// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  buildStandaloneHtml,
  filterAppCss,
  imageMimeType,
  needsKatexCss,
  sizeSkipReason,
} from "./export";
import type { Doc } from "./store";

const MiB = 1024 * 1024;

function sheetRules(css: string): CSSRuleList {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  return style.sheet!.cssRules;
}

function markdownDoc(content: string): Doc {
  return { id: "t", path: null, name: "Note.md", content, saved: content, kind: "markdown", mode: "edit" } as unknown as Doc;
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("needsKatexCss", () => {
  it("is false when the article has no KaTeX output", () => {
    const article = document.createElement("article");
    article.innerHTML = '<p>plain</p><span class="math-error">x</span>';
    expect(needsKatexCss(article)).toBe(false);
  });

  it("is true when the article has KaTeX output", () => {
    const article = document.createElement("article");
    article.innerHTML = '<span class="katex-display"><span class="katex">e</span></span>';
    expect(needsKatexCss(article)).toBe(true);
  });
});

describe("imageMimeType", () => {
  it("accepts an image content-type, with parameters", () => {
    expect(imageMimeType("pic.bin", "image/svg+xml; charset=utf-8")).toBe("image/svg+xml");
  });

  it("falls back to a known image extension when the content-type is generic", () => {
    expect(imageMimeType("photos/IMG_1.JPG", "application/octet-stream")).toBe("image/jpeg");
    expect(imageMimeType("photos/shot.apng", null)).toBe("image/apng");
  });

  it("rejects a non-image file", () => {
    expect(imageMimeType("notes/readme.txt", "text/plain")).toBeNull();
    expect(imageMimeType("clip.mp4", "video/mp4")).toBeNull();
  });

  it("does not treat object properties as extensions", () => {
    expect(imageMimeType("file.constructor", null)).toBeNull();
  });
});

describe("image size limits", () => {
  it("allows an image at exactly the per-image cap", () => {
    expect(sizeSkipReason(MAX_IMAGE_BYTES, 0)).toBeNull();
    expect(sizeSkipReason(MAX_IMAGE_BYTES + 1, 0)).toBe("too-large");
  });

  it("stops once the running total would pass the cap", () => {
    expect(sizeSkipReason(10 * MiB, MAX_TOTAL_IMAGE_BYTES - 10 * MiB)).toBeNull();
    expect(sizeSkipReason(10 * MiB + 1, MAX_TOTAL_IMAGE_BYTES - 10 * MiB)).toBe("over-total-limit");
  });
});

describe("buildStandaloneHtml", () => {
  const KATEX_LINK = "https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.css";

  it("links KaTeX only when the document renders math", async () => {
    const plain = await buildStandaloneHtml(markdownDoc("# Title\n\nNo maths here."));
    expect(plain).not.toContain(KATEX_LINK);

    const withMath = await buildStandaloneHtml(markdownDoc("Euler: $e^{i\\pi}+1=0$"));
    expect(withMath).toContain('class="katex"');
    expect(withMath).toContain(KATEX_LINK);
  });
});

describe("filterAppCss", () => {
  const appCss = `
    :root { --tile: #111; --ink: #eee; --unused: red; color-scheme: dark; }
    :root[data-theme='paper'] { --tile: #fff; --ink: #222; }
    .app-sidebar { color: red; }
    .prose p { color: var(--ink); }
    .katex { font-style: italic; }
    @media print { .prose { max-width: 10in; } .app-toolbar { display: none; } }
    @font-face { font-family: X; src: url(x.woff2); }
    body { background: var(--tile); color: var(--text); }
  `;

  it("keeps content rules, theme tokens in use, and the base body rule", () => {
    const css = filterAppCss(sheetRules(appCss), { math: false });
    expect(css).toContain(".prose p");
    expect(css).toContain("--ink: #eee");
    expect(css).toContain("--tile: #111");
    expect(css).toContain("--ink: #222");
    expect(css).toContain("color-scheme: dark");
    expect(css).toMatch(/body \{[^}]*background/);
    expect(css).toContain("@media print");
    expect(css).toContain("max-width: 10in");
  });

  it("drops app chrome, unused tokens and font files", () => {
    const css = filterAppCss(sheetRules(appCss), { math: false });
    expect(css).not.toContain(".app-sidebar");
    expect(css).not.toContain(".app-toolbar");
    expect(css).not.toContain("--unused");
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("x.woff2");
  });

  it("keeps only the selectors of a list that style the article, without splitting :where()", () => {
    const css = filterAppCss(
      sheetRules(".app-x, .prose :where(h1, h2) { color: red; } .milkdown .ProseMirror p, .prose p { margin: 0; }"),
      { math: false },
    );
    expect(css).toContain(":where(h1, h2)");
    expect(css).not.toContain(".app-x");
    expect(css).not.toContain("milkdown");
    expect(css).toContain(".prose p");
  });

  it("keeps global text selection and export-title styling", () => {
    const css = filterAppCss(sheetRules("::selection { background: red; } .export-title { font-size: 2em; }"), { math: false });
    expect(css).toContain("::selection");
    expect(css).toContain(".export-title");
  });

  it("drops KaTeX rules when the document has no math, and keeps them when it does", () => {
    expect(filterAppCss(sheetRules(appCss), { math: false })).not.toContain(".katex");
    expect(filterAppCss(sheetRules(appCss), { math: true })).toContain(".katex");
  });

  it("keeps the tokens that variables in extra CSS depend on, transitively", () => {
    const css = filterAppCss(
      sheetRules(":root { --a: var(--b); --b: #fff; --c: red; } .app { --x: 1; }"),
      { math: false, extraCss: [".prose { color: var(--a); }"] },
    );
    expect(css).toContain("--a: var(--b)");
    expect(css).toContain("--b: #fff");
    expect(css).not.toContain("--c");
  });
});
