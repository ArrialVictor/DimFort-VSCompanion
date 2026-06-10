/**
 * Imports view — variables + procedures the cursor's enclosing scope
 * brings in via ``use`` clauses, grouped by source module.
 *
 * Each row is clickable: jumps to the imported symbol's declaration —
 * cross-file when the server payload carries ``file``, otherwise the
 * local file. Module headers stay in source ``use``-clause order
 * regardless of the within-group sort mode.
 *
 * Sort mode (line / alphabetic / status) shares the same title-bar
 * cycle pattern as the Scope view: ``DimFort: Cycle Imports Sort``
 * updates ``dimfort.panel.importsSortMode`` and the config-change
 * listener re-broadcasts. Three menu entries with mode-aware icons
 * (``list-ordered`` / ``case-sensitive`` / ``symbol-color``) so the
 * active mode is visible at a glance.
 */
import { SectionView } from "./section-view";


export class ImportsView extends SectionView {
  public static readonly viewType = "dimfort.imports";

  protected sectionScript(): string {
    return /* js */ `
let importsSortMode = getState().importsSortMode || "line";
let importsFilterValue = getState().importsFilter || "";
let unitDisplay = getState().unitDisplay || "canonical";
let lastImports = [];
let isEmpty = false;
let emptyReason = "";

function revealAt(file, line, column) {
  if (line) vscodeApi.postMessage({ command: "reveal", file: file, line: line, column: column });
}

function baseName(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function sortImportsList(vars, mode) {
  const out = vars.slice();
  if (mode === "alphabetic") {
    out.sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  } else if (mode === "status") {
    out.sort((a, b) =>
      ((a.kind === "unannotated" ? 0 : 1) - (b.kind === "unannotated" ? 0 : 1)) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  } else {
    out.sort((a, b) => (a.line || 0) - (b.line || 0));
  }
  return out;
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
  const filter = document.createElement("input");
  filter.type = "text";
  filter.placeholder = "Filter imports…";
  filter.className = "filter-input";
  filter.value = importsFilterValue;
  filter.addEventListener("input", () => {
    importsFilterValue = filter.value;
    patchState({ importsFilter: importsFilterValue });
    renderList();
  });
  root.appendChild(filter);
  const list = document.createElement("div");
  list.id = "imports-list";
  root.appendChild(list);
  renderList();
}

function renderList() {
  const list = document.getElementById("imports-list");
  if (!list) return;
  list.innerHTML = "";
  const q = importsFilterValue.trim().toLowerCase();
  const imports = q
    ? lastImports.filter((im) =>
        im.name.toLowerCase().includes(q) ||
        (im.unit && im.unit.toLowerCase().includes(q)) ||
        (im.module && im.module.toLowerCase().includes(q)))
    : lastImports;
  if (!imports.length) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = q && lastImports.length
      ? '(no imports match "' + importsFilterValue + '")'
      : "(none)";
    list.appendChild(e);
    return;
  }
  // Bucket imports by source module in first-seen order so the module
  // headers stay in 'use'-clause order regardless of sort mode (the
  // sort applies WITHIN each group, not across them).
  const byModule = {};
  const moduleOrder = [];
  for (const im of imports) {
    if (!byModule[im.module]) {
      byModule[im.module] = [];
      moduleOrder.push(im.module);
    }
    byModule[im.module].push(im);
  }
  for (const mod of moduleOrder) {
    const head = document.createElement("div");
    head.className = "scope-head";
    head.textContent = "from " + mod;
    list.appendChild(head);
    const table = document.createElement("table");
    table.style.marginLeft = "14px";
    const sortedItems = sortImportsList(byModule[mod], importsSortMode);
    for (const im of sortedItems) {
      const tr = document.createElement("tr");
      tr.className = "clickable";
      tr.title = "Go to declaration"
        + (im.file ? " (" + baseName(im.file) + ":" + im.line + ")" : "");
      tr.addEventListener("click", () =>
        im.file ? revealAt(im.file, im.line, im.column)
                : revealAt(undefined, im.line, im.column));
      const mark = im.kind === "unannotated" ? "\u{1F7E1}" : "\u{1F7E2}";
      const inputUnit = im.unit != null ? im.unit
        : (im.callable && im.kind === "annotated" ? "-" : "?");
      const canonicalUnit = im.unitNormalized || inputUnit;
      const cells = [
        ["name", im.callable ? im.name + (im.signature || "()") : im.name],
      ];
      if (unitDisplay === "input") {
        cells.push(["unit", inputUnit]);
      } else if (unitDisplay === "canonical") {
        cells.push(["unit", canonicalUnit]);
      } else {
        const normText =
          im.unitNormalized && im.unitNormalized !== im.unit ? im.unitNormalized : "";
        cells.push(["unit", inputUnit]);
        cells.push(["normalized", normText]);
      }
      cells.push(["mark", mark]);
      for (const [cls, txt] of cells) {
        const td = document.createElement("td");
        let className = cls;
        if (cls === "unit" && (txt === "?" || txt === "-")) {
          className += " muted";
        }
        td.className = className;
        td.textContent = txt;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    list.appendChild(table);
  }
}

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.kind === "data") {
    lastImports = (m.payload && m.payload.imports) || [];
    isEmpty = !!m.isEmpty;
    repaint();
  } else if (m.kind === "empty") {
    isEmpty = true;
    emptyReason = m.reason || "";
    lastImports = [];
    repaint();
  } else if (m.kind === "sortModes") {
    if (typeof m.imports === "string") {
      importsSortMode = m.imports;
      patchState({ importsSortMode: importsSortMode });
      renderList();
    }
  } else if (m.kind === "unitDisplay") {
    if (typeof m.mode === "string") {
      unitDisplay = m.mode;
      patchState({ unitDisplay: unitDisplay });
      renderList();
    }
  }
});
repaint();
`;
  }
}
