import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

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

  const initializationOptions = {
    inlayHintsEnabled: config.get<boolean>("inlayHints.enabled", true),
    completionEnabled: config.get<boolean>("completion.enabled", true),
    codeActionsEnabled: config.get<boolean>("codeActions.enabled", true),
    gotoDefinitionEnabled: config.get<boolean>("gotoDefinition.enabled", true),
    codeLensEnabled: config.get<boolean>("codeLens.enabled", true),
    traceHoverEnabled: config.get<boolean>("trace.enabled", false),
    hoverFunctionCalls: config.get<string>("hover.functionCalls", "short"),
    hoverSubroutineCalls: config.get<string>("hover.subroutineCalls", "short"),
    hoverExpressions: config.get<string>("hover.expressions", "short"),
    maxWorksetSize: config.get<number>("maxWorksetSize", 40),
    externalModules: config.get<string[]>("externalModules", []),
  };

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
async function rebuildClient(): Promise<void> {
  if (client) {
    try {
      await client.stop();
    } catch {
      // Ignore: stop() can throw if the previous start failed half-way,
      // which is fine — we're tearing it down anyway.
    }
  }
  client = buildClient();
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

  // Settings that ship as initializationOptions can only be re-read by
  // restarting the server. Watch the `dimfort.*` namespace and reload
  // transparently when any of them change — the user gets immediate
  // feedback instead of having to run "Restart Language Server".
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("dimfort")) return;
      try {
        await rebuildClient();
      } catch (err) {
        vscode.window.showErrorMessage(`DimFort: reload after settings change failed — ${err}`);
      }
    }),
  );

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
  // in initialize's executeCommandProvider.commands), so we do NOT
  // register it here — that would collide and abort activation. The
  // package.json `contributes.commands` entry is what makes it visible
  // in the palette; clicking it goes through the language client to
  // the server's `@server.command` handler via workspace/executeCommand.

  // Per-feature toggles. Each one flips the corresponding setting and
  // *rebuilds* the language client so the new value reaches the LSP.
  // Visible from the Command Palette as "DimFort: Toggle …".
  const registerToggle = (commandId: string, settingKey: string, label: string) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, async () => {
        const cfg = vscode.workspace.getConfiguration("dimfort");
        const current = cfg.get<boolean>(settingKey, true);
        await cfg.update(settingKey, !current, vscode.ConfigurationTarget.Global);
        try {
          await rebuildClient();
        } catch (err) {
          vscode.window.showErrorMessage(`DimFort: restart failed — ${err}`);
          return;
        }
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
  registerToggle("dimfort.toggleCodeLens",       "codeLens.enabled",       "code lens");
  registerToggle("dimfort.toggleTrace",          "trace.enabled",          "full unit trace");
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
