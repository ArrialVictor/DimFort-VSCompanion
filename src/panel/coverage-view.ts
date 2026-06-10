/**
 * Coverage view — a compact File + Project stats table at the bottom
 * of the activity-bar container.
 *
 * Coexists with the status-bar footer (``CoverageStatusFooter``):
 * the status bar is the always-visible globally-accessible surface;
 * this view is the "footer-of-the-panel" surface for users who want
 * the full breakdown without hovering the status bar item. Users can
 * collapse this view like any other.
 *
 * Click the row → triggers ``DimFort: Refresh Workspace Coverage``.
 */
import { SectionView } from "./section-view";


export class CoverageView extends SectionView {
  public static readonly viewType = "dimfort.coverage";

  protected sectionScript(): string {
    return /* js */ `
let lastStats = null;
let isEmpty = false;

function fmtCount(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

function refresh() { vscodeApi.postMessage({ command: "refresh-workspace" }); }

function repaint() {
  root.innerHTML = "";
  if (isEmpty || !lastStats) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "(no Fortran file active)";
    root.appendChild(e);
    return;
  }
  const s = lastStats;
  if (s.wsRefreshing) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "Refreshing project coverage…";
    root.appendChild(e);
    return;
  }
  const tbl = document.createElement("table");
  tbl.className = "cov-table";

  function row(label, scope) {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.title = "Click to refresh project coverage";
    tr.addEventListener("click", refresh);
    if (!scope) {
      const cells = [
        ["cov-label", label],
        ["cov-pct muted", "–"],
        ["cov-counts muted", "–"],
      ];
      for (const [cls, txt] of cells) {
        const td = document.createElement("td");
        td.className = cls;
        td.textContent = txt;
        tr.appendChild(td);
      }
      return tr;
    }
    const counts = "\u{1F7E2} " + fmtCount(scope.ok)
      + "  \u{1F7E1} " + fmtCount(scope.warn)
      + "  \u{1F534} " + fmtCount(scope.fire);
    const cells = [
      ["cov-label", label],
      ["cov-pct", scope.coveragePct + "%"],
      ["cov-counts", counts],
    ];
    for (const [cls, txt] of cells) {
      const td = document.createElement("td");
      td.className = cls;
      td.textContent = txt;
      tr.appendChild(td);
    }
    return tr;
  }

  tbl.appendChild(row("File", s.file));
  const projRow = row("Project", s.workspace);
  if (s.wsStale && s.workspace) projRow.classList.add("ws-stale");
  tbl.appendChild(projRow);
  root.appendChild(tbl);

  if (s.workspace === null) {
    const hint = document.createElement("div");
    hint.className = "muted cov-hint";
    hint.textContent = "Click a row to compute project coverage.";
    root.appendChild(hint);
  } else if (s.wsStale) {
    const hint = document.createElement("div");
    hint.className = "muted cov-hint";
    hint.textContent = "Project numbers may be stale — click to refresh.";
    root.appendChild(hint);
  }
}

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.kind === "data") {
    lastStats = m.statsSnapshot || null;
    isEmpty = !!m.isEmpty;
    repaint();
  } else if (m.kind === "stats") {
    lastStats = m.stats || null;
    repaint();
  } else if (m.kind === "empty") {
    isEmpty = true;
    repaint();
  }
});
repaint();
`;
  }

  protected onCustomMessage(msg: unknown): void {
    const m = msg as { command?: string };
    if (m?.command === "refresh-workspace") {
      void this.refreshWorkspace();
    }
  }

  /** Set by the extension wire-up so the row click can fire the command. */
  public refreshWorkspace: () => void | Promise<void> = () => { /* set later */ };

  protected extraStyles(): string {
    return `
  .cov-table { width: 100%; border-collapse: collapse; }
  .cov-table td { padding: 0.15em 0.4em 0.15em 0; }
  .cov-label { font-weight: 600; }
  .cov-pct { font-variant-numeric: tabular-nums; text-align: right; }
  .cov-counts { font-variant-numeric: tabular-nums;
    color: var(--vscode-descriptionForeground); }
  .ws-stale .cov-pct, .ws-stale .cov-counts { opacity: 0.55; }
  .cov-hint { margin-top: 0.3em; font-size: 0.9em; }
    `;
  }
}
