/**
 * Lane layout tree data model.
 *
 * Defines timeline swimlanes organized into nested groups. Lanes represent typed, reorderable, and resizable visual rows. Groups provide collapsible hierarchy. The consuming application renders each lane type, keeping the layout model serializable as JSON.
 *
 * The tree model is decoupled from rendering. A lane identifies its renderer by a type string and holds an opaque {@link LaneLeaf.source} value interpreted by the application.
 */

/** Unique identifier for a node in the layout tree. */
export type LaneNodeId = string;

/** Schema version embedded in a {@link LaneLayout}, incremented on breaking changes. */
export const LANE_LAYOUT_VERSION = 1;

/**
 * Specification for dynamically populating a {@link LaneGroup} from trace data.
 *
 * Applications define rule types and parameters to add lanes during live capture. The tree model stores the rule identifier and uninterpreted parameters.
 */
export interface AutoPopulateRule {
  /** Rule type identifier interpreted by the application. */
  readonly rule: string;
  /** Rule parameters defined by the application. */
  readonly [param: string]: unknown;
}

/** Visual lane representing a typed, resizable row with application-defined source configuration. */
export interface LaneLeaf {
  readonly kind: "lane";
  readonly id: LaneNodeId;
  /** Lane type identifier resolved by the application registry. */
  readonly type: string;
  /** Application-defined source configuration. */
  readonly source: unknown;
  /** User-defined display label override. */
  readonly label?: string;
  /** Row height in CSS pixels. */
  readonly height?: number;
  /** When true, the lane remains in the tree but is excluded from layout calculations. */
  readonly hidden?: boolean;
}

/** Container group holding child lanes and nested groups with a collapsible header. */
export interface LaneGroup {
  readonly kind: "group";
  readonly id: LaneNodeId;
  readonly label: string;
  readonly children: readonly LaneNode[];
  /** When true, child nodes are excluded from layout and only the group header is rendered. */
  readonly collapsed?: boolean;
  /** When true, the group and all its descendants are excluded from layout. */
  readonly hidden?: boolean;
  /** Rule for dynamically populating child lanes from trace data; see {@link AutoPopulateRule}. */
  readonly auto?: AutoPopulateRule;
}

/** Node in the lane tree, representing either a leaf lane or a group. */
export type LaneNode = LaneLeaf | LaneGroup;

/** Complete lane layout configuration containing a schema version and root nodes. */
export interface LaneLayout {
  readonly version: number;
  readonly roots: readonly LaneNode[];
}

/** Fallback lane height in CSS pixels when no type-specific default is provided. */
export const FALLBACK_LANE_HEIGHT = 22;

/** Returns true if the node is a {@link LaneGroup}. */
export function isGroup(n: LaneNode): n is LaneGroup {
  return n.kind === "group";
}

/** Returns true if the node is a {@link LaneLeaf}. */
export function isLane(n: LaneNode): n is LaneLeaf {
  return n.kind === "lane";
}

/** Serializes a layout to a JSON string. */
export function serializeLayout(layout: LaneLayout): string {
  return JSON.stringify(layout);
}

/**
 * Parses a layout from a JSON string.
 *
 * Returns null if the JSON string is malformed or does not match the schema, allowing callers to fall back to a default layout.
 */
export function parseLayout(text: string): LaneLayout | null {
  try {
    const value: unknown = JSON.parse(text);
    return isLaneLayout(value) ? value : null;
  } catch {
    return null;
  }
}

/** Creates a deep copy of a layout structure. */
export function cloneLayout(layout: LaneLayout): LaneLayout {
  return JSON.parse(JSON.stringify(layout)) as LaneLayout;
}

/** Validates that a value matches the {@link LaneLayout} schema. */
export function isLaneLayout(value: unknown): value is LaneLayout {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { version?: unknown; roots?: unknown };
  if (typeof v.version !== "number") return false;
  return Array.isArray(v.roots) && v.roots.every(isLaneNode);
}

function isLaneNode(value: unknown): value is LaneNode {
  if (typeof value !== "object" || value === null) return false;
  const n = value as { kind?: unknown; id?: unknown };
  if (typeof n.id !== "string") return false;
  if (n.kind === "lane") {
    return typeof (value as { type?: unknown }).type === "string";
  }
  if (n.kind === "group") {
    const g = value as { label?: unknown; children?: unknown };
    return (
      typeof g.label === "string" && Array.isArray(g.children) && g.children.every(isLaneNode)
    );
  }
  return false;
}
