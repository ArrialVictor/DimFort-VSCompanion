/**
 * Wire-format mirrors of the server's ``dimfort/panelInfo`` /
 * ``dimfort/interactions`` payloads + the shared types the panel views
 * pass around. Kept apart from the view classes so each view file only
 * imports the data shapes it actually uses.
 *
 * See ``docs/design/shipped/panel-info.md`` /
 * ``docs/design/shipped/interaction-points.md`` in the server repo
 * for the authoritative wire-format definitions.
 */
export interface ExpressionNode {
  label: string;
  unit: string | null;
  marker: "ok" | "warn" | "error";
  // The formal unit this node was expected to satisfy, only set on a
  // call-argument row whose actual dimensionally differs from the
  // formal. Renderers append `(expected <expected>)` to the row.
  expected: string | null;
  // Sibling-arg partner list for an H020 (polymorphic call-site
  // unification failure) row, e.g. "arg 2" or "arg 1, arg 3". When
  // set, the renderer appends `(collides with <collides>)` to the
  // row tail — parallel to `(expected …)` but using the spec's
  // distinct wording for the polymorphism conflict path. Null on
  // every non-H020 row. Server omits the field on pre-0.2.3.1
  // payloads; treat absent as null.
  collides?: string | null;
  children: ExpressionNode[];
}

export interface ScopeVar {
  name: string;
  unit: string | null;
  unitNormalized: string | null;
  line: number;
  kind: "annotated" | "unannotated" | "error";
}

export interface ScopeSection {
  name: string;
  kind: string;
  vars: ScopeVar[];
}

export interface ImportVar {
  name: string;
  unit: string | null;
  unitNormalized: string | null;
  module: string;
  kind: "annotated" | "unannotated";
  file?: string;
  line: number;
  column: number;
  callable?: boolean;
  signature?: string;
}

export interface PanelDiagnostic {
  severity: "error" | "warning" | "info" | "hint";
  code: string;
  message: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface PanelInfo {
  expression: ExpressionNode | null;
  scopes: ScopeSection[];
  imports?: ImportVar[];
  diagnostics?: PanelDiagnostic[];
  fileDiagnosticCounts?: { error: number; warning: number; info?: number; hint?: number };
  scope?: { name: string; kind: string } | null;
  scopeVars?: ScopeVar[];
  routine?: { name: string; kind: string } | null;
  routineVars?: ScopeVar[];
}

export interface InteractionPoint {
  file: string;
  line: number;
  column: number;
  scope: string | null;
  kind: "declares" | "contributes" | "requires" | "uses";
  unit: string;
  snippet: string;
}

export interface InteractionConflict {
  code: string;
  message: string;
  file: string;
  line: number;
  column: number;
  site: InteractionPoint;
  reference: InteractionPoint;
}

export interface InteractionsReport {
  symbol: string;
  points: InteractionPoint[];
  conflicts: InteractionConflict[];
  hasConflict: boolean;
}

export type SortMode = "line" | "alphabetic" | "status";

/** Snapshot the coordinator broadcasts to all subscribed views. */
export interface PanelPayload {
  payload: PanelInfo;
  actions: string[];
  interactions: InteractionsReport | null;
  /** Stats footer snapshot (per-file + workspace coverage). */
  statsSnapshot: unknown;
}
