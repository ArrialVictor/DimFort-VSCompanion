/**
 * Coordinator for the multi-view DimFort panel.
 *
 * Owns the cursor-driven update loop (debounce, ``dimfort/panelInfo``
 * + ``dimfort/interactions`` requests, code-action fetch) and
 * broadcasts the resulting payload to every registered subscriber
 * (the section view providers). One LSP request cycle per cursor
 * event, regardless of how many views are docked.
 *
 * Replaces ``DimFortPanelProvider``'s former dual role of "data
 * source + single webview owner" with a pure data source. Each
 * section view extends ``SectionView`` and registers itself as a
 * subscriber here.
 */
import * as vscode from "vscode";
import { LanguageClient, State } from "vscode-languageclient/node";

import { CoverageStatsProvider } from "../stats";
import type { PanelSubscriber } from "./section-view";
import type {
  InteractionsReport,
  PanelInfo,
  PanelPayload,
  SortMode,
} from "./types";


// VSCode's tab-switch can briefly leave activeTextEditor undefined
// before settling on the new editor. An "empty" post during that
// window flashes the panel to "no Fortran file active" mid-switch.
// Delaying the empty post by this much lets the transition resolve;
// a real update during the delay cancels the empty.
const EMPTY_POST_DELAY_MS = 200;


function readSortModes(): { scope: SortMode; imports: SortMode } {
  const cfg = vscode.workspace.getConfiguration("dimfort");
  return {
    scope: cfg.get<SortMode>("panel.scopeSortMode", "line"),
    imports: cfg.get<SortMode>("panel.importsSortMode", "line"),
  };
}


export class PanelCoordinator {
  private client?: LanguageClient;
  private subscribers: PanelSubscriber[] = [];
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private emptyTimer?: ReturnType<typeof setTimeout>;
  private requestSeq = 0;
  // Code actions available at the current cursor, kept so the
  // application of a button-click can resolve back to a real action.
  private actions: vscode.CodeAction[] = [];
  private actionDoc?: vscode.TextDocument;

  constructor(private readonly statsProvider: CoverageStatsProvider) {
    this.statsProvider.onDidChange(() => this.broadcastStats());
  }

  // -------------------------------------------------------------------
  // Subscriber management
  // -------------------------------------------------------------------

  addSubscriber(s: PanelSubscriber): void {
    this.subscribers.push(s);
    // Seed the new view with the persisted sort modes so it doesn't
    // sit on whatever its own getState() had cached from a prior
    // session. The first cursor-driven ``update()`` will replay data.
    s.onSortModes(readSortModes());
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  setClient(client: LanguageClient | undefined): void {
    this.client = client;
    // A scale-mode / cache / feature-toggle change goes through a full
    // LSP restart; without a forced refresh the views keep showing the
    // prior server's payload until the user moves the cursor.
    //
    // ``setClient()`` is called BEFORE ``await client.start()`` in the
    // extension's ``rebuildClient()`` path, so an immediate
    // ``scheduleUpdate(0)`` would send ``dimfort/panelInfo`` before the
    // client is running — the request goes to nothing and the views
    // rebuild against null. Poll for ``client.state === Running``
    // before firing, with a 10 s deadline as a safety net.
    if (client) void this.waitForRunningAndRefresh(client, Date.now() + 10000);
  }

  private async waitForRunningAndRefresh(
    client: LanguageClient, deadline: number,
  ): Promise<void> {
    if (this.client !== client) return;
    if (client.state === State.Running) {
      this.scheduleUpdate(0);
      return;
    }
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 300));
    void this.waitForRunningAndRefresh(client, deadline);
  }

  scheduleUpdate(delayMs: number): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.update(), delayMs);
  }

  private scheduleEmptyBroadcast(reason: string): void {
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = setTimeout(() => {
      this.emptyTimer = undefined;
      const editor = vscode.window.activeTextEditor;
      const stillEmpty =
        !editor || editor.document.languageId !== "fortran" || !this.client;
      if (stillEmpty) this.broadcastEmpty(reason);
    }, EMPTY_POST_DELAY_MS);
  }

  // -------------------------------------------------------------------
  // Broadcast helpers
  // -------------------------------------------------------------------

  private broadcastData(payload: PanelPayload): void {
    for (const s of this.subscribers) s.onData(payload);
  }

  private broadcastEmpty(reason: string): void {
    for (const s of this.subscribers) s.onEmpty(reason);
  }

  private broadcastStats(): void {
    const active = vscode.window.activeTextEditor;
    const uri = active?.document.languageId === "fortran"
      ? active.document.uri.toString() : undefined;
    const snap = this.statsProvider.snapshot(uri);
    for (const s of this.subscribers) s.onStats(snap);
  }

  applySortModesFromConfig(): void {
    const modes = readSortModes();
    for (const s of this.subscribers) s.onSortModes(modes);
  }

  // -------------------------------------------------------------------
  // The main cursor-driven update
  // -------------------------------------------------------------------

  private async update(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "fortran") {
      this.scheduleEmptyBroadcast("no Fortran file active");
      return;
    }
    if (!this.client) {
      this.scheduleEmptyBroadcast("DimFort server not running");
      return;
    }
    if (this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = undefined;
    }
    const pos = editor.selection.active;
    const params = {
      textDocument: { uri: editor.document.uri.toString() },
      position: { line: pos.line, character: pos.character },
    };
    const seq = ++this.requestSeq;

    let result: PanelInfo | null = null;
    try {
      result = await this.client.sendRequest<PanelInfo | null>(
        "dimfort/panelInfo", params,
      );
    } catch {
      return;
    }
    if (seq !== this.requestSeq || !result) return;

    let interactions: InteractionsReport | null = null;
    try {
      interactions = await this.client.sendRequest<InteractionsReport | null>(
        "dimfort/interactions", params,
      );
    } catch {
      interactions = null;
    }
    if (seq !== this.requestSeq) return;

    let actions: vscode.CodeAction[] = [];
    try {
      const range = new vscode.Range(pos, pos);
      const got = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider", editor.document.uri, range,
      );
      actions = (got || []).filter((a) =>
        a && (
          a.command?.command?.startsWith("dimfort.") ||
          /@?unit|PARAMETER/i.test(a.title)
        ),
      );
    } catch {
      actions = [];
    }
    if (seq !== this.requestSeq) return;

    this.actions = actions;
    this.actionDoc = editor.document;
    this.broadcastData({
      payload: result,
      actions: actions.map((a) => a.title),
      interactions,
      statsSnapshot: this.statsProvider.snapshot(
        editor.document.uri.toString(),
      ),
    });
  }

  // -------------------------------------------------------------------
  // Code-action apply (Cursor view's Actions buttons route here)
  // -------------------------------------------------------------------

  async applyAction(index: number): Promise<void> {
    const a = this.actions[index];
    if (!a) return;
    if (this.actionDoc) {
      await vscode.window.showTextDocument(this.actionDoc, { preserveFocus: false });
    }
    if (a.edit) await vscode.workspace.applyEdit(a.edit);
    if (a.command) {
      await vscode.commands.executeCommand(
        a.command.command, ...(a.command.arguments ?? []),
      );
    }
  }
}
