import * as vscode from "vscode";
import { LanguageClient, State } from "vscode-languageclient/node";

// Wire-format mirror of the server's dimfort/lineStatus response.
// See DimFort/docs/design/future/coverage-visualization.md §7.
type CoverageTier = "green" | "yellow" | "red" | "blue";
type CoverageMode = "disabled" | "gutter" | "background";

interface LineStatus {
  line: number;        // 1-based
  status: CoverageTier;
}

interface LineStatusResponse {
  uri: string;
  lines: LineStatus[];
}

// Tier-to-styling. Background tints are deliberately low-alpha so the
// editor text stays readable; the gutter dot is the primary cue.
interface TierStyle {
  iconPath: string;
  backgroundColor: string;
}

const TIER_STYLES: Record<CoverageTier, TierStyle> = {
  green: {
    iconPath: "media/coverage-green.svg",
    backgroundColor: "rgba(40, 167, 69, 0.10)",
  },
  yellow: {
    iconPath: "media/coverage-yellow.svg",
    backgroundColor: "rgba(255, 193, 7, 0.10)",
  },
  red: {
    iconPath: "media/coverage-red.svg",
    backgroundColor: "rgba(220, 53, 69, 0.10)",
  },
  blue: {
    iconPath: "media/coverage-blue.svg",
    backgroundColor: "rgba(0, 123, 255, 0.10)",
  },
};

// All four tiers paint in the gutter. The design spec §6 originally
// proposed stepping aside on yellow / red lines so the editor's native
// diagnostic icon would carry the signal, but VSCode does not paint
// diagnostic icons in the gutter by default (squiggles in the text and
// the overview-ruler markers are the native surface). Without a gutter
// sign for yellow / red, those tiers would have no per-line indicator
// in the gutter at all — leaving the green dots looking like the only
// coverage signal. Painting all four restores the at-a-glance read.
const GUTTER_TIERS: ReadonlyArray<CoverageTier> = ["green", "yellow", "red", "blue"];

const DEFAULT_DEBOUNCE_MS = 200;


export class CoverageProvider implements vscode.Disposable {
  private client: LanguageClient | undefined;
  private mode: CoverageMode = "disabled";
  private debounceMs = DEFAULT_DEBOUNCE_MS;
  // Per tier: one decoration for the gutter dot (mode != disabled),
  // one for the verbose-mode background tint. Built once at construction
  // because vscode.TextEditorDecorationType is immutable post-creation.
  private readonly gutterDecorations: Record<CoverageTier, vscode.TextEditorDecorationType>;
  private readonly tintDecorations: Record<CoverageTier, vscode.TextEditorDecorationType>;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.gutterDecorations = this.buildDecorations({ withGutter: true, withTint: false });
    this.tintDecorations = this.buildDecorations({ withGutter: false, withTint: true });
    this.disposables.push(
      ...Object.values(this.gutterDecorations),
      ...Object.values(this.tintDecorations),
    );
  }

  private buildDecorations(
    opts: { withGutter: boolean; withTint: boolean },
  ): Record<CoverageTier, vscode.TextEditorDecorationType> {
    const out: Partial<Record<CoverageTier, vscode.TextEditorDecorationType>> = {};
    for (const tier of ["green", "yellow", "red", "blue"] as CoverageTier[]) {
      const style = TIER_STYLES[tier];
      const decoOpts: vscode.DecorationRenderOptions = {
        isWholeLine: opts.withTint,
      };
      if (opts.withGutter) {
        decoOpts.gutterIconPath = this.context.asAbsolutePath(style.iconPath);
        decoOpts.gutterIconSize = "contain";
      }
      if (opts.withTint) {
        decoOpts.backgroundColor = style.backgroundColor;
      }
      out[tier] = vscode.window.createTextEditorDecorationType(decoOpts);
    }
    return out as Record<CoverageTier, vscode.TextEditorDecorationType>;
  }

  setClient(client: LanguageClient | undefined): void {
    this.client = client;
    if (client && this.mode !== "disabled") {
      // setClient() is called BEFORE await client.start() in the
      // extension's rebuildClient() path, so a synchronous
      // refreshAll() would send dimfort/lineStatus to a Starting-
      // state client — the requests go to nothing and the gutter /
      // background tint stays empty until the user touches a buffer.
      // Poll for State.Running before firing. Same pattern as
      // panel.ts and stats.ts.
      void this.waitForRunningAndRefreshAll(client, Date.now() + 10000);
    }
  }

  /** Poll until ``client`` reaches ``State.Running``, then refreshAll. */
  private async waitForRunningAndRefreshAll(
    client: LanguageClient,
    deadline: number,
  ): Promise<void> {
    if (this.client !== client) return;  // another setClient superseded
    if (client.state === State.Running) {
      this.refreshAll();
      return;
    }
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 300));
    void this.waitForRunningAndRefreshAll(client, deadline);
  }

  setMode(mode: CoverageMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "disabled") {
      this.clearAll();
      return;
    }
    this.refreshAll();
  }

  setDebounceMs(ms: number): void {
    this.debounceMs = Math.max(0, ms);
  }

  scheduleRefresh(editor: vscode.TextEditor | undefined): void {
    if (!editor || this.mode === "disabled") return;
    const key = editor.document.uri.toString();
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        void this.refresh(editor);
      }, this.debounceMs),
    );
  }

  refreshAll(): void {
    if (this.mode === "disabled") return;
    for (const editor of vscode.window.visibleTextEditors) {
      void this.refresh(editor);
    }
  }

  async refresh(editor: vscode.TextEditor): Promise<void> {
    if (this.mode === "disabled" || !this.client) {
      this.clearEditor(editor);
      return;
    }
    let response: LineStatusResponse;
    try {
      response = await this.client.sendRequest<LineStatusResponse>(
        "dimfort/lineStatus",
        { uri: editor.document.uri.toString() },
      );
    } catch {
      // Server not ready / request failed — leave the last decorations
      // in place rather than blanking everything.
      return;
    }
    this.applyDecorations(editor, response.lines);
  }

  private applyDecorations(editor: vscode.TextEditor, lines: LineStatus[]): void {
    const ranges: Record<CoverageTier, vscode.Range[]> = {
      green: [],
      yellow: [],
      red: [],
      blue: [],
    };
    const lineCount = editor.document.lineCount;
    for (const entry of lines) {
      // Server returns 1-based line numbers; VSCode positions are 0-based.
      const lineIdx = entry.line - 1;
      if (lineIdx < 0 || lineIdx >= lineCount) continue;
      ranges[entry.status].push(editor.document.lineAt(lineIdx).range);
    }
    for (const tier of ["green", "yellow", "red", "blue"] as CoverageTier[]) {
      // The two visible modes are mutually exclusive: gutter paints in
      // the left-margin column, background paints behind the line text.
      // Both encode the same per-line tier; the user picks which visual
      // weight they prefer.
      const gutterRanges =
        this.mode === "gutter" && GUTTER_TIERS.includes(tier) ? ranges[tier] : [];
      editor.setDecorations(this.gutterDecorations[tier], gutterRanges);

      const tintRanges = this.mode === "background" ? ranges[tier] : [];
      editor.setDecorations(this.tintDecorations[tier], tintRanges);
    }
  }

  private clearEditor(editor: vscode.TextEditor): void {
    for (const tier of ["green", "yellow", "red", "blue"] as CoverageTier[]) {
      editor.setDecorations(this.gutterDecorations[tier], []);
      editor.setDecorations(this.tintDecorations[tier], []);
    }
  }

  private clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearEditor(editor);
    }
  }

  dispose(): void {
    for (const t of this.debounceTimers.values()) {
      clearTimeout(t);
    }
    this.debounceTimers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
