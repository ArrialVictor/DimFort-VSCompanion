import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";

// Wire-format mirror of the server's dimfort/coverageStats response.
// See DimFort/docs/design/future/coverage-visualization.md §8.2.
interface StatsRow {
  uri: string;
  ok: number;
  warn: number;
  fire: number;
  unparsed: number;
  out: number;
  coverage_pct: number;
}
interface StatsTotal {
  ok: number;
  warn: number;
  fire: number;
  unparsed: number;
  out: number;
  coverage_pct: number;
}
interface StatsResponse {
  scope: "file" | "workspace";
  uri?: string;
  files: StatsRow[];
  total: StatsTotal;
}

// Companion-side rendering shape consumed by the panel webview footer.
// Fields use camelCase to match the surrounding TS style; the snake_case
// `coverage_pct` from the server is renamed on the boundary.
export interface FileCoverage {
  ok: number;
  warn: number;
  fire: number;
  unparsed: number;
  coveragePct: number;
}
export interface WorkspaceCoverage {
  ok: number;
  warn: number;
  fire: number;
  unparsed: number;
  coveragePct: number;
}
export interface StatsSnapshot {
  file: FileCoverage | null;
  workspace: WorkspaceCoverage | null;
  wsStale: boolean;
}

// Workspace-scope refresh debounce. The server already debounces
// `didChange` at ~400 ms before re-checking, and the diagnostic-change
// signal fires every time a fresh result is published — i.e. up to
// ~2.5×/s during active typing. Without a companion-side debounce on
// the workspace-scoped stats call, every keystroke session would
// re-aggregate the whole workset. Spec §8.3.3.
const WS_DEBOUNCE_MS = 2000;

/**
 * Drives the panel stats bar. Owns:
 *   - File-scope stats cache keyed by URI (refreshed live on diagnostic change).
 *   - Workspace-scope stats cache (refreshed on a 2 s debounce per spec).
 *   - The `wsStale` flag that lets the panel render the WS segment in a
 *     muted foreground between a diagnostic-change signal and the
 *     arrival of the corresponding `dimfort/coverageStats` response.
 *
 * Fires `onDidChange` whenever any of those shifts; the panel
 * subscribes and re-renders its footer.
 *
 * The server-side cache (keyed by `WorksetResult` identity) keeps
 * repeat calls for the same result O(1); this provider does not
 * cache aggressively beyond holding the latest snapshot.
 */
export class CoverageStatsProvider implements vscode.Disposable {
  private client: LanguageClient | undefined;
  private readonly fileStats = new Map<string, FileCoverage>();
  private workspace: WorkspaceCoverage | null = null;
  private wsStale = false;
  private wsDebounceTimer: NodeJS.Timeout | undefined;
  private wsRequestSeq = 0;
  private fileRequestSeq = new Map<string, number>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(this.handleDiagChange.bind(this)),
      vscode.window.onDidChangeActiveTextEditor(() => {
        // Active editor changed: emit so the bar shows the new file's
        // numbers (or "—" if we haven't fetched them yet). Then fetch.
        this.emitter.fire();
        void this.refreshActiveFile();
      }),
    );
  }

  setClient(client: LanguageClient | undefined): void {
    this.client = client;
    this.fileStats.clear();
    this.workspace = null;
    this.wsStale = false;
    this.emitter.fire();
    if (client) {
      // Kick off both scopes so the bar populates after activation
      // without waiting for the first edit.
      void this.refreshActiveFile();
      this.scheduleWorkspaceRefresh();
    }
  }

  snapshot(uri: string | undefined): StatsSnapshot {
    return {
      file: uri ? this.fileStats.get(uri) ?? null : null,
      workspace: this.workspace,
      wsStale: this.wsStale,
    };
  }

  private handleDiagChange(event: vscode.DiagnosticChangeEvent): void {
    // File-scope: refresh stats for affected URIs we care about (active
    // editor first; cached entries for other URIs are dropped so the
    // next request for them refetches).
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    let activeAffected = false;
    for (const uri of event.uris) {
      const s = uri.toString();
      if (s === active) {
        activeAffected = true;
      } else if (this.fileStats.has(s)) {
        this.fileStats.delete(s);
      }
    }
    if (activeAffected && active) {
      void this.refreshFile(active);
    }
    // Workspace-scope: any diagnostic change makes WS stale and
    // schedules a debounced refetch.
    this.wsStale = true;
    this.scheduleWorkspaceRefresh();
    this.emitter.fire();
  }

  private async refreshActiveFile(): Promise<void> {
    const active = vscode.window.activeTextEditor;
    if (!active || active.document.languageId !== "fortran") return;
    await this.refreshFile(active.document.uri.toString());
  }

  private async refreshFile(uri: string): Promise<void> {
    if (!this.client) return;
    const seq = (this.fileRequestSeq.get(uri) ?? 0) + 1;
    this.fileRequestSeq.set(uri, seq);
    let resp: StatsResponse;
    try {
      resp = await this.client.sendRequest<StatsResponse>(
        "dimfort/coverageStats",
        { uri },
      );
    } catch {
      return;
    }
    // Drop stale responses: a later request for the same URI may have
    // started while this one was in flight.
    if ((this.fileRequestSeq.get(uri) ?? 0) !== seq) return;
    if (resp.files.length === 0) {
      this.fileStats.delete(uri);
    } else {
      const r = resp.files[0];
      this.fileStats.set(uri, {
        ok: r.ok, warn: r.warn, fire: r.fire, unparsed: r.unparsed,
        coveragePct: r.coverage_pct,
      });
    }
    this.emitter.fire();
  }

  private scheduleWorkspaceRefresh(): void {
    if (this.wsDebounceTimer) clearTimeout(this.wsDebounceTimer);
    this.wsDebounceTimer = setTimeout(() => {
      this.wsDebounceTimer = undefined;
      void this.refreshWorkspace();
    }, WS_DEBOUNCE_MS);
  }

  private async refreshWorkspace(): Promise<void> {
    if (!this.client) return;
    const seq = ++this.wsRequestSeq;
    let resp: StatsResponse;
    try {
      resp = await this.client.sendRequest<StatsResponse>(
        "dimfort/coverageStats",
        {},
      );
    } catch {
      return;
    }
    if (seq !== this.wsRequestSeq) return;
    this.workspace = {
      ok: resp.total.ok, warn: resp.total.warn, fire: resp.total.fire,
      unparsed: resp.total.unparsed, coveragePct: resp.total.coverage_pct,
    };
    this.wsStale = false;
    this.emitter.fire();
  }

  dispose(): void {
    if (this.wsDebounceTimer) clearTimeout(this.wsDebounceTimer);
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
