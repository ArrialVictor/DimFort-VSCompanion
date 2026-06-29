import { execFile } from "child_process";
import { promisify } from "util";

import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
} from "vscode-languageclient/node";

const execFileP = promisify(execFile);
import { CoverageProvider } from "./coverage";
import { deriveRootIfNeeded } from "./derive-root";
import { PanelCoordinator } from "./panel/coordinator";
import { CoverageStatusFooter } from "./panel/coverage-status";
import { CursorView } from "./panel/cursor-view";
import { ImportsView } from "./panel/imports-view";
import { ScopeView } from "./panel/scope-view";
import {
  installServerExitSurfacing,
  markExpectingStop,
  quietErrorHandler,
  reportStartFailure,
} from "./server-exit";
import { CoverageStatsProvider } from "./stats";

let client: LanguageClient | undefined;
let panelCoordinator: PanelCoordinator | undefined;
let coverageProvider: CoverageProvider | undefined;
let statsProvider: CoverageStatsProvider | undefined;

// Build a fresh LanguageClient from the current VSCode settings. Called
// at activation and every time a toggle command flips a setting — never
// re-use a captured `clientOptions` reference, because `LanguageClient`
// keeps the same `initializationOptions` across `restart()` calls, so a
// setting change won't reach the server otherwise.
function buildClient(): LanguageClient {
  const config = vscode.workspace.getConfiguration("dimfort");
  const executable = config.get<string>("executable", "dimfort");

  // No `transport` field: stdio is the default and is what `dimfort lsp`
  // speaks. Setting `transport: TransportKind.stdio` explicitly causes
  // the client to append a `--stdio` arg that DimFort doesn't recognise.
  const serverOptions: ServerOptions = {
    command: executable,
    args: ["lsp"],
  };

  // Defaults here must match the package.json contributions defaults
  // — they only kick in if the setting is completely absent, but
  // keeping them aligned avoids drift surprises when contributions
  // change.
  const cacheDir = config.get<string>("cache.dir", "");
  const initializationOptions: Record<string, unknown> = {
    inlayHintsEnabled: config.get<boolean>("inlayHints.enabled", false),
    completionEnabled: config.get<boolean>("completion.enabled", true),
    codeActionsEnabled: config.get<boolean>("codeActions.enabled", true),
    gotoDefinitionEnabled: config.get<boolean>("gotoDefinition.enabled", true),
    hover: config.get<string>("hover", "short"),
    maxWorksetSize: config.get<number>("maxWorksetSize", 40),
    externalModules: config.get<string[]>("externalModules", []),
    cacheMode: config.get<string>("cache.mode", "read-write"),
  };
  if (cacheDir) {
    initializationOptions.cacheDir = cacheDir;
  }
  // Scale checking is tri-state: "auto" defers to the project's
  // `dimfort.toml` (omit the option so the server's config wins);
  // "on"/"off" forward an explicit boolean that overrides the toml.
  const scaleMode = config.get<string>("scale.mode", "auto");
  if (scaleMode === "on") {
    initializationOptions.scaleMode = true;
  } else if (scaleMode === "off") {
    initializationOptions.scaleMode = false;
  }

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "fortran" },
      { scheme: "file", language: "FortranFreeForm" },
      { scheme: "file", language: "fortran-modern" },
    ],
    outputChannelName: "DimFort",
    initializationOptions,
    // Suppress vscode-languageclient's own retry/close notifications;
    // see server-exit.ts:quietErrorHandler for the rationale. Our
    // installServerExitSurfacing + reportStartFailure are the single
    // user-visible voice for connection lifecycle events.
    errorHandler: quietErrorHandler(),
  };

  // Derive a workspace root from the open file when the user opened
  // a single file (`code foo.f90`) instead of a folder — without this,
  // ``vscode.workspace.workspaceFolders`` is empty, the LSP sends no
  // folder to the server, and every workspace-scope feature silently
  // disables. Matches the Nvim/Emacs companions' equivalent behaviour.
  // Returns null when a real folder is already open (no synthesis
  // needed) or no Fortran document is open yet (rare timing race;
  // re-runs on the next attach attempt).
  const derived = deriveRootIfNeeded();
  if (derived) {
    clientOptions.workspaceFolder = derived;
  }

  return new LanguageClient(
    "dimfort",
    "DimFort",
    serverOptions,
    clientOptions,
  );
}

// Tear down the active client and replace it with a freshly-configured
// one. Used by the explicit restart command and by every per-feature
// toggle so the new VSCode setting reaches the LSP.
// Serialise restarts. If two callers race (e.g. a setting change fires
// the onDidChangeConfiguration listener while a manual restart is still
// in flight), overlapping stop/start cycles cross their stdio pipes and
// a half-started server exits mid-handshake ("Server process exited with
// code 0"). Chaining guarantees one rebuild finishes before the next.
let rebuildChain: Promise<void> = Promise.resolve();

function rebuildClient(): Promise<void> {
  // audited(0.2.7): silent-OK — the `.catch` here drops the previous
  // rebuild's rejection on the floor so the chain keeps advancing.
  // The previous failure has already been surfaced at its origin
  // (doRebuildClient's start() catch → reportStartFailure, or the
  // calling command's own toast). The chain-level catch only
  // exists so a single bad config-change can't poison every
  // subsequent rebuild.
  rebuildChain = rebuildChain.catch(() => undefined).then(doRebuildClient);
  return rebuildChain;
}

async function doRebuildClient(): Promise<void> {
  if (client) {
    // audited(0.2.7): silent-OK — mark as a graceful teardown BEFORE
    // calling stop() so the resulting Running → Stopped transition
    // doesn't trip the unexpected-exit toast. The catch covers
    // stop()'s own failure modes (previous start half-completed,
    // server already dead); we're tearing down regardless.
    markExpectingStop(client);
    try {
      await client.stop();
    } catch {
      // Ignore: stop() can throw if the previous start failed half-way,
      // which is fine — we're tearing it down anyway.
    }
  }
  client = buildClient();
  // Install BEFORE start() so the first Starting → Running
  // transition is observed and resets the state-transition dedup
  // memo (lets a post-recovery crash warn afresh).
  installServerExitSurfacing(client);
  panelCoordinator?.setClient(client);
  coverageProvider?.setClient(client);
  statsProvider?.setClient(client);
  try {
    await client.start();
  } catch (err) {
    // audited(0.2.7): error-surfacing — start() failure on rebuild
    // would otherwise propagate to the caller's try/catch (which
    // toasts a generic "reload failed" message) without naming the
    // common causes. Surface the actionable hints here, then
    // re-throw so the caller's own teardown / reporting still runs.
    reportStartFailure(err, client.outputChannel);
    throw err;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  client = buildClient();
  // audited(0.2.7): error-surfacing — wire BOTH lifecycle paths
  // before start():
  //  - installServerExitSurfacing covers the mid-session crash
  //    (Running → Stopped without our markExpectingStop).
  //  - reportStartFailure covers the pre-handshake failure
  //    (executable not on PATH, immediate spawn crash, Python
  //    error before initialize completes). Previously `void
  //    client.start()` dropped this rejection on the floor.
  installServerExitSurfacing(client);
  client.start().catch((err) => reportStartFailure(err, client?.outputChannel));
  context.subscriptions.push({
    dispose: () => {
      if (client) markExpectingStop(client);
      void client?.stop();
    },
  });

  // Coverage stats provider — drives the side panel's bottom-bar
  // segment (per-file + workspace coverage %). Constructed before the
  // panel so the panel can subscribe to its onDidChange in its
  // constructor. Owns its own diagnostic-change listener for refresh.
  statsProvider = new CoverageStatsProvider();
  statsProvider.setClient(client);
  context.subscriptions.push(statsProvider);

  // Multi-view panel. Coordinator owns the cursor-driven LSP loop;
  // each section view (Cursor / Scope / Imports) subscribes to its
  // broadcasts so they share one LSP request cycle per cursor event.
  // Coverage lives in the VSCode status bar instead — see
  // CoverageStatusFooter below.
  panelCoordinator = new PanelCoordinator(statsProvider);
  panelCoordinator.setClient(client);
  const cursorView = new CursorView();
  cursorView.actionHandler = (index) => void panelCoordinator?.applyAction(index);
  panelCoordinator.addSubscriber(cursorView);
  const scopeView = new ScopeView();
  panelCoordinator.addSubscriber(scopeView);
  const importsView = new ImportsView();
  panelCoordinator.addSubscriber(importsView);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CursorView.viewType, cursorView,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerWebviewViewProvider(
      ScopeView.viewType, scopeView,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerWebviewViewProvider(
      ImportsView.viewType, importsView,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    // Coverage as a real status-bar footer rather than an in-webview
    // section. Always visible at the bottom of the VSCode window across
    // any editor, with full per-file + workspace breakdown on hover.
    new CoverageStatusFooter(statsProvider),
  );

  // Title-bar cycle commands. Three menu entries per cycle show
  // different icons (mode-aware) so the active mode is visible at a
  // glance. All three command variants per cycle do the same thing.
  // Sort mode applies to BOTH Scope and Imports views (unified — see
  // the .when clauses in package.json).
  const cycleSortMode = async () => {
    const cfg = vscode.workspace.getConfiguration("dimfort");
    const cur = cfg.get<string>("panel.sortMode", "line");
    const next = cur === "line" ? "alphabetic"
      : cur === "alphabetic" ? "status" : "line";
    await cfg.update(
      "panel.sortMode", next, vscode.ConfigurationTarget.Global,
    );
  };
  const cycleUnitDisplay = async () => {
    const cfg = vscode.workspace.getConfiguration("dimfort");
    const cur = cfg.get<string>("panel.unitDisplayMode", "canonical");
    const next = cur === "input" ? "canonical"
      : cur === "canonical" ? "both" : "input";
    await cfg.update(
      "panel.unitDisplayMode", next, vscode.ConfigurationTarget.Global,
    );
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.cycleSortMode", cycleSortMode),
    vscode.commands.registerCommand("dimfort.cycleSortMode.alpha", cycleSortMode),
    vscode.commands.registerCommand("dimfort.cycleSortMode.status", cycleSortMode),
    vscode.commands.registerCommand("dimfort.cycleUnitDisplay", cycleUnitDisplay),
    vscode.commands.registerCommand("dimfort.cycleUnitDisplay.canonical", cycleUnitDisplay),
    vscode.commands.registerCommand("dimfort.cycleUnitDisplay.both", cycleUnitDisplay),
  );
  const setSortContext = () => {
    const cfg = vscode.workspace.getConfiguration("dimfort");
    void vscode.commands.executeCommand(
      "setContext", "dimfort.sortMode",
      cfg.get<string>("panel.sortMode", "line"),
    );
    void vscode.commands.executeCommand(
      "setContext", "dimfort.unitDisplayMode",
      cfg.get<string>("panel.unitDisplayMode", "canonical"),
    );
  };
  setSortContext();

  // Cursor-follow: refresh the panel (debounced) as the selection moves
  // or the active editor changes.
  const debounceMs = vscode.workspace
    .getConfiguration("dimfort")
    .get<number>("panel.debounceMs", 200);
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() =>
      panelCoordinator?.scheduleUpdate(debounceMs),
    ),
    vscode.window.onDidChangeActiveTextEditor(() =>
      panelCoordinator?.scheduleUpdate(0),
    ),
  );
  // Toggle / focus command. The Cursor view is the primary surface, so
  // ``DimFort: Show Side Panel`` focuses it; users can drag the other
  // views (Scope / Imports) to wherever they like.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.togglePanel", () => {
      void vscode.commands.executeCommand("dimfort.cursor.focus");
    }),
  );
  if (
    vscode.workspace.getConfiguration("dimfort").get<boolean>("panel.enabled", true)
  ) {
    void vscode.commands.executeCommand("dimfort.cursor.focus");
  }

  // Coverage layer — per-line green/yellow/red/blue decoration driven by
  // the dimfort/lineStatus LSP method. Default mode is `disabled` (opt-in
  // per the design spec); users cycle via the palette command. The
  // provider holds its own debounce so simultaneous edits across editors
  // don't pile up requests.
  coverageProvider = new CoverageProvider(context);
  coverageProvider.setClient(client);
  context.subscriptions.push(coverageProvider);
  const coverageCfg = vscode.workspace.getConfiguration("dimfort");
  coverageProvider.setDebounceMs(coverageCfg.get<number>("coverage.debounceMs", 200));
  coverageProvider.setMode(
    coverageCfg.get<"disabled" | "gutter" | "background">("coverage.mode", "disabled"),
  );

  // Refresh triggers. The provider no-ops when mode is disabled, so the
  // listeners cost nothing in the default configuration.
  //
  // The primary trigger is `onDidChangeDiagnostics`: VSCode fires it the
  // instant the server publishes (which is post-debounce on the server
  // side, ~400 ms after the last keystroke). Hooking here keeps the
  // coverage layer in lock-step with the squiggles — no race against
  // the server's own debounce, no separate-debounce guesswork.
  //
  // We also refresh on active-editor change so a freshly-focused editor
  // paints from the last cached result without waiting for an edit.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      coverageProvider?.scheduleRefresh(editor),
    ),
    vscode.languages.onDidChangeDiagnostics((event) => {
      const changed = new Set(event.uris.map((u) => u.toString()));
      for (const ed of vscode.window.visibleTextEditors) {
        if (changed.has(ed.document.uri.toString())) {
          coverageProvider?.scheduleRefresh(ed);
        }
      }
    }),
  );

  // Hand-rolled restart command: faster than "Developer: Reload Window"
  // when you've just edited the Python server source. Goes through
  // rebuildClient so any setting change since the last start is picked
  // up too.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.restartLanguageServer", async () => {
      try {
        await rebuildClient();
        vscode.window.setStatusBarMessage("DimFort: language server restarted", 2000);
      } catch (err) {
        vscode.window.showErrorMessage(`DimFort: restart failed — ${err}`);
      }
    }),
  );

  // Clear the on-disk content-hash cache, then restart so diagnostics
  // repopulate. The dir mirrors the server's resolution: the
  // `dimfort.cache.dir` setting if set, else `.dimfort-cache/` under the
  // first workspace folder (cache_store.default_cache_dir).
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.clearCache", async () => {
      const cfgDir = vscode.workspace.getConfiguration("dimfort").get<string>("cache.dir", "");
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!cfgDir && !folder) {
        vscode.window.showWarningMessage("DimFort: no workspace folder — nothing to clear.");
        return;
      }
      const cacheUri = cfgDir
        ? vscode.Uri.file(cfgDir)
        : vscode.Uri.joinPath(folder!.uri, ".dimfort-cache");
      try {
        await vscode.workspace.fs.delete(cacheUri, { recursive: true, useTrash: false });
      } catch (err) {
        // FileNotFound is fine — nothing cached yet. Re-throw anything else.
        if (!(err instanceof vscode.FileSystemError && err.code === "FileNotFound")) {
          vscode.window.showErrorMessage(`DimFort: clear cache failed — ${err}`);
          return;
        }
      }
      try {
        await rebuildClient();
        vscode.window.setStatusBarMessage("DimFort: cache cleared", 2000);
      } catch (err) {
        vscode.window.showErrorMessage(`DimFort: restart after clear failed — ${err}`);
      }
    }),
  );

  // Settings that ship as initializationOptions can only be re-read by
  // restarting the server. Watch the `dimfort.*` namespace and reload
  // transparently when any of them change — the user gets immediate
  // feedback instead of having to run "Restart Language Server".
  //
  // Coverage settings are companion-side only (no LSP restart needed);
  // they re-apply directly on the provider so a mode flip does not
  // tear down and rebuild the server.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("dimfort")) return;
      // Panel sort + unit-display changes are pure UI — push to the
      // webview, never restart the language server.
      const uiOnly =
        (event.affectsConfiguration("dimfort.panel.sortMode") ||
          event.affectsConfiguration("dimfort.panel.unitDisplayMode")) &&
        !affectsOtherDimfortSettings(event) &&
        !event.affectsConfiguration("dimfort.coverage.mode") &&
        !event.affectsConfiguration("dimfort.coverage.debounceMs");
      if (uiOnly) {
        panelCoordinator?.applySortModeFromConfig();
        panelCoordinator?.applyUnitDisplayFromConfig();
        setSortContext();
        return;
      }
      const coverageOnly =
        (event.affectsConfiguration("dimfort.coverage.mode") ||
          event.affectsConfiguration("dimfort.coverage.debounceMs")) &&
        !affectsOtherDimfortSettings(event);
      if (coverageOnly) {
        const cfg = vscode.workspace.getConfiguration("dimfort");
        coverageProvider?.setDebounceMs(cfg.get<number>("coverage.debounceMs", 200));
        coverageProvider?.setMode(
          cfg.get<"disabled" | "gutter" | "background">("coverage.mode", "disabled"),
        );
        return;
      }
      try {
        await rebuildClient();
      } catch (err) {
        vscode.window.showErrorMessage(`DimFort: reload after settings change failed — ${err}`);
      }
    }),
  );

  // The server reads project config (`dimfort.toml`: units file,
  // [diagnostics] severities, [scale] enabled, …) only at initialize, so
  // edits to it need a server restart to take effect. Watch the file and
  // rebuild on change/create/delete — same transparent reload the
  // `dimfort.*` settings get, so users don't have to run Restart manually.
  const tomlWatcher = vscode.workspace.createFileSystemWatcher("**/dimfort.toml");
  const reloadOnToml = async () => {
    try {
      await rebuildClient();
    } catch (err) {
      vscode.window.showErrorMessage(`DimFort: reload after dimfort.toml change failed — ${err}`);
    }
  };
  tomlWatcher.onDidChange(reloadOnToml);
  tomlWatcher.onDidCreate(reloadOnToml);
  tomlWatcher.onDidDelete(reloadOnToml);
  context.subscriptions.push(tomlWatcher);

  // Snippet inserter used by the "Add @unit{}" code action. Standard
  // LSP TextEdit can't position the cursor inside `{...}`, so the
  // server returns a Command instead and we call insertSnippet here.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dimfort.insertSnippet",
      async (uri: string, line: number, character: number, snippet: string) => {
        const target = vscode.Uri.parse(uri);
        const doc = await vscode.workspace.openTextDocument(target);
        const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
        const pos = new vscode.Position(line, character);
        await editor.insertSnippet(new vscode.SnippetString(snippet), pos);
        // The snippet leaves the cursor between the `@unit{}` braces; pop
        // the unit-name completion immediately so the user doesn't have to
        // press Ctrl+Space (the server already offers completions there).
        await vscode.commands.executeCommand("editor.action.triggerSuggest");
      },
    ),
  );

  // Extract-to-PARAMETER refactor for the H010 D1.5 (implicit literal
  // cast) diagnostic. Prompts the user for the parameter name via
  // showInputBox so they can pick something meaningful, then applies
  // the two-edit refactor (insert PARAMETER decl + replace literal).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dimfort.extractToParameter",
      async (
        uri: string,
        rangeStart: { line: number; character: number },
        rangeEnd: { line: number; character: number },
        insertLine: number,
        indent: string,
        literalText: string,
        targetUnit: string,
        defaultName: string,
      ) => {
        const name = await vscode.window.showInputBox({
          prompt: `Parameter name for literal ${literalText} (${targetUnit})`,
          value: defaultName,
          validateInput: (v) => {
            if (!v) {
              return "Name cannot be empty";
            }
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(v)) {
              return "Use a Fortran identifier (letter then letters/digits/_)";
            }
            return undefined;
          },
        });
        if (!name) {
          return; // user cancelled
        }
        const target = vscode.Uri.parse(uri);
        const declLine = `${indent}real, parameter :: ${name} = ${literalText}   !< @unit{${targetUnit}}\n`;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(target, new vscode.Position(insertLine, 0), declLine);
        edit.replace(
          target,
          new vscode.Range(
            new vscode.Position(rangeStart.line, rangeStart.character),
            new vscode.Position(rangeEnd.line, rangeEnd.character),
          ),
          name,
        );
        await vscode.workspace.applyEdit(edit);
      },
    ),
  );

  // Workspace-wide check. The server registers a wire-protocol
  // command ``dimfort/checkWorkspace`` (slash, not dot — pure LSP
  // wire identifier, never enters VS Code's command registry). The
  // companion-side wrapper below is a separate VS Code command
  // ``dimfort.checkWorkspace`` (dot) which the user invokes from
  // the palette / keybindings. The wrapper exists so the status-bar
  // Coverage widget can observe the in-flight check — set
  // wsRefreshing → dim → spinner → settle — and so duplicate
  // invocations coalesce client-side. The wrapper's body sends the
  // ``workspace/executeCommand`` request with the slash-form wire
  // name; see ``stats.ts`` for the payload.

  // Per-feature toggles. Each one flips the corresponding setting and
  // *rebuilds* the language client so the new value reaches the LSP.
  // Visible from the Command Palette as "DimFort: Toggle …".
  const registerToggle = (commandId: string, settingKey: string, label: string) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, async () => {
        const cfg = vscode.workspace.getConfiguration("dimfort");
        const current = cfg.get<boolean>(settingKey, true);
        // Updating the setting triggers the onDidChangeConfiguration
        // listener, which rebuilds the client — don't rebuild again here
        // (that double-restart races and crashes the server).
        await cfg.update(settingKey, !current, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(
          `DimFort: ${label} ${!current ? "on" : "off"}`,
          2000,
        );
      }),
    );
  };
  registerToggle("dimfort.toggleInlayHints",     "inlayHints.enabled",     "inlay hints");
  registerToggle("dimfort.toggleCompletion",     "completion.enabled",     "unit completion");
  registerToggle("dimfort.toggleCodeActions",    "codeActions.enabled",    "code actions");
  registerToggle("dimfort.toggleGotoDefinition", "gotoDefinition.enabled", "go-to-definition");

  // Cache toggle is enum-valued (off / read-only / read-write), not a
  // boolean, so it needs its own command rather than reusing
  // registerToggle. Cycles through all three setting values in the
  // order off → read-only → read-write → off, matching cycleHover /
  // cycleScale / cycleCoverage's pattern. The Off-to-Read-only step
  // exposes the inspect-without-populating mode that used to be
  // settings-only.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.cycleCache", async () => {
      const cfg = vscode.workspace.getConfiguration("dimfort");
      const order = ["off", "read-only", "read-write"];
      const current = cfg.get<string>("cache.mode", "off");
      const next = order[(order.indexOf(current) + 1) % order.length];
      // The config-change listener rebuilds the client; don't also do it
      // here (double restart races and crashes the server).
      await cfg.update("cache.mode", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`DimFort: cache ${next}`, 2000);
    }),
  );

  // Hover verbosity is a tri-state (disabled / short / detailed), so it
  // also needs its own command rather than registerToggle. Cycles in
  // that order. The side panel is unaffected — it is always detailed.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.cycleHover", async () => {
      const cfg = vscode.workspace.getConfiguration("dimfort");
      const order = ["disabled", "short", "detailed"];
      const current = cfg.get<string>("hover", "short");
      const next = order[(order.indexOf(current) + 1) % order.length];
      // The config-change listener rebuilds the client; don't also do it
      // here (double restart races and crashes the server).
      await cfg.update("hover", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`DimFort: hover ${next}`, 2000);
    }),
  );

  // Scale checking is tri-state (auto / on / off), like hover. "auto"
  // defers to the project dimfort.toml; "on"/"off" override it. Cycles
  // in that order; the config-change listener rebuilds the client.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.cycleScale", async () => {
      const cfg = vscode.workspace.getConfiguration("dimfort");
      const order = ["auto", "on", "off"];
      const current = cfg.get<string>("scale.mode", "auto");
      const next = order[(order.indexOf(current) + 1) % order.length];
      await cfg.update("scale.mode", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`DimFort: scale checking ${next}`, 2000);
    }),
  );

  // Coverage visualisation is tri-state (disabled / gutter / background).
  // Gutter and background are mutually-exclusive visual encodings of the
  // same data; pick the visual weight you prefer. The config-change
  // listener takes the coverage-only path here, so flipping the mode does
  // NOT restart the LSP — the provider re-renders directly. Cycles in
  // disabled → gutter → background order.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.cycleCoverage", async () => {
      const cfg = vscode.workspace.getConfiguration("dimfort");
      const order = ["disabled", "gutter", "background"];
      const current = cfg.get<string>("coverage.mode", "disabled");
      const next = order[(order.indexOf(current) + 1) % order.length];
      await cfg.update("coverage.mode", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`DimFort: coverage ${next}`, 2000);
    }),
  );

  // Manual workspace check. Wraps the wire-protocol
  // ``dimfort/checkWorkspace`` call so we can manage bar UI state
  // (wsRefreshing → dimmed + spinner + "computing…") around it.
  // Since the server's handler also publishes diagnostics + seeds
  // the workspace coverage cache + returns the payload, one
  // invocation refreshes both squiggles and the bar.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.checkWorkspace", () => {
      void statsProvider?.checkWorkspace();
    }),
  );

  // Per-section view-visibility toggles (0.2.6). Backed by the
  // boolean settings `dimfort.show.{cursor,scope,imports}` which the
  // views' `when` clauses key off, so flipping a setting hides or
  // shows the view immediately. Cross-companion parity with Nvim's
  // :DimFortToggleCursor/Scope/Imports and Emacs's analogues —
  // every companion exposes the same three-way visibility control
  // regardless of whether the underlying surface is native (VSCode's
  // multi-view) or in-buffer (Nvim/Emacs panel renderers).
  for (const section of ["cursor", "scope", "imports"] as const) {
    const cmdId = `dimfort.toggle${section[0].toUpperCase()}${section.slice(1)}`;
    const settingKey = `show.${section}`;
    context.subscriptions.push(
      vscode.commands.registerCommand(cmdId, async () => {
        const cfg = vscode.workspace.getConfiguration("dimfort");
        const current = cfg.get<boolean>(settingKey, true);
        await cfg.update(settingKey, !current, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(
          `DimFort: ${section} view ${!current ? "shown" : "hidden"}`,
          2000,
        );
      }),
    );
  }

  // Status dump (0.2.6). Mirrors Nvim's `:DimFortStatus` and Emacs's
  // `M-x dimfort-status`. Appends a timestamped block to the
  // existing `DimFort` Output channel (the one the LSP client
  // logs into) and reveals it. The Output surface is multi-line,
  // copy-paste-friendly, persistent across invocations (audit
  // trail for support discussions), and non-disruptive (no modal
  // blocking, no toast competing for attention). Sharing the LSP
  // channel keeps the support story to one place: "open Output →
  // DimFort, paste."
  //
  // The channel is owned by ``vscode-languageclient`` and disposed
  // when the client restarts, so we read ``client.outputChannel``
  // at invocation time rather than capturing the reference.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.status", () => {
      const cfg = vscode.workspace.getConfiguration("dimfort");
      const flag = (b: boolean) => (b ? "on" : "off");
      const clientStateName = (s: State | undefined): string => {
        switch (s) {
          case State.Starting: return "Starting";
          case State.Running:  return "Running";
          case State.Stopped:  return "Stopped";
          default:             return "(not started)";
        }
      };
      // Two-column layout: label padded to 18 chars, then `: value`.
      // Matches Nvim/Emacs status formatting so a user familiar with
      // one companion's output recognises this one too.
      const row = (label: string, value: string) =>
        `  ${label.padEnd(18, " ")} : ${value}`;
      const cacheDir = cfg.get<string>("cache.dir", "");
      const body = [
        row("executable",          cfg.get<string>("executable", "dimfort")),
        row("inlay hints",         flag(cfg.get<boolean>("inlayHints.enabled", false))),
        row("completion",          flag(cfg.get<boolean>("completion.enabled", true))),
        row("code actions",        flag(cfg.get<boolean>("codeActions.enabled", true))),
        row("go-to-definition",    flag(cfg.get<boolean>("gotoDefinition.enabled", true))),
        row("hover",               cfg.get<string>("hover", "short")),
        row("cache mode",          cfg.get<string>("cache.mode", "read-write")),
        row("cache dir",           cacheDir === "" ? "(default)" : cacheDir),
        row("scale checking",      cfg.get<string>("scale.mode", "auto")),
        row("coverage layer",      cfg.get<string>("coverage.mode", "disabled")),
        row("panel enabled",       flag(cfg.get<boolean>("panel.enabled", true))),
        row("show.cursor",         flag(cfg.get<boolean>("show.cursor", true))),
        row("show.scope",          flag(cfg.get<boolean>("show.scope", true))),
        row("show.imports",        flag(cfg.get<boolean>("show.imports", true))),
        row("sort mode",           cfg.get<string>("panel.sortMode", "line")),
        row("unit display",        cfg.get<string>("panel.unitDisplayMode", "canonical")),
        row("language client",     clientStateName(client?.state)),
      ].join("\n");
      const ts = new Date().toLocaleTimeString();
      const ch = client?.outputChannel;
      if (ch === undefined) {
        // Pre-activation race: client constructor hasn't run yet.
        // Surface the snapshot to the palette caller anyway so
        // they aren't left with nothing.
        void vscode.window.showInformationMessage(
          "DimFort: language client not yet started; status snapshot " +
          "logged after restart.",
        );
        return;
      }
      ch.appendLine(`\n[${ts}] DimFort status\n${body}\n`);
      // ``preserveFocus = true`` so invoking from the palette
      // doesn't yank focus into the Output panel — the user can
      // glance at the bottom panel and keep editing.
      ch.show(true);
    }),
  );

  // Open Config (0.2.6). Quick-pick for the two project config files
  // (``dimfort.toml`` and a project units file). Each opens if it
  // exists, creates a stub if not. When creating units file: sub-pick
  // for empty vs defaults-as-reference, and auto-wire
  // ``[units].file = "units.toml"`` into ``dimfort.toml`` so the
  // server picks it up immediately. See ``openConfig`` below.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.openConfig", openConfig),
  );
}


// =============================================================================
// dimfort.openConfig — quick-pick + create-or-open + auto-wire.
// =============================================================================

async function openConfig(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage(
      "DimFort: open a workspace folder first; nothing to wire a config into.",
    );
    return;
  }
  // ``id`` instead of ``kind`` — the latter is reserved by
  // ``QuickPickItem`` for separator items.
  interface ConfigPick extends vscode.QuickPickItem {
    id: "dimfortToml" | "unitsFile";
  }
  const picks: ConfigPick[] = [
    { id: "dimfortToml", label: "Project configuration file (dimfort.toml)" },
    { id: "unitsFile",   label: "Project units file (units.toml)" },
  ];
  const pick = await vscode.window.showQuickPick<ConfigPick>(picks, {
    title: "DimFort — Open Config",
    placeHolder: "Which config file?",
  });
  if (!pick) return;
  if (pick.id === "dimfortToml") {
    await openOrCreateDimfortToml(folder.uri);
  } else {
    await openOrCreateUnitsFile(folder.uri);
  }
}

async function openOrCreateDimfortToml(folder: vscode.Uri): Promise<void> {
  const uri = vscode.Uri.joinPath(folder, "dimfort.toml");
  if (await uriExists(uri)) {
    await openInEditor(uri);
    return;
  }
  interface FlavourPick extends vscode.QuickPickItem {
    value: "empty" | "all-sections";
  }
  const flavours: FlavourPick[] = [
    { label: "Empty file",                                value: "empty" },
    { label: "Reference template (all sections commented out)", value: "all-sections" },
  ];
  const flavour = await vscode.window.showQuickPick<FlavourPick>(
    flavours,
    { title: "DimFort — Project configuration file", placeHolder: "Start from?" },
  );
  if (!flavour) return;
  const content = flavour.value === "empty"
    ? dimfortTomlStubEmpty()
    : dimfortTomlStub();
  await writeText(uri, content);
  await openInEditor(uri);
  vscode.window.setStatusBarMessage(
    `DimFort: created ${vscode.workspace.asRelativePath(uri)}`,
    3000,
  );
}

async function openOrCreateUnitsFile(folder: vscode.Uri): Promise<void> {
  const uri = vscode.Uri.joinPath(folder, "units.toml");
  if (await uriExists(uri)) {
    await openInEditor(uri);
    return;
  }
  interface FlavourPick extends vscode.QuickPickItem {
    value: "empty" | "defaults";
  }
  const flavours: FlavourPick[] = [
    { label: "Empty file",                                value: "empty" },
    { label: "Reference template (bundled defaults, all commented out)", value: "defaults" },
  ];
  const flavour = await vscode.window.showQuickPick<FlavourPick>(
    flavours,
    { title: "DimFort — Project units file", placeHolder: "Start from?" },
  );
  if (!flavour) return;
  const content = flavour.value === "empty"
    ? unitsStubEmpty()
    : await unitsStubFromDefaults();
  await writeText(uri, content);
  // Auto-wire dimfort.toml so the server picks up the new file.
  const tomlUri = vscode.Uri.joinPath(folder, "dimfort.toml");
  const wired = await tryWireUnitsFile(tomlUri);
  await openInEditor(uri);
  const rel = vscode.workspace.asRelativePath(uri);
  if (wired === "wired") {
    vscode.window.setStatusBarMessage(
      `DimFort: created ${rel} + wired into dimfort.toml`,
      4000,
    );
  } else if (wired === "exists-with-units-section") {
    void vscode.window.showInformationMessage(
      `DimFort: created ${rel}. Your dimfort.toml already has a [units] section — add 'file = "units.toml"' under it to enable the new file.`,
    );
  } else {
    vscode.window.setStatusBarMessage(
      `DimFort: created ${rel}`,
      3000,
    );
  }
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    // audited(0.2.7): silent-OK — the function's contract is
    // "boolean exists?", so a FileNotFound (or any stat error) IS
    // the negative answer. Caller branches on the return value.
    return false;
  }
}

async function openInEditor(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}

async function writeText(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(
    uri,
    new TextEncoder().encode(content),
  );
}

/**
 * Ensure ``dimfort.toml`` references ``units.toml`` under ``[units].file``.
 *
 * Returns:
 *   "already-wired"             — the file key is already present
 *   "wired"                     — appended ``[units]\nfile = "units.toml"`` (creating the file if necessary)
 *   "exists-with-units-section" — file exists with a ``[units]`` header but no ``file`` key; we don't try to insert into a non-trailing section without a real TOML parser. The caller surfaces a hint to the user.
 */
async function tryWireUnitsFile(
  tomlUri: vscode.Uri,
): Promise<"wired" | "already-wired" | "exists-with-units-section"> {
  let existing = "";
  if (await uriExists(tomlUri)) {
    const bytes = await vscode.workspace.fs.readFile(tomlUri);
    existing = new TextDecoder("utf-8").decode(bytes);
  }
  // ``[units]`` followed by ANY content up to the next ``[section]`` or EOF,
  // looking for a ``file = ...`` line within that span.
  const fileKeyInUnitsRe = /\[units\][^[]*?\n\s*file\s*=/s;
  if (fileKeyInUnitsRe.test(existing)) {
    return "already-wired";
  }
  if (/^\[units\]\s*$/m.test(existing)) {
    // Section exists but no file key. Inserting into the middle of an
    // existing section with string ops is fragile (comment handling, key
    // ordering). Leave it to the user.
    return "exists-with-units-section";
  }
  const sep = existing && !existing.endsWith("\n") ? "\n\n" : (existing ? "\n" : "");
  const next = existing + sep + '[units]\nfile = "units.toml"\n';
  await writeText(tomlUri, next);
  return "wired";
}

function dimfortTomlStubEmpty(): string {
  return [
    "# DimFort project configuration.",
    "#",
    "# Add project-wide settings here. Reference:",
    "#   https://github.com/ArrialVictor/DimFort/blob/main/docs/reference/dimfort-toml.md",
    "",
  ].join("\n");
}

function dimfortTomlStub(): string {
  return [
    "# DimFort project configuration.",
    "#",
    "# Optional. Without this file, DimFort uses bundled defaults for",
    "# everything. Each section below is also optional — uncomment +",
    "# customise as needed. Reference:",
    "#   https://github.com/ArrialVictor/DimFort/blob/main/docs/reference/dimfort-toml.md",
    "",
    "# [units]",
    "# file = \"units.toml\"   # Project units file (extends bundled defaults)",
    "",
    "# [parser]",
    "# # Extra comment delimiters for unit annotations.",
    "# # Defaults already recognise `!< @unit{...}` and friends.",
    "",
    "# [diagnostics]",
    "# # H001 = \"off\"   # Per-code severity overrides",
    "",
    "# [scale]",
    "# # enabled = true   # Enable S001/S002 scale-aware checking",
    "",
    "# [project]",
    "# # src_paths = [\"src\"]   # Narrow the workspace check to these subdirs",
    "",
  ].join("\n");
}

function unitsStubHeader(): string {
  return [
    "# DimFort project units file.",
    "#",
    "# Extends (does not replace) the bundled defaults. To see what's",
    "# already in the defaults, run:  dimfort show-defaults units",
    "#",
    "# Schema:",
    "#   [base]     — base units mapping to SI dimension slots",
    "#                (M / L / T / Theta / I / N / J)",
    "#   [prefixes] — SI prefix multipliers (numeric or \"p/q\" rationals)",
    "#   [derived]  — derived units; `expr` parsed against the table;",
    "#                `prefixable = true` opts in to prefix expansion",
    "#",
    "",
  ].join("\n");
}

function unitsStubEmpty(): string {
  return unitsStubHeader() + [
    "# Example: a custom derived unit.",
    "#",
    "# [derived]",
    "# barrel = { expr = \"159 * L\", prefixable = false }   # US oil barrel",
    "",
  ].join("\n");
}

async function unitsStubFromDefaults(): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("dimfort");
  const executable = cfg.get<string>("executable", "dimfort");
  let defaultsBody = "";
  try {
    const { stdout } = await execFileP(executable, ["show-defaults", "units"]);
    defaultsBody = stdout;
  } catch {
    // audited(0.2.7): silent-OK — dimfort not on PATH, version too
    // old, or non-zero exit. The fallback stub below names the
    // situation explicitly ("Couldn't fetch the bundled defaults…")
    // so the user sees the cause directly in the file they just
    // opened. A separate toast would duplicate the message.
  }
  if (!defaultsBody) {
    return unitsStubEmpty() + [
      "",
      "# (Couldn't fetch the bundled defaults; install or upgrade",
      "#  DimFort, then run `dimfort show-defaults units` to see",
      "#  what's available.)",
      "",
    ].join("\n");
  }
  // Comment every non-comment, non-blank line so the file is a no-op
  // until the user uncomments what they need.
  const commented = defaultsBody.split("\n").map((line) => {
    if (line === "" || line.startsWith("#")) return line;
    return "# " + line;
  }).join("\n");
  return unitsStubHeader() + [
    "# Below: bundled defaults, ALL commented out.",
    "# Uncomment any line to enable, override, or extend.",
    "# To start from scratch instead, delete everything below this banner.",
    "#",
    "",
  ].join("\n") + commented;
}

// True if the configuration change affects any `dimfort.*` setting OTHER
// than the two coverage-only knobs. Used by the config-change listener to
// decide whether a setting flip warrants a full LSP restart (the default)
// or is companion-only (coverage mode / debounce).
function affectsOtherDimfortSettings(
  event: vscode.ConfigurationChangeEvent,
): boolean {
  const namespaces = [
    "dimfort.executable",
    "dimfort.trace.server",
    "dimfort.inlayHints.enabled",
    "dimfort.completion.enabled",
    "dimfort.codeActions.enabled",
    "dimfort.gotoDefinition.enabled",
    "dimfort.hover",
    "dimfort.scale.mode",
    "dimfort.maxWorksetSize",
    "dimfort.externalModules",
    "dimfort.cache.mode",
    "dimfort.cache.dir",
    "dimfort.panel.enabled",
    "dimfort.panel.debounceMs",
  ];
  return namespaces.some((ns) => event.affectsConfiguration(ns));
}

export function deactivate(): Thenable<void> | undefined {
  // audited(0.2.7): silent-OK — extension teardown is a graceful
  // stop; mark the client so the Running → Stopped transition
  // doesn't trip the unexpected-exit toast on the way out.
  if (client) markExpectingStop(client);
  return client?.stop();
}
