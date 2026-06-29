/**
 * Surface unexpected LSP-server exits and startup failures.
 *
 * VSCompanion analogue of the Nvim companion's ``on_exit`` handler and
 * the Emacs companion's eglot sentinel + ``eglot--connect`` advice
 * landed in 0.2.7's silent-failure audit. Both lifecycle paths need
 * coverage:
 *
 * - **Startup / pre-handshake** — ``LanguageClient.start()`` rejects
 *   (executable not on PATH, immediate Python crash). Without this
 *   module the rejection vanishes into ``void client.start()`` and
 *   the user sees no signal: every LSP feature is just dead.
 *   ``reportStartFailure`` toasts the error with the most common
 *   causes listed.
 *
 * - **Mid-session exit** — the server is up, then dies (segfault,
 *   SIGKILL, crash mid-handler). vscode-languageclient does fire
 *   ``onDidChangeState`` for this transition but the only visible
 *   surface is a small status-bar indicator; new requests just stop
 *   resolving. ``installServerExitSurfacing`` catches the
 *   ``Running → Stopped`` transition and toasts.
 *
 * Per-(error-shape) deduped via ``_warnedKeys`` so a rapid-retry
 * crash loop doesn't carpet the user. State-transition keys reset
 * once the server reaches ``Running`` again so a post-recovery
 * crash warns afresh. Start-failure keys persist for the session
 * (the user fixes their PATH / extras config, restarts, succeeds).
 *
 * Per-client ``_expectingStop`` flag handles graceful teardowns
 * (rebuilds on settings change, ``dimfort.restartLanguageServer``,
 * extension deactivate) so they don't trip the toast. Callers wrap
 * any intentional ``client.stop()`` in a ``markExpectingStop`` call
 * first.
 *
 * audited(0.2.7): error-surfacing — this module is the fix for the
 * "server died silently" gap. See
 * ``CONTRIBUTING.md`` §"Silent-failure audit" for the three-axis
 * enumeration.
 */
import * as vscode from "vscode";
import { LanguageClient, State } from "vscode-languageclient/node";

const _warnedKeys = new Set<string>();
const _expectingStop = new WeakSet<LanguageClient>();

/**
 * Mark CLIENT as about to be gracefully stopped by us. The next
 * ``Running → Stopped`` transition on this client is treated as
 * normal teardown, not a crash.
 *
 * Must be called BEFORE the ``client.stop()`` await — the state
 * transition fires synchronously off the stop().
 */
export function markExpectingStop(client: LanguageClient): void {
  _expectingStop.add(client);
}

/**
 * Wire the unexpected-exit surfacing for CLIENT.
 *
 * Returns a Disposable for the state-change subscription; callers
 * should push it onto their context.subscriptions or the equivalent
 * lifecycle list so it's cleaned up if the extension deactivates
 * before the server does.
 *
 * Install this BEFORE calling ``client.start()`` so the first
 * Starting → Running transition is captured (used to reset the
 * state-transition dedup memo so a post-recovery crash can warn
 * afresh).
 *
 * The toast carries a "View Output" action item; without one,
 * ``showErrorMessage`` auto-dismisses after a few seconds and the
 * languageclient's own retry notification rotates ours off-screen.
 * Adding the action flips the notification to sticky-until-dismissed
 * AND gives the user a one-click path to the actual error.
 */
export function installServerExitSurfacing(
  client: LanguageClient,
): vscode.Disposable {
  return client.onDidChangeState((evt) => {
    if (evt.newState === State.Running) {
      for (const k of Array.from(_warnedKeys)) {
        if (k.startsWith("state:")) _warnedKeys.delete(k);
      }
      return;
    }
    if (evt.newState !== State.Stopped) return;
    if (_expectingStop.has(client)) {
      _expectingStop.delete(client);
      return;
    }
    if (evt.oldState !== State.Running) return;
    const key = `state:${evt.oldState}->${evt.newState}`;
    if (_warnedKeys.has(key)) return;
    _warnedKeys.add(key);
    void vscode.window
      .showErrorMessage(
        "DimFort: LSP server exited unexpectedly. Common causes: "
          + "a missing 'lsp' extra (pipx install 'dimfort[lsp]') or "
          + "a Python crash mid-handler.",
        "View Output",
      )
      .then((choice) => {
        if (choice === "View Output") client.outputChannel.show(true);
      });
  });
}

/**
 * Surface a ``LanguageClient.start()`` rejection.
 *
 * Use as a ``.catch`` on the start promise. Deduped per error
 * message so retry loops don't multi-toast.
 *
 * ``outputChannel`` is optional only for backwards compatibility of
 * the helper signature; callers in this extension always have it
 * (``client.outputChannel``) and should always pass it so the
 * "View Output" action is offered. When omitted, the toast still
 * sticks (via a no-op action wouldn't help) — we just skip the
 * action button and let the message auto-dismiss; not ideal, but
 * the function stays robust.
 */
export function reportStartFailure(
  err: unknown,
  outputChannel?: vscode.OutputChannel,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  const key = `start:${msg}`;
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  const body =
    "DimFort: LSP server failed to start "
    + `(${msg}). Common causes: the 'dimfort' executable is not on `
    + "PATH (set 'dimfort.executable'), the 'lsp' extra is missing "
    + "(pipx install 'dimfort[lsp]'), or a Python crash before the "
    + "initialize handshake completes.";
  if (outputChannel) {
    void vscode.window
      .showErrorMessage(body, "View Output")
      .then((choice) => {
        if (choice === "View Output") outputChannel.show(true);
      });
  } else {
    void vscode.window.showErrorMessage(body);
  }
}
