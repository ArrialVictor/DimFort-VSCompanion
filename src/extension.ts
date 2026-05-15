import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("dimfort");
  const executable = config.get<string>("executable", "dimfort");

  // No `transport` field: stdio is the default and is what `dimfort lsp`
  // speaks. Setting `transport: TransportKind.stdio` explicitly causes
  // the client to append a `--stdio` arg that DimFort doesn't recognise.
  const serverOptions: ServerOptions = {
    command: executable,
    args: ["lsp"],
  };

  // Per-feature toggles. Read once on startup; changes require a
  // language-server restart (use the "DimFort: Restart Language Server"
  // command after editing settings).
  const initializationOptions = {
    inlayHintsEnabled: config.get<boolean>("inlayHints.enabled", true),
    completionEnabled: config.get<boolean>("completion.enabled", true),
    codeActionsEnabled: config.get<boolean>("codeActions.enabled", true),
    gotoDefinitionEnabled: config.get<boolean>("gotoDefinition.enabled", true),
    codeLensEnabled: config.get<boolean>("codeLens.enabled", true),
    maxWorksetSize: config.get<number>("maxWorksetSize", 40),
    externalModules: config.get<string[]>("externalModules", []),
    backend: config.get<string>("backend", "asr"),
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

  client = new LanguageClient(
    "dimfort",
    "DimFort",
    serverOptions,
    clientOptions
  );

  client.start();
  context.subscriptions.push({
    dispose: () => {
      void client?.stop();
    },
  });

  // Hand-rolled restart command: faster than "Developer: Reload
  // Window" when you've just edited the Python server source.
  context.subscriptions.push(
    vscode.commands.registerCommand("dimfort.restartLanguageServer", async () => {
      if (!client) {
        vscode.window.showWarningMessage("DimFort: no language client to restart.");
        return;
      }
      try {
        await client.restart();
        vscode.window.setStatusBarMessage("DimFort: language server restarted", 2000);
      } catch (err) {
        vscode.window.showErrorMessage(`DimFort: restart failed — ${err}`);
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

  // Per-feature toggles. Each one flips the corresponding setting and
  // restarts the language server so the change takes effect. Visible
  // from the Command Palette as "DimFort: Toggle …".
  const registerToggle = (commandId: string, settingKey: string, label: string) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, async () => {
        const cfg = vscode.workspace.getConfiguration("dimfort");
        const current = cfg.get<boolean>(settingKey, true);
        await cfg.update(settingKey, !current, vscode.ConfigurationTarget.Global);
        if (client) {
          try {
            await client.restart();
          } catch (err) {
            vscode.window.showErrorMessage(`DimFort: restart failed — ${err}`);
            return;
          }
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
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
