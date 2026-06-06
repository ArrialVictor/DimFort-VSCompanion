import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";

// Wire-format mirror of the server's dimfort/lineStatus response.
// See DimFort/docs/design/future/coverage-visualization.md §7.
type CoverageTier = "green" | "yellow" | "red" | "blue";
type CoverageMode = "disabled" | "gutter" | "verbose";

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

// Lines with these tiers get a coverage gutter sign. Lines with the
// other tiers (yellow / red) rely on the editor's native diagnostic
// gutter icon — painting our sign alongside would double up. Per the
// design spec §6.
const GUTTER_TIERS: ReadonlyArray<CoverageTier> = ["green", "blue"];

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
    if (this.mode !== "disabled") {
      this.refreshAll();
    }
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
      // Gutter signs: only for green and blue, in both gutter and verbose modes.
      const gutterRanges = GUTTER_TIERS.includes(tier) ? ranges[tier] : [];
      editor.setDecorations(this.gutterDecorations[tier], gutterRanges);

      // Background tint: only in verbose mode, paints every tier.
      const tintRanges = this.mode === "verbose" ? ranges[tier] : [];
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
