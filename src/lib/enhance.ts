export interface EnhanceOptions {
  theme: "dark" | "light";
  onCopy?: (ok: boolean) => void;
}

const COPY_FEEDBACK_MS = 1400;

let mermaidCounter = 0;

/**
 * Makes the output of `renderMarkdown` interactive: renders mermaid diagrams and wires the
 * code-block copy buttons. Returns a cleanup function that removes every listener and timer.
 */
export function enhance(root: HTMLElement, opts: EnhanceOptions): () => void {
  let disposed = false;
  const copyTimers = new Map<HTMLButtonElement, number>();

  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest<HTMLButtonElement>(".code-copy");
    if (!button || !root.contains(button)) return;

    const code = button.closest(".code-block")?.querySelector("pre code")?.textContent ?? "";
    void copyToClipboard(code).then((ok) => {
      if (disposed) return;
      showCopyFeedback(button, ok);
      opts.onCopy?.(ok);
    });
  };

  const showCopyFeedback = (button: HTMLButtonElement, ok: boolean) => {
    const pending = copyTimers.get(button);
    if (pending !== undefined) window.clearTimeout(pending);

    button.dataset.copied = ok ? "true" : "false";
    button.textContent = ok ? "Copied" : "Failed";
    const timer = window.setTimeout(() => {
      copyTimers.delete(button);
      delete button.dataset.copied;
      button.textContent = "Copy";
    }, COPY_FEEDBACK_MS);
    copyTimers.set(button, timer);
  };

  root.addEventListener("click", onClick);

  const blocks = Array.from(root.querySelectorAll<HTMLElement>(".mermaid-block"));
  if (blocks.length > 0) {
    void renderMermaid(blocks, opts.theme, () => disposed);
  }

  return () => {
    disposed = true;
    root.removeEventListener("click", onClick);
    for (const timer of copyTimers.values()) window.clearTimeout(timer);
    copyTimers.clear();
  };
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function renderMermaid(blocks: HTMLElement[], theme: "dark" | "light", isDisposed: () => boolean): Promise<void> {
  let mermaid: typeof import("mermaid").default;
  try {
    // Loaded only when the document contains a diagram, so the bundle stays out of plain documents.
    mermaid = (await import("mermaid")).default;
  } catch (error) {
    if (isDisposed()) return;
    for (const block of blocks) {
      showMermaidError(block, `Could not load the diagram renderer: ${describeError(error)}`, block.dataset.source ?? "");
    }
    return;
  }
  if (isDisposed()) return;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
  });

  for (const block of blocks) {
    if (isDisposed()) return;
    const source = block.dataset.source ?? "";
    const id = `mermaid-${++mermaidCounter}`;
    try {
      const { svg, bindFunctions } = await mermaid.render(id, source);
      if (isDisposed()) return;
      block.innerHTML = svg;
      bindFunctions?.(block);
      block.classList.add("is-rendered");
    } catch (error) {
      if (isDisposed()) return;
      // Mermaid leaves its scratch element behind when a diagram fails to parse.
      document.getElementById(`d${id}`)?.remove();
      showMermaidError(block, describeError(error), source);
    }
  }
}

function showMermaidError(block: HTMLElement, message: string, source: string): void {
  const pre = document.createElement("pre");
  pre.className = "mermaid-error";
  pre.textContent = `${message}\n\n${source}`;
  block.replaceChildren(pre);
  block.classList.add("is-rendered");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
