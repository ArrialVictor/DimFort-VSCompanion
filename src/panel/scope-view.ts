/**
 * Scope view — enclosing scopes at the cursor + each scope's declarations.
 *
 * Stable across cursor moves within the same routine, so it sits as
 * its own pane in the multi-view panel. Users can drag it to the
 * bottom panel / secondary sidebar independently of the cursor-pinned
 * Cursor view.
 *
 * Sort mode (line / alphabetic / status) is title-bar-driven: the
 * ``DimFort: Cycle Scope Sort`` command updates
 * ``dimfort.panel.scopeSortMode`` and the config-change listener pushes
 * the new mode here. Replaces the right-click context menu from the
 * legacy single-view panel (whose cursor flicker we deferred to this
 * rework).
 */
import { SectionView } from "./section-view";


export class ScopeView extends SectionView {
  public static readonly viewType = "dimfort.scope";

  protected sectionScript(): string {
    return /* js */ `
let scopeSortMode = getState().scopeSortMode || "line";
let scopeFilterValue = getState().scopeFilter || "";
let lastScopes = [];
let isEmpty = false;
let emptyReason = "";

function revealLine(line, column) {
  if (line) vscodeApi.postMessage({ command: "reveal", line: line, column: column });
}

function statusRank(kind) {
  return kind === "error" ? 0 : kind === "unannotated" ? 1 : 2;
}
function sortScopeVars(vars, mode) {
  const out = vars.slice();
  if (mode === "alphabetic") {
    out.sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  } else if (mode === "status") {
    out.sort((a, b) =>
      (statusRank(a.kind) - statusRank(b.kind)) || (a.line - b.line));
  } else {
    out.sort((a, b) => a.line - b.line);
  }
  return out;
}

function titlecase(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function renderScope(sc, depth) {
  const wrap = document.createElement("div");
  wrap.style.marginLeft = (depth * 12) + "px";
  const head = document.createElement("div");
  head.className = "scope-head";
  head.textContent = titlecase(sc.kind) + ": " + sc.name;
  wrap.appendChild(head);
  const vars = sortScopeVars(sc.vars || [], scopeSortMode);
  if (vars.length === 0) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "  (no declarations)";
    wrap.appendChild(e);
    return wrap;
  }
  const table = document.createElement("table");
  for (const v of vars) {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.title = "Go to declaration (line " + v.line + ")";
    tr.addEventListener("click", () => revealLine(v.line));
    const mark =
      v.kind === "unannotated" ? "\u{1F7E1}" : v.kind === "error" ? "\u{1F534}" : "\u{1F7E2}";
    const normText =
      v.unitNormalized && v.unitNormalized !== v.unit ? v.unitNormalized : "";
    const unitText = v.unit != null ? v.unit : "?";
    const cells = [
      ["line", String(v.line)],
      ["name", v.name],
      ["unit", unitText],
      ["normalized", normText],
      ["mark", mark],
    ];
    for (const [cls, txt] of cells) {
      const td = document.createElement("td");
      let className = cls === "line" ? "line clickable" : cls;
      if (cls === "unit" && (txt === "?" || txt === "-")) {
        className += " muted";
      }
      td.className = className;
      td.textContent = txt;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

function repaint() {
  root.innerHTML = "";
  if (isEmpty) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = emptyReason || "(no active Fortran file)";
    root.appendChild(e);
    return;
  }
  // Filter input
  const filter = document.createElement("input");
  filter.type = "text";
  filter.placeholder = "Filter declarations…";
  filter.className = "filter-input";
  filter.value = scopeFilterValue;
  filter.addEventListener("input", () => {
    scopeFilterValue = filter.value;
    patchState({ scopeFilter: scopeFilterValue });
    refilter();
  });
  root.appendChild(filter);
  const list = document.createElement("div");
  list.id = "scope-list";
  root.appendChild(list);
  refilter();
}

function refilter() {
  const list = document.getElementById("scope-list");
  if (!list) return;
  list.innerHTML = "";
  const q = scopeFilterValue.trim().toLowerCase();
  if (!lastScopes || lastScopes.length === 0) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "(no enclosing scope at cursor)";
    list.appendChild(e);
    return;
  }
  let shown = 0;
  lastScopes.forEach((sc, i) => {
    const all = sc.vars || [];
    const vars = q
      ? all.filter((v) =>
          v.name.toLowerCase().includes(q) ||
          (v.unit && v.unit.toLowerCase().includes(q)))
      : all;
    if (q && vars.length === 0) return;
    shown += vars.length;
    list.appendChild(renderScope({ ...sc, vars: vars }, i));
  });
  if (q && shown === 0) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = '(no variables match "' + scopeFilterValue + '")';
    list.appendChild(e);
  }
}

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.kind === "data") {
    lastScopes = (m.payload && m.payload.scopes) || [];
    isEmpty = !!m.isEmpty;
    repaint();
  } else if (m.kind === "empty") {
    isEmpty = true;
    emptyReason = m.reason || "";
    lastScopes = [];
    repaint();
  } else if (m.kind === "sortModes") {
    if (typeof m.scope === "string") {
      scopeSortMode = m.scope;
      patchState({ scopeSortMode: scopeSortMode });
      refilter();
    }
  }
});
repaint();
`;
  }
}
