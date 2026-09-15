/**
 * Reducer functions for the {@link LaneLayout} tree.
 *
 * Operations produce an updated layout from an existing layout, reusing references for unchanged subtrees. Reducers operate without DOM or storage dependencies and produce JSON-serializable output through {@link ./tree.serializeLayout}.
 *
 * Node operations identify elements by {@link LaneNodeId}. Tree query functions ({@link findNode}, {@link allNodes}, {@link uniqueId}) support hit-testing and identifier allocation.
 */

import {
  isGroup,
  type AutoPopulateRule,
  type LaneGroup,
  type LaneLayout,
  type LaneLeaf,
  type LaneNode,
  type LaneNodeId,
} from "./tree.js";
import { clampLaneHeight, DEFAULT_LANE_METRICS, type LaneMetrics } from "./layout-engine.js";

/** Location of a node within the tree hierarchy: node reference, parent group (or null for root nodes), sibling list, and index. */
export interface NodeLocation {
  readonly node: LaneNode;
  /** Containing parent group, or `null` for root nodes. */
  readonly parent: LaneGroup | null;
  /** List of siblings containing the node (parent's children or root nodes). */
  readonly siblings: readonly LaneNode[];
  /** Index of the node within {@link siblings}. */
  readonly index: number;
}

/** Finds a node by identifier using depth-first search, returning its location or `null` if absent. */
export function findNode(layout: LaneLayout, id: LaneNodeId): NodeLocation | null {
  const search = (nodes: readonly LaneNode[], parent: LaneGroup | null): NodeLocation | null => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.id === id) return { node, parent, siblings: nodes, index: i };
      if (isGroup(node)) {
        const hit = search(node.children, node);
        if (hit) return hit;
      }
    }
    return null;
  };
  return search(layout.roots, null);
}

/** Returns all nodes in the tree in pre-order. */
export function allNodes(layout: LaneLayout): LaneNode[] {
  const out: LaneNode[] = [];
  const walk = (nodes: readonly LaneNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      if (isGroup(n)) walk(n.children);
    }
  };
  walk(layout.roots);
  return out;
}

/** Returns a set containing the node ID and all descendant node IDs. */
function subtreeIds(node: LaneNode): Set<LaneNodeId> {
  const ids = new Set<LaneNodeId>();
  const walk = (n: LaneNode): void => {
    ids.add(n.id);
    if (isGroup(n)) n.children.forEach(walk);
  };
  walk(node);
  return ids;
}

/** Generates an identifier derived from `desired` that does not conflict with existing IDs in `layout`. */
export function uniqueId(layout: LaneLayout, desired: string): LaneNodeId {
  const used = new Set(allNodes(layout).map((n) => n.id));
  if (!used.has(desired)) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Updates the node matching `id` using `fn`, returning a new node list with structural sharing. */
function updateNode(
  nodes: readonly LaneNode[],
  id: LaneNodeId,
  fn: (node: LaneNode) => LaneNode,
): LaneNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (isGroup(n)) {
      const children = updateNode(n.children, id, fn);
      return children === n.children ? n : { ...n, children };
    }
    return n;
  });
}

/** Removes the node matching `id`, returning the pruned node list and the removed node. */
function withoutNode(
  nodes: readonly LaneNode[],
  id: LaneNodeId,
): { nodes: LaneNode[]; removed: LaneNode | null } {
  let removed: LaneNode | null = null;
  const out: LaneNode[] = [];
  for (const n of nodes) {
    if (n.id === id) {
      removed = n;
      continue;
    }
    if (isGroup(n)) {
      const r = withoutNode(n.children, id);
      if (r.removed) removed = r.removed;
      out.push(r.removed ? { ...n, children: r.nodes } : n);
    } else {
      out.push(n);
    }
  }
  return { nodes: out, removed };
}

/** Inserts `node` into `parentId`'s children (or root nodes when `null`) at `index`. */
function insertNode(
  nodes: readonly LaneNode[],
  parentId: LaneNodeId | null,
  node: LaneNode,
  index: number,
): LaneNode[] {
  if (parentId === null) {
    const out = nodes.slice();
    out.splice(clampIndex(index, out.length), 0, node);
    return out;
  }
  return nodes.map((n) => {
    if (!isGroup(n)) return n;
    if (n.id === parentId) {
      const children = n.children.slice();
      children.splice(clampIndex(index, children.length), 0, node);
      return { ...n, children };
    }
    const children = insertNode(n.children, parentId, node, index);
    return children === n.children ? n : { ...n, children };
  });
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || index > length) return length;
  return Math.max(0, index);
}

/** Transforms the children of `parentId` (or root nodes when `null`) using `fn`. */
function mapSiblings(
  layout: LaneLayout,
  parentId: LaneNodeId | null,
  fn: (siblings: readonly LaneNode[]) => LaneNode[],
): LaneLayout {
  if (parentId === null) return { ...layout, roots: fn(layout.roots) };
  return {
    ...layout,
    roots: updateNode(layout.roots, parentId, (g) =>
      isGroup(g) ? { ...g, children: fn(g.children) } : g,
    ),
  };
}

// ── Reducers ────────────────────────────────────────────────────────────────

/**
 * Inserts `node` into `parentId`'s children (or root nodes when `null`) at `index` (defaults to appending).
 * Callers generate `node.id` using {@link uniqueId}.
 */
export function addNode(
  layout: LaneLayout,
  parentId: LaneNodeId | null,
  node: LaneNode,
  index = Infinity,
): LaneLayout {
  return { ...layout, roots: insertNode(layout.roots, parentId, node, index) };
}

/** Removes the node matching `id` and its descendants. Returns the unchanged layout if `id` is absent. */
export function removeNode(layout: LaneLayout, id: LaneNodeId): LaneLayout {
  const { nodes, removed } = withoutNode(layout.roots, id);
  return removed ? { ...layout, roots: nodes } : layout;
}

/**
 * Moves the node matching `id` to `index` within `parentId`'s children (or root nodes when `null`).
 * The target `index` applies after removing the node from its previous location.
 * No-op if the node is absent or if `parentId` is the node itself or a descendant.
 */
export function moveNode(
  layout: LaneLayout,
  id: LaneNodeId,
  parentId: LaneNodeId | null,
  index: number,
): LaneLayout {
  const loc = findNode(layout, id);
  if (!loc) return layout;
  if (parentId !== null && subtreeIds(loc.node).has(parentId)) return layout;

  const { nodes, removed } = withoutNode(layout.roots, id);
  if (!removed) return layout;
  return { ...layout, roots: insertNode(nodes, parentId, removed, index) };
}

/**
 * Moves the node matching `id` to the position immediately preceding `beforeId` within the target parent.
 *
 * No-op if either ID is missing, if IDs match, or if `beforeId` is a descendant of `id`.
 */
export function moveBefore(layout: LaneLayout, id: LaneNodeId, beforeId: LaneNodeId): LaneLayout {
  if (id === beforeId) return layout;
  const moving = findNode(layout, id);
  if (!moving || subtreeIds(moving.node).has(beforeId)) return layout;

  const { nodes: pruned, removed } = withoutNode(layout.roots, id);
  if (!removed) return layout;
  const target = findNode({ ...layout, roots: pruned }, beforeId);
  if (!target) return layout;
  return { ...layout, roots: insertNode(pruned, target.parent?.id ?? null, removed, target.index) };
}

/** Sets an explicit height override for a lane, clamped to minLaneHeight. No-op for groups. */
export function setHeight(
  layout: LaneLayout,
  id: LaneNodeId,
  height: number,
  m: LaneMetrics = DEFAULT_LANE_METRICS,
): LaneLayout {
  return { ...layout, roots: updateNode(layout.roots, id, (n) =>
    isGroup(n) ? n : ({ ...n, height: clampLaneHeight(height, m) } satisfies LaneLeaf)) };
}

/**
 * Clears an explicit height override on a lane, restoring its type default height.
 * No-op for groups or lanes without an explicit height override.
 */
export function resetHeight(layout: LaneLayout, id: LaneNodeId): LaneLayout {
  return { ...layout, roots: updateNode(layout.roots, id, (n) => {
    if (isGroup(n) || n.height === undefined) return n;
    const { height: _drop, ...rest } = n;
    return rest satisfies LaneLeaf;
  }) };
}

/** Sets or toggles the hidden state of a node. */
export function toggleHidden(layout: LaneLayout, id: LaneNodeId, hidden?: boolean): LaneLayout {
  return { ...layout, roots: updateNode(layout.roots, id, (n) => ({
    ...n,
    hidden: hidden ?? !n.hidden,
  })) };
}

/** Sets or toggles the collapsed state of a group. No-op for leaf lanes. */
export function setCollapsed(layout: LaneLayout, id: LaneNodeId, collapsed?: boolean): LaneLayout {
  return { ...layout, roots: updateNode(layout.roots, id, (n) =>
    isGroup(n) ? { ...n, collapsed: collapsed ?? !n.collapsed } : n) };
}

/** Updates the source configuration of a lane. No-op for groups. */
export function setSource(layout: LaneLayout, id: LaneNodeId, source: unknown): LaneLayout {
  return { ...layout, roots: updateNode(layout.roots, id, (n) =>
    isGroup(n) ? n : ({ ...n, source } satisfies LaneLeaf)) };
}

/** Sets the display label of a node. */
export function setLabel(layout: LaneLayout, id: LaneNodeId, label: string): LaneLayout {
  return { ...layout, roots: updateNode(layout.roots, id, (n) => ({ ...n, label })) };
}

/**
 * Groups sibling nodes identified by `ids` into a new group at the position of the first matched node.
 *
 * Selected nodes must share the same parent. IDs that are not siblings of the first matched node are ignored.
 * No-op if no matching nodes are found.
 */
export function groupNodes(
  layout: LaneLayout,
  ids: readonly LaneNodeId[],
  group: { id: LaneNodeId; label: string; collapsed?: boolean; auto?: AutoPopulateRule },
): LaneLayout {
  const first = ids.map((id) => findNode(layout, id)).find((l): l is NodeLocation => l !== null);
  if (!first) return layout;
  const parentId = first.parent?.id ?? null;
  const idSet = new Set(ids);

  return mapSiblings(layout, parentId, (siblings) => {
    const firstIdx = siblings.findIndex((n) => idSet.has(n.id));
    if (firstIdx < 0) return siblings.slice();
    const selected = siblings.filter((n) => idSet.has(n.id));
    const rest = siblings.filter((n) => !idSet.has(n.id));
    const newGroup: LaneGroup = {
      kind: "group",
      id: group.id,
      label: group.label,
      children: selected,
      ...(group.collapsed !== undefined ? { collapsed: group.collapsed } : {}),
      ...(group.auto !== undefined ? { auto: group.auto } : {}),
    };
    rest.splice(firstIdx, 0, newGroup); // firstIdx == count of non-selected before it
    return rest;
  });
}

/**
 * Clears the hidden flag on all nodes in the layout. Returns the unchanged layout if no nodes were hidden.
 */
export function showAll(layout: LaneLayout): LaneLayout {
  let changed = false;
  const clear = (n: LaneNode): LaneNode => {
    let next = n;
    if (isGroup(n)) {
      const children = n.children.map(clear);
      if (children.some((c, i) => c !== n.children[i])) next = { ...n, children };
    }
    if (next.hidden) {
      next = { ...next, hidden: false };
      changed = true;
    }
    return next;
  };
  const roots = layout.roots.map(clear);
  return changed ? { ...layout, roots } : layout;
}

/** Removes a group and moves its child nodes to the group's position within the parent list. No-op for leaf lanes. */
export function ungroup(layout: LaneLayout, groupId: LaneNodeId): LaneLayout {
  const loc = findNode(layout, groupId);
  if (!loc || !isGroup(loc.node)) return layout;
  const parentId = loc.parent?.id ?? null;

  return mapSiblings(layout, parentId, (siblings) => {
    const out: LaneNode[] = [];
    for (const n of siblings) {
      if (n.id === groupId && isGroup(n)) out.push(...n.children);
      else out.push(n);
    }
    return out;
  });
}
