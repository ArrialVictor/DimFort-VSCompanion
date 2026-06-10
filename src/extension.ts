import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import { CoverageProvider } from "./coverage";
import { DimFortPanelProvider } from "./panel";
import { CoverageStatsProvider } from "./stats";

let client: LanguageClient | undefined;
let panelProvider: DimFortPanelProvider | undefined;
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
  // `.dimfort.toml` (omit the option so the server's config wins);
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
  };

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
  rebuildChain = rebuildChain.catch(() => undefined).then(doRebuildClient);
  return rebuildChain;
}

async function doRebuildClient(): Promise<void> {
  if (client) {
    try {
      await client.stop();
    } catch {
      // Ignore: stop() can throw if the previous start failed half-way,
      // which is fine — we're tearing it down anyway.
    }
  }
  client = buildClient();
  panelProvider?.setClient(client);
  coverageProvider?.setClient(client);
  statsProvider?.setClient(client);
  await client.start();
}

export function activate(context: vscode.ExtensionContext): void {
  client = buildClient();
  void client.start();
  context.subscriptions.push({
    dispose: () => {
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

  // Side panel — a webview view fed by the dimfort/panelInfo request.
  panelProvider = new DimFortPanelProvider(context.extensionUri, statsProvider);
  panelProvider.setClient(client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DimFortPanelProvider.viewType,
      panelProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  // Cursor-follow: refresh the panel (debounced) as the selection moves
  // or the active editor changes.
  const debounceMs = vscode.workspace
    .getConfiguration("dimfort")
    .get<number>("panel.debounceMs", 200);
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() =>
      panelProvider?.scheduleUpdate(debounceMs),
    ),
    vscode.window.onDidChangeActiveTextEditor(() =>
      panelProvider?.scheduleUpdate(0),
    ),
  );
  // Toggle / focus command.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.togglePanel", () => {
      void vscode.commands.executeCommand("dimfort.panel.focus");
    }),
  );
  // Panel shown by default (package.json `panel.enabled` defaults to
  // true): reveal the DimFort view container on activation unless the
  // user opted out.
  if (
    vscode.workspace.getConfiguration("dimfort").get<boolean>("panel.enabled", true)
  ) {
    void vscode.commands.executeCommand("dimfort.panel.focus");
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
      // Panel sort changes are pure UI — push to the webview, never
      // restart the language server.
      const sortOnly =
        (event.affectsConfiguration("dimfort.panel.scopeSortMode") ||
          event.affectsConfiguration("dimfort.panel.importsSortMode")) &&
        !affectsOtherDimfortSettings(event) &&
        !event.affectsConfiguration("dimfort.coverage.mode") &&
        !event.affectsConfiguration("dimfort.coverage.debounceMs");
      if (sortOnly) {
        panelProvider?.applySortModesFromConfig();
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

  // The server reads project config (`.dimfort.toml`: units file,
  // [diagnostics] severities, [scale] enabled, …) only at initialize, so
  // edits to it need a server restart to take effect. Watch the file and
  // rebuild on change/create/delete — same transparent reload the
  // `dimfort.*` settings get, so users don't have to run Restart manually.
  const tomlWatcher = vscode.workspace.createFileSystemWatcher("**/.dimfort.toml");
  const reloadOnToml = async () => {
    try {
      await rebuildClient();
    } catch (err) {
      vscode.window.showErrorMessage(`DimFort: reload after .dimfort.toml change failed — ${err}`);
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

  // Workspace-wide check: the language client AUTOMATICALLY registers
  // `dimfort.checkWorkspace` (and every other command the server lists
  // in initialize's executeCommandProvider.commands) — so DO NOT
  // ``registerCommand`` it again here (would collide and abort
  // activation). The auto-registered command exists in VSCode's
  // command registry and can be invoked programmatically, but the
  // user-facing palette entry points instead at the companion-side
  // ``dimfort.refreshWorkspace`` command below — that wrapper drives
  // the bar's dimmed "computing…" state around the call.

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
  // registerToggle. The palette toggle flips between off and
  // read-write — the most useful binary distinction — while
  // read-only is reachable through the settings UI for the rare
  // case where a user wants to consult the cache without populating it.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.toggleCache", async () => {
      const cfg = vscode.workspace.getConfiguration("dimfort");
      const current = cfg.get<string>("cache.mode", "off");
      const next = current === "off" ? "read-write" : "off";
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
  // defers to the project .dimfort.toml; "on"/"off" override it. Cycles
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

  // Manual workspace refresh. The companion's VSCode command (this
  // one) wraps the LSP call so we can manage bar UI state
  // (wsRefreshing → dimmed + spinner + "computing…") around it.
  // The server-side command ``dimfort.checkWorkspace`` also exists
  // and is auto-registered by vscode-languageclient as a VSCode
  // command, but it doesn't drive the bar UI on its own — hence
  // the separate companion-side id. Since the server's command
  // also publishes diagnostics + seeds the workspace coverage
  // cache + returns the payload, one invocation now refreshes
  // *both* squiggles and the bar.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.refreshWorkspace", () => {
      void statsProvider?.refreshWorkspace();
    }),
  );
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
  return client?.stop();
}
