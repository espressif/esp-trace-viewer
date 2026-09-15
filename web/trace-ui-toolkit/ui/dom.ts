/** DOM element construction and manipulation utilities. */

type Props = Record<string, string | number | boolean | EventListener | undefined>;

/**
 * Creates an HTML element configured with attributes, event listeners, and child nodes.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2), v as EventListener);
    } else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

/** Removes all child nodes from a DOM element. */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
