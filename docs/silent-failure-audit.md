# Silent-failure audit — VSCompanion 0.2.7

**Date:** 2026-06-28.
**Scope:** every silent-failure-shaped pattern in `src/` —
`catch {}` / `catch (err) { /* nothing */ }` blocks, fire-and-forget
`void promise` calls on user-action paths, and the missing
`LanguageClient.onDidChangeState` wiring that left mid-session
server crashes invisible.
**Methodology:** mirrors the server-side audit's exhaustive walk
([DimFort/docs/contributor/silent-failure-audit.md](https://github.com/ArrialVictor/DimFort/blob/main/docs/contributor/silent-failure-audit.md))
and applies the lifecycle-enumeration lens before declaring each fix
done. Sibling audits in the Nvim and Emacs companions
([NvimCompanion#33](https://github.com/ArrialVictor/DimFort-NvimCompanion/pull/33),
[EmacsCompanion#34](https://github.com/ArrialVictor/DimFort-EmacsCompanion/pull/34))
shipped the same shape adapted to their APIs.

This file is the written deliverable the audit produces.

## Three-axis enumeration

Per the lesson recorded after five iterations on the Emacs slice
(see PR body), every silent-failure surfacing fix is checked against
three axes before being declared done. The VSCompanion enumeration:

### Axis 1 — Lifecycle entry points

| Path | When it fires | Coverage |
|---|---|---|
| **Startup / pre-handshake** | `LanguageClient.start()` rejects (executable not on PATH, immediate Python crash, missing `[lsp]` extra) | `client.start().catch(reportStartFailure)` in `extension.ts:activate` + same wrap in `doRebuildClient`. Previously `void client.start()` swallowed the rejection. |
| **Mid-session exit** | Server alive then dies (segfault, SIGKILL, Python crash mid-handler). Fires `onDidChangeState: Running → Stopped`. | `installServerExitSurfacing(client)` in `server-exit.ts`. Skips graceful user-initiated stops via the `_expectingStop` WeakSet. |
| **Shutdown (graceful)** | Extension `deactivate`, user runs `dimfort.restartLanguageServer`, settings change rebuilds the client. All call `client.stop()`. | `markExpectingStop(client)` BEFORE every intentional `stop()` (deactivate, doRebuildClient). The state-change handler short-circuits. |
| **Restart** | `dimfort.restartLanguageServer` command, `onDidChangeConfiguration`, `tomlWatcher` events. All route through `rebuildClient`. | Old client: `markExpectingStop` → `stop()`. New client: `installServerExitSurfacing` BEFORE `start()` so the first `Starting → Running` transition is captured (resets the state-transition dedup memo). |
| **Reconnect** | vscode-languageclient's own auto-retry on certain failure modes. | Per-(state-transition) dedup in `_warnedKeys` means a rapid-retry loop toasts once, not N times. The memo resets on `Running` so a post-recovery crash warns afresh. |

### Axis 2 — Display surface

| Surface | Used by | Rationale |
|---|---|---|
| `vscode.window.showErrorMessage` **with a "View Output" action item** (popup, sticky-until-dismissed) | `reportStartFailure`, `installServerExitSurfacing`, `stats.checkWorkspace` wire-error branch, existing `dimfort.restartLanguageServer` failure handler. | "User must act on this" — the LSP can't function until they install `dimfort[lsp]`, restart, or otherwise unblock. **The action item is mandatory** — `showErrorMessage` without items auto-dismisses after ~5–10 s. Adding any item flips the notification to sticky AND gives the user a one-click path to the underlying error in the DimFort Output channel. |
| Custom `errorHandler` in `LanguageClientOptions` (`quietErrorHandler` in `server-exit.ts`) | The library's lifecycle event broadcast | vscode-languageclient's default ErrorHandler fires its own toasts on every transport error and close-decision — 5+ notifications during a missing-`[lsp]`-startup-failure loop ("Pending response rejected", "Server initialization failed", "DimFort client: couldn't create connection", "Restarting server failed", "Server crashed N times in 3 minutes"). All carry the client's `name: "DimFort"` so they look like ours and drown out the single actionable popup. The custom handler keeps the SAME retry policy as the library default but returns `handled: true` on every branch, suppressing those toasts. **This was the audit's biggest single oversight** — see "Cross-component notification noise" below. |
| `setStatusBarMessage` (transient, ~2 s) | success path toasts ("DimFort: cache cleared", "language server restarted"). | Confirmations the user expects; the message gets overwritten next time fine. Not used for failures. |
| `console.warn` / silent return | per-cursor / per-keystroke catches in `coordinator.ts`, `coverage.ts`, `stats.ts:refreshFile`, `section-view.ts:handleReveal`. | High-frequency paths — toast per failed request would carpet the user. Server fatality is surfaced by `installServerExitSurfacing` instead, which bounds the silence. |
| LSP `window/showMessage` (server-initiated) | the `started: false` workspace-check refusal. | Server already toasts the reason ("already in progress" / "index not ready" / "no files found"); VSCode renders that as a popup automatically. Adding a companion-side toast would double-warn. **Silent-OK on the companion side, annotated.** |

### Cross-component notification noise

A lesson the initial audit pass missed and the missing-`[lsp]` Manual test surfaced: **Axis 2 must consider what OTHER components produce notifications on the same lifecycle event, not just our own surface choice.**

The initial audit picked `showErrorMessage` (correct surface, modal-ish popup, action-item-sticky) but assumed our toast would be the only voice on the lifecycle event. It isn't — vscode-languageclient's `DefaultErrorHandler` emits its own toasts at every retry decision, and they share the client's `name` field so they all read as "DimFort: ..." to the user. With 5 library toasts + 1 of ours in the same notification stack, our actionable one is visually buried even when technically sticky.

The lifecycle-enumeration discipline above walked three axes per fix; this finding extends Axis 2 with a fourth check: *"What other components produce notifications on the same lifecycle event, and what's the visual interaction with ours?"* Recorded here so a future audit catches it pre-test.

### Axis 3 — Packaging / install constraint

- **Activation order.** `installServerExitSurfacing(client)` must run BEFORE `client.start()` so the first state transition is observed. Enforced by call ordering in `extension.ts:activate` and `doRebuildClient`.
- **Idempotency across restarts.** Each `LanguageClient` instance gets its own `onDidChangeState` subscription, so the per-client wiring is naturally one-shot. The module-level `_warnedKeys` Set is shared across the session (intentional — same crash shouldn't carpet across restarts).
- **WeakSet for `_expectingStop`.** Per-client flag is held in a `WeakSet<LanguageClient>` so a destroyed client's bit doesn't leak. No manual lifecycle bookkeeping.
- **Dedup reset on recovery.** State-transition keys (prefix `state:`) clear when a client reaches `Running`; start-failure keys persist (the user fixes their PATH and restarts deliberately). Asymmetry is intentional and called out in `server-exit.ts`'s docstring.

## Patterns covered

| # | Pattern | Findings |
|---|---|---|
| 1 | `void client.start()` fire-and-forget | 1 site (extension.ts:activate) — fixed with `.catch(reportStartFailure)` |
| 2 | Missing `LanguageClient.onDidChangeState` wiring | server-exit.ts new module — `installServerExitSurfacing` + `markExpectingStop` |
| 3 | `catch {}` on user-triggered LSP requests | 1 site (stats.ts:229 — workspace check wire error) — fixed with `showErrorMessage` |
| 4 | `started: false` ack silent fallback | 1 site (stats.ts:233-238) — annotated silent-OK (server toasts via `window/showMessage`) |
| 5 | `catch {}` on per-cursor / per-keystroke LSP requests | 5 sites — annotated silent-OK with rationale (toast spam) |
| 6 | `catch {}` on fs / helper functions | 4 sites — annotated silent-OK (encode the negative answer or fall through to documented stub) |

## §1 New module: `server-exit.ts`

| export | purpose |
|---|---|
| `installServerExitSurfacing(client)` | Wires `onDidChangeState` for unexpected `Running → Stopped` transitions. Toasts with actionable hints (missing `[lsp]` extra, Python crash). Skips client-side graceful stops via the `_expectingStop` WeakSet. Returns a `Disposable`. |
| `markExpectingStop(client)` | Tags a client as about to be intentionally stopped. Must be called BEFORE the `client.stop()` await. |
| `reportStartFailure(err)` | Surface a `LanguageClient.start()` rejection. Deduped per error message. Names the most common causes (executable not on PATH, missing `[lsp]` extra, pre-handshake Python crash). |

## §2 Fixes registry

| file:line | level | classification | resolution |
|---|---|---|---|
| extension.ts:activate | `void client.start()` | error-surfacing — startup pre-handshake | Replaced with `.catch(reportStartFailure)`; `installServerExitSurfacing` installed before start |
| extension.ts:doRebuildClient | `await client.start()` (no surfacing) | error-surfacing — startup pre-handshake (rebuild path) | Try/catch wrapping with `reportStartFailure`, then rethrow so caller's own teardown runs |
| extension.ts:doRebuildClient | `await client.stop()` (no mark) | silent-OK — graceful teardown | `markExpectingStop` BEFORE `stop()` so the resulting state transition doesn't trip the unexpected-exit toast |
| extension.ts:deactivate | `client?.stop()` (no mark) | silent-OK — graceful teardown | Same |
| extension.ts:activate subscription dispose | `client?.stop()` (no mark) | silent-OK — graceful teardown | Same |
| stats.ts:229 | `catch {}` on `workspace/executeCommand` | error-surfacing — workspace-check wire error | Toast `"DimFort: workspace check request failed — ${err}"` |

## §3 Silent-OK annotations

| file:line | rationale |
|---|---|
| stats.ts:`!ack.started` branch | Server toasts refusal reason via `window/showMessage` BEFORE returning. VSCode renders as popup; double-warn would be noise. |
| stats.ts:`refreshFile` catch | Per-edit refresh; toast per failure would carpet during any server hiccup. Bar retains prior numbers; server fatality surfaced via `installServerExitSurfacing`. |
| coordinator.ts:`panelInfo` catch | Per-cursor-tick refresh; same rationale. Panel retains previous payload. |
| coordinator.ts:`interactions` catch | Optional secondary payload; primary already rendered from `result`. Empty interactions indistinguishable from "no related sites" for the user. |
| coordinator.ts:`executeCodeActionProvider` catch | The provider call queries every registered provider; failure usually means a non-DimFort extension threw. Suppressing avoids holding the panel hostage. |
| coverage.ts:`lineStatus` catch | Per debounced refresh. Keep last decorations rather than flashing to "no coverage" then back. |
| section-view.ts:`openTextDocument` catch | Webview reveal-line click on a path that's been moved/deleted. Falls back to active editor; cursor staying put is its own signal. |
| derive-root.ts:`fs.statSync` catch | Walk-up hot path; "no marker here, keep walking" is the contract. |
| extension.ts:`rebuildChain` catch | Drops previous rebuild's rejection so the chain advances. Origin already surfaced via `reportStartFailure` or the command's own toast. |
| extension.ts:`uriExists` catch | Function contract is "exists?" → boolean; FileNotFound IS the negative answer. |
| extension.ts:`execFileP` in `unitsStubFromDefaults` | Fallback stub explicitly names "Couldn't fetch the bundled defaults…" in the file the user is about to read; toast would duplicate. |

## What this audit verifies

- ✅ Mid-session server crashes now toast with actionable hints; the
  previous "every LSP feature silently dies" failure mode is now
  observable.
- ✅ `LanguageClient.start()` failures (executable not found, missing
  `[lsp]` extra, immediate Python crash) toast with installation
  guidance instead of vanishing into `void`.
- ✅ Workspace-check wire-level failures surface as a popup; the
  user knows the request didn't make it across instead of guessing
  why the spinner cleared with no numbers.
- ✅ Every silent `catch {}` is either error-surfacing-wired or
  annotated as intentional silent-OK with a documented reason.
- ✅ Graceful teardowns (deactivate, restart, settings rebuild) do
  not double-toast as crashes thanks to the `_expectingStop` flag.

## Carry-forward to 0.2.8

- **CI grep gate.** A separate PR per repo (cross-language) adds a
  workflow step that fails on any new `catch {}` or `void
  someClient.start()` without an `audited(...)` annotation. Same
  shape as the planned server-side gate.
- **Status-bar "server stopped" badge.** The toast is dismissable;
  a passive modeline indicator that persists until the server is
  Running again would catch the case where the user dismissed the
  popup before reading it. Out of scope for 0.2.7.
- **Companion-side log channel.** Today per-cursor / per-keystroke
  catches drop the error entirely (silent-OK by design, to avoid
  toast spam). A companion-owned Output channel — distinct from the
  vscode-languageclient-owned `DimFort` channel — would let those
  paths `log.warning` so a power-user debugging a flaky panel has
  a place to look. Considered for 0.2.8 alongside the server-side
  shared `lsp/notify.py` refactor.

## See also

- [DimFort/docs/contributor/silent-failure-audit.md](https://github.com/ArrialVictor/DimFort/blob/main/docs/contributor/silent-failure-audit.md) — server-side audit this mirrors.
- [DimFort-NvimCompanion#33](https://github.com/ArrialVictor/DimFort-NvimCompanion/pull/33) — sibling Nvim slice (the `on_exit` handler + `workspace/executeCommand` err branch).
- [DimFort-EmacsCompanion#34](https://github.com/ArrialVictor/DimFort-EmacsCompanion/pull/34) — sibling Emacs slice (`eglot-managed-mode-hook` sentinel + `eglot--connect` advice for startup failures).
