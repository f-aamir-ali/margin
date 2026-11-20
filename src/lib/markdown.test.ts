// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { enhance } from "./enhance";
import { highlight, hljs, listLanguages } from "./hljs";
import { extractHeadings, renderMarkdown, slugify, type RenderOptions } from "./markdown";

const html = (src: string, opts?: RenderOptions): string => renderMarkdown(src, opts).html;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("block structure", () => {
  it("tags a paragraph with its 0-based start line", () => {
    const out = html("Hello\n\nWorld");
    expect(out).toContain('<p data-line="0">Hello</p>');
    expect(out).toContain('<p data-line="2">World</p>');
  });

  it("gives every top-level block a data-line matching its first source line", () => {
    const src = [
      "# Title",
      "",
      "- one",
      "- two",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "> quote",
      "",
      "```js",
      "x",
      "```",
      "",
      "---",
    ].join("\n");
    const out = html(src);
    expect(out).toContain('<h1 id="title" data-line="0">Title</h1>');
    expect(out).toContain('<ul data-line="2">');
    expect(out).toContain('<div class="table-wrap" data-line="5">');
    expect(out).toContain('<blockquote data-line="9">');
    expect(out).toContain('data-lang="js" data-line="11"');
    expect(out).toContain('<hr data-line="15">');
  });

  it("does not put data-line on nested blocks such as list items", () => {
    expect(html("- one\n- two")).not.toMatch(/<li[^>]*data-line/);
  });

  it("keeps line numbers correct after front matter is removed", () => {
    expect(html("---\ntitle: Doc\n---\n\n# Body")).toContain('<h1 id="body" data-line="4">Body</h1>');
  });

  it("returns an empty document for empty input", () => {
    expect(renderMarkdown("")).toEqual({ html: "", headings: [], frontMatter: null });
  });
});

describe("headings and ids", () => {
  it("slugifies the way GitHub does", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("C++ & Rust")).toBe("c--rust");
    expect(slugify("Résumé 2026")).toBe("résumé-2026");
    expect(slugify("  Trim me  ")).toBe("trim-me");
    expect(slugify("a - b")).toBe("a---b");
  });

  it("gives duplicate headings -1, -2 suffixes", () => {
    const { headings } = renderMarkdown("# A\n\n# A\n\n# A");
    expect(headings.map((h) => h.id)).toEqual(["a", "a-1", "a-2"]);
  });

  it("returns the same headings from extractHeadings as renderMarkdown", () => {
    const src = "# Intro\n\ntext\n\n## Intro\n\n### Deep *one*\n";
    expect(extractHeadings(src)).toEqual(renderMarkdown(src).headings);
  });

  it("uses plain text for heading text and ids", () => {
    const { headings } = renderMarkdown("## **Bold** and `code`");
    expect(headings).toEqual([{ level: 2, text: "Bold and code", id: "bold-and-code", line: 0 }]);
  });

  it("puts the id on the heading element", () => {
    expect(html("## Setup steps")).toContain('<h2 id="setup-steps" data-line="0">Setup steps</h2>');
  });

  it("builds a nested [toc] from the headings", () => {
    expect(html("[toc]\n\n# One\n\n## Two\n\n# Three")).toContain(
      '<nav data-line="0" class="toc"><ul><li><a href="#one">One</a><ul><li><a href="#two">Two</a></li></ul></li>' +
        '<li><a href="#three">Three</a></li></ul></nav>',
    );
  });

  it("accepts [[toc]] as well", () => {
    expect(html("[[toc]]\n\n# Only")).toContain(
      '<nav data-line="0" class="toc"><ul><li><a href="#only">Only</a></li></ul></nav>',
    );
  });

  it("keeps heading ids that match document properties, such as Title and Body", () => {
    expect(html("# Title\n\n# Body")).toContain('<h1 id="title" data-line="0">Title</h1>');
    expect(html("# Title\n\n# Body")).toContain('<h1 id="body" data-line="2">Body</h1>');
  });
});

describe("front matter", () => {
  it("strips front matter from the body and returns it raw", () => {
    const result = renderMarkdown("---\ntitle: Hi\ntags: [a, b]\n---\n\n# Body");
    expect(result.frontMatter).toBe("title: Hi\ntags: [a, b]");
    expect(result.html).not.toContain("title:");
    expect(result.headings.map((h) => h.text)).toEqual(["Body"]);
  });

  it("returns null when there is no front matter, and leaves a leading horizontal rule alone", () => {
    const result = renderMarkdown("---\n\nSome text\n\n---\n");
    expect(result.frontMatter).toBeNull();
    expect(result.html).toContain("<hr");
  });

  it("does not treat an unclosed opening rule as front matter", () => {
    const result = renderMarkdown("---\ntitle: x\n\n# Doc");
    expect(result.frontMatter).toBeNull();
    expect(result.html).toContain('<h1 id="doc"');
  });

  it("returns an empty string for an empty front matter block", () => {
    expect(renderMarkdown("---\n---\n# T").frontMatter).toBe("");
  });
});

describe("task lists", () => {
  it("renders enabled checkboxes with data-line, not disabled", () => {
    const out = html("- [ ] open\n- [x] done");
    expect(out).toContain('<input type="checkbox" class="task-checkbox" data-line="0"> open');
    expect(out).toContain('<input type="checkbox" class="task-checkbox" data-line="1" checked=""> done');
    expect(out).not.toContain("disabled");
  });

  it("gives nested task items their own line", () => {
    expect(html("- [ ] parent\n  - [X] child")).toContain('data-line="1" checked');
  });

  it("marks the list and item classes once, even with several task items", () => {
    const out = html("- [ ] a\n- [ ] b\n- [ ] c");
    expect(out).toContain('<ul class="contains-task-list" data-line="0">');
    expect(out).not.toContain("contains-task-list contains-task-list");
  });

  it("leaves a list item that only mentions brackets alone", () => {
    expect(html("- item [x] in the middle")).not.toContain("<input");
  });
});

describe("tables", () => {
  it("wraps tables for horizontal scrolling and keeps column alignment", () => {
    const out = html("| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |");
    expect(out).toContain('<div class="table-wrap" data-line="0"><table>');
    expect(out).toContain('<th style="text-align:left">l</th>');
    expect(out).toContain('<th style="text-align:center">c</th>');
    expect(out).toContain('<td style="text-align:right">3</td>');
    expect(out).toContain("</table></div>");
  });
});

describe("inline and GFM extensions", () => {
  it("renders strikethrough (double and single tilde), mark and superscript", () => {
    const out = html("==hi== ~two words~ ^sup^ ~~gone~~ and `a~b` then ~/home ok");
    expect(out).toContain("<mark>hi</mark>");
    expect(out).toContain("<s>two words</s>");
    expect(out).toContain("<code>a~b</code>");
    expect(out).toContain("~/home ok");
    expect(out).toContain("<sup>sup</sup>");
    expect(out).toContain("<s>gone</s>");
  });

  it("renders definition lists", () => {
    expect(html("Term\n: a definition")).toBe('<dl data-line="0">\n<dt>Term</dt>\n<dd>a definition</dd>\n</dl>\n');
  });

  it("renders footnotes with a reference and a section at the end", () => {
    const out = html("Claim[^1].\n\n[^1]: The source.");
    expect(out).toContain('class="footnote-ref"');
    expect(out).toContain('<section class="footnotes" data-line="2">');
    expect(out).toContain("footnote-backref");
  });

  it("gives the footnote section the line of its first definition", () => {
    expect(html("Claim[^1].\n\nMore text.\n\n[^1]: The source.")).toContain('<section class="footnotes" data-line="4">');
  });

  it("renders GitHub alerts as markdown-alert blocks with a line number", () => {
    const out = html("> [!WARNING]\n> Careful.");
    expect(out).toContain('class="markdown-alert markdown-alert-warning"');
    expect(out).toContain('data-line="0"');
    expect(out).toContain("Careful.");
  });

  it("turns emoji shortcodes into characters unless emoji is off", () => {
    expect(html("Hi :smile:")).toContain("😄");
    expect(html("Hi :smile:", { emoji: false })).toContain(":smile:");
  });

  it("links bare URLs only when linkify is on", () => {
    expect(html("See https://example.com/page")).toContain('href="https://example.com/page"');
    expect(html("See https://example.com/page", { linkify: false })).not.toContain("<a ");
  });

  it("treats a single newline as a space unless breaks is on", () => {
    expect(html("one\ntwo")).not.toContain("<br>");
    expect(html("one\ntwo", { breaks: true })).toContain("<br>");
  });

  it("applies smart quotes only when typographer is on", () => {
    expect(html('say "hi"', { typographer: true })).toContain("“hi”");
    expect(html('say "hi"')).not.toContain("“");
  });

  it("does not leak options between calls that share a parser", () => {
    renderMarkdown("one\ntwo", { breaks: true });
    expect(html("one\ntwo")).not.toContain("<br>");
  });
});

describe("links and images", () => {
  it("opens external links in a new tab and marks them", () => {
    const out = html("[site](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('class="external"');
  });

  it("does not mark relative links or #anchors as external", () => {
    const out = html("[doc](docs/a.md) and [top](#top)");
    expect(out).not.toContain("target=");
    expect(out).toContain('href="#top"');
  });

  it("passes relative link and image URLs through resolveUrl, but not #anchors", () => {
    const resolveUrl = vi.fn((url: string) => `asset://${url}`);
    const out = html("![pic](img/a.png) [doc](docs/a.md) [top](#top)", { resolveUrl });
    expect(out).toContain('src="asset://img/a.png"');
    expect(out).toContain('href="asset://docs/a.md"');
    expect(out).toContain('href="#top"');
    expect(resolveUrl).toHaveBeenCalledWith("img/a.png", "image");
    expect(resolveUrl).toHaveBeenCalledWith("docs/a.md", "link");
    expect(resolveUrl).not.toHaveBeenCalledWith("#top", "link");
  });

  it("lazy-loads images and applies the =WxH size suffix", () => {
    const out = html("![logo](a.png =120x80)");
    expect(out).toContain('<img src="a.png" alt="logo" width="120" height="80" loading="lazy" decoding="async">');
  });

  it("uses the plain text of inline markup as image alt text", () => {
    expect(html("![a *b* c](x.png)")).toContain('alt="a b c"');
  });
});

describe("code", () => {
  it("renders fenced code with the exact code-block markup", () => {
    const out = html("```ts\nconst a = 1;\n```");
    expect(out).toContain(
      '<div class="code-block" data-lang="ts" data-line="0"><div class="code-head"><span class="code-lang">ts</span>' +
        '<button class="code-copy" type="button" aria-label="Copy code">Copy</button></div>' +
        '<pre><code class="hljs language-ts"><span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;</code></pre></div>',
    );
  });

  it("escapes unknown languages as plain text and does not auto-detect", () => {
    const out = html("```nope\n<script>x</script>\n```");
    expect(out).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(out).not.toContain("hljs-");
  });

  it("wraps every line in code-line spans and keeps multi-line spans balanced", () => {
    const out = html("```js\n/* one\ntwo */\nconst a = 1;\n```", { lineNumbers: true });
    const body = out.slice(out.indexOf("<code"), out.indexOf("</code>"));
    expect(body.match(/class="code-line"/g)).toHaveLength(3);
    expect(body.match(/<span/g)?.length).toBe(body.match(/<\/span>/g)?.length);
  });

  it("gives indented code the same code-block markup", () => {
    expect(html("    x = 1")).toContain('<div class="code-block" data-lang="text"');
  });

  it("turns mermaid blocks into placeholders with an escaped source", () => {
    expect(html("```mermaid\ngraph TD; A-->B\n```")).toBe(
      '<div class="mermaid-block" data-source="graph TD; A--&gt;B" data-line="0"></div>\n',
    );
  });

  it("escapes quotes and angle brackets inside mermaid source", () => {
    const out = html('```mermaid\ngraph TD; A["x<y"]-->B\n```');
    expect(out).toContain('data-source="graph TD; A[&quot;x&lt;y&quot;]--&gt;B"');
  });

  it("does not let mermaid source inject markup", () => {
    const out = html('```mermaid\n"></div><img src=x onerror=alert(1)>\n```');
    expect(out).not.toContain("<img");
    expect(out).toContain('data-source="&quot;&gt;&lt;/div&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });
});

describe("math", () => {
  it("renders inline math as KaTeX", () => {
    expect(html("Energy $E=mc^2$")).toContain('class="katex"');
  });

  it("renders $$ blocks as block KaTeX with a line number", () => {
    const out = html("Text\n\n$$\\frac{a}{b}$$");
    expect(out).toContain('<div class="katex-block" data-line="2"><span class="katex-display">');
  });

  it("renders a ```math block as block KaTeX", () => {
    expect(html("```math\n\\int_0^1 x\n```")).toContain('<div class="katex-block" data-line="0"><span class="katex-display">');
  });

  it("renders a math error as a red inline message instead of throwing", () => {
    const out = html("$$\\badcommand$$");
    expect(out).toContain('<span class="math-error" style="color:#c62828"');
    expect(out).toContain("Undefined control sequence");
  });

  it("renders a broken inline formula as a red message", () => {
    const out = html("Broken $\\nope{$ here");
    expect(out).toContain("math-error");
    expect(out).toContain("here");
  });

  it("does not throw on a broken fenced math block", () => {
    expect(() => html("```math\n\\nope{\n```")).not.toThrow();
    expect(html("```math\n\\nope{\n```")).toContain("math-error");
  });

  it("leaves dollar signs as text when math is off", () => {
    const out = html("cost $x^2$ here", { math: false });
    expect(out).toContain("$x^2$");
    expect(out).not.toContain("katex");
  });
});

describe("sanitisation", () => {
  it("removes script tags and inline event handlers", () => {
    const out = html('<script>alert(1)</script><img src="x" onerror="alert(2)">');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onerror");
    expect(out).toContain('<img src="x">');
  });

  it("drops javascript: link targets", () => {
    const out = html("[click](javascript:alert(3))");
    expect(out).not.toMatch(/href="javascript:/i);
  });

  it("removes iframe, object, embed and form elements", () => {
    const out = html('<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x"><form action="/post"><input name="q"></form>');
    expect(out).not.toMatch(/<(iframe|object|embed|form)/i);
  });

  it("escapes raw HTML when html is off", () => {
    const out = html("<b>bold</b>", { html: false });
    expect(out).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(out).not.toContain("<b>");
  });

  it("keeps class and id on raw HTML, with the block's own data-line first", () => {
    const out = html('<div class="keep" id="here">raw</div>');
    expect(out).toContain('<div data-line="0" class="keep" id="here">raw</div>');
  });

  it("keeps asset: and blob: image URLs that resolveUrl returns for local files", () => {
    const out = html("![pic](a.png)", { resolveUrl: () => "asset://localhost/C%3A/notes/a.png" });
    expect(out).toContain('src="asset://localhost/C%3A/notes/a.png"');
    expect(html("![pic](a.png)", { resolveUrl: () => "blob:http://localhost/1" })).toContain('src="blob:');
  });

  it("removes a javascript: URL even when resolveUrl returns one", () => {
    const out = html("![pic](a.png)", { resolveUrl: () => "javascript:alert(1)" });
    expect(out).not.toContain("javascript:");
    expect(out).not.toMatch(/src="javascript/i);
  });
});

describe("performance", () => {
  it("renders a 5,000-line document in under one second", () => {
    const block = [
      "## Section heading",
      "",
      "Some **bold** text with a [link](https://example.com) and `code`, plus ~~old~~ and ==mark==.",
      "",
      "- item one",
      "- item *two*",
      "  - nested item",
      "",
      "| col a | col b |",
      "|:-----|------:|",
      "| 1 | 2 |",
      "",
      "```ts",
      "const x: number = 1;",
      "```",
      "",
    ].join("\n");
    const countLines = (text: string) => (text.match(/\n/g) ?? []).length;
    const doc = block.repeat(Math.ceil(5000 / countLines(block)));
    expect(countLines(doc)).toBeGreaterThanOrEqual(5000);

    const started = performance.now();
    const result = renderMarkdown(doc);
    const elapsed = performance.now() - started;

    expect(result.headings.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("hljs", () => {
  it("returns null for unknown languages and never auto-detects", () => {
    expect(highlight("const a = 1", "not-a-language")).toBeNull();
    expect(highlight("const a = 1", "")).toBeNull();
  });

  it("resolves the common aliases", () => {
    for (const lang of ["ts", "tsx", "js", "jsx", "py", "rs", "sh", "shell", "toml", "yml", "html", "ps1", "md"]) {
      expect(highlight("x", lang), lang).not.toBeNull();
    }
  });

  it("exports the configured core instance with only the bundled languages", () => {
    expect(hljs.getLanguage("typescript")).toBeTruthy();
    expect(hljs.getLanguage("cobol")).toBeFalsy();
  });

  it("lists registered language names, sorted", () => {
    const names = listLanguages();
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(["typescript", "rust", "python", "plaintext", "latex"]));
  });
});

describe("enhance", () => {
  function setup(): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html("```ts\nconst a = 1;\n```");
    document.body.appendChild(root);
    return root;
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it("copies the code text, shows Copied, and restores the label after 1400 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onCopy = vi.fn();
    const root = setup();
    const cleanup = enhance(root, { theme: "dark", onCopy });

    const button = root.querySelector<HTMLButtonElement>(".code-copy")!;
    button.click();
    await flush();

    expect(writeText).toHaveBeenCalledWith("const a = 1;");
    expect(button.textContent).toBe("Copied");
    expect(button.dataset.copied).toBe("true");
    expect(onCopy).toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(1400);
    expect(button.textContent).toBe("Copy");
    expect(button.dataset.copied).toBeUndefined();

    cleanup();
    root.remove();
  });

  it("reports a failed copy with onCopy(false)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    const onCopy = vi.fn();
    const root = setup();
    const cleanup = enhance(root, { theme: "light", onCopy });

    root.querySelector<HTMLButtonElement>(".code-copy")!.click();
    await flush();

    expect(onCopy).toHaveBeenCalledWith(false);
    expect(root.querySelector(".code-copy")!.textContent).toBe("Failed");

    cleanup();
    root.remove();
  });

  it("shows a broken mermaid diagram as an inline error with its source", async () => {
    const root = document.createElement("div");
    root.innerHTML = html("```mermaid\ngraph TD; A-->\n```");
    document.body.appendChild(root);
    const cleanup = enhance(root, { theme: "light" });

    await vi.waitFor(
      () => expect(root.querySelector(".mermaid-block")?.classList.contains("is-rendered")).toBe(true),
      { timeout: 20000 },
    );
    const error = root.querySelector("pre.mermaid-error");
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain("graph TD; A-->");

    cleanup();
    root.remove();
  }, 30000);

  it("removes its click listener on cleanup", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const root = setup();
    const cleanup = enhance(root, { theme: "dark" });
    cleanup();

    root.querySelector<HTMLButtonElement>(".code-copy")!.click();
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    root.remove();
  });
});
