export interface EnhanceOptions {
  theme: "dark" | "light";
  onCopy?: (ok: boolean) => void;
}

const COPY_FEEDBACK_MS = 1400;
const DIAGRAM_CACHE_SIZE = 32;

let mermaidCounter = 0;

type BindFunctions = (element: Element) => void;

/** One diagram's wait. Open until the diagram renders or fails, or until its enhance() is cleaned up. */
class DiagramGate {
  open = true;
  readonly promise: Promise<void>;
  private release: () => void = () => undefined;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.release();
  }
}

const diagramGates = new WeakMap<HTMLElement, DiagramGate>();

/**
 * The gate enhance() opens for a block. An open gate is reused, so a diagramsSettled() call that
 * started waiting before enhance() ran is released by the same render.
 */
function openGate(block: HTMLElement): DiagramGate {
  const existing = diagramGates.get(block);
  if (existing?.open) return existing;
  const gate = new DiagramGate();
  diagramGates.set(block, gate);
  return gate;
}

/**
 * Resolves once every `.mermaid-block` under `root` has rendered or failed. Resolves at once when
 * there are none, and also when enhance() is cleaned up before a diagram finishes. `timeoutMs` is a
 * safety net for a block that nothing will ever render.
 */
export function diagramsSettled(root: HTMLElement, timeoutMs = 8000): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const block of Array.from(root.querySelectorAll<HTMLElement>(".mermaid-block"))) {
    if (block.classList.contains("is-rendered")) continue;
    let gate = diagramGates.get(block);
    if (!gate) {
      // Nothing has started this block yet. The gate waits for an enhance() that will.
      gate = new DiagramGate();
      diagramGates.set(block, gate);
    }
    if (gate.open) waits.push(gate.promise);
  }
  if (waits.length === 0) return Promise.resolve();

  let timer = 0;
  const timeout = new Promise<void>((resolve) => {
    timer = window.setTimeout(resolve, timeoutMs);
  });
  const all = Promise.all(waits).then(() => undefined);
  return Promise.race([all, timeout]).finally(() => window.clearTimeout(timer));
}

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
  const gates = blocks.map((block) => openGate(block));
  if (blocks.length > 0) {
    void renderMermaid(blocks, gates, opts.theme, () => disposed);
  }

  return () => {
    disposed = true;
    root.removeEventListener("click", onClick);
    for (const timer of copyTimers.values()) window.clearTimeout(timer);
    copyTimers.clear();
    for (const gate of gates) gate.close();
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

interface CachedDiagram {
  id: string;
  svg: string;
  bindFunctions?: BindFunctions;
}

/**
 * Recent renders keyed by theme and source. The reader re-renders every diagram on each edit, so
 * unchanged diagrams skip mermaid. Bounded, least recently used entries go first.
 */
const diagramCache = new Map<string, CachedDiagram>();

function cachedDiagram(key: string): CachedDiagram | undefined {
  const hit = diagramCache.get(key);
  if (hit) {
    diagramCache.delete(key);
    diagramCache.set(key, hit);
  }
  return hit;
}

function rememberDiagram(key: string, entry: CachedDiagram): void {
  diagramCache.delete(key);
  diagramCache.set(key, entry);
  if (diagramCache.size > DIAGRAM_CACHE_SIZE) {
    const oldest = diagramCache.keys().next().value;
    if (oldest !== undefined) diagramCache.delete(oldest);
  }
}

/** Mermaid writes the render id into the svg (root, arrow markers, styles). A cached copy takes the new id so two blocks never share one. */
function withDiagramId(svg: string, from: string, to: string): string {
  if (from === to) return svg;
  return svg.replace(new RegExp(`(?<![\\w-])${from}(?!\\d)`, "g"), to);
}

async function renderMermaid(
  blocks: HTMLElement[],
  gates: DiagramGate[],
  theme: "dark" | "light",
  isDisposed: () => boolean,
): Promise<void> {
  let mermaid: typeof import("mermaid").default;
  try {
    // Loaded only when the document contains a diagram, so the bundle stays out of plain documents.
    mermaid = (await import("mermaid")).default;
  } catch (error) {
    if (isDisposed()) return;
    blocks.forEach((block, i) => {
      showMermaidError(block, `Could not load the diagram renderer: ${describeError(error)}`, block.dataset.source ?? "");
      gates[i].close();
    });
    return;
  }
  if (isDisposed()) return;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
  });

  for (let i = 0; i < blocks.length; i++) {
    if (isDisposed()) return;
    const block = blocks[i];
    const source = block.dataset.source ?? "";
    const key = `${theme}\u0000${source}`;
    const id = `mermaid-${++mermaidCounter}`;
    try {
      const cached = cachedDiagram(key);
      let svg: string;
      let bindFunctions: BindFunctions | undefined;
      if (cached) {
        svg = withDiagramId(cached.svg, cached.id, id);
        bindFunctions = cached.bindFunctions;
      } else {
        const rendered = await mermaid.render(id, source);
        svg = rendered.svg;
        bindFunctions = rendered.bindFunctions;
        rememberDiagram(key, { id, svg, bindFunctions });
      }
      if (isDisposed()) return;
      block.innerHTML = svg;
      bindFunctions?.(block);
      block.classList.add("is-rendered");
      gates[i].close();
    } catch (error) {
      if (isDisposed()) return;
      // Mermaid leaves its scratch element behind when a diagram fails to parse.
      document.getElementById(`d${id}`)?.remove();
      showMermaidError(block, describeError(error), source);
      gates[i].close();
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
