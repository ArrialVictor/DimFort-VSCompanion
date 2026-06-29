/**
 * Workspace-root derivation for the single-file case (`code foo.f90`
 * with no folder).
 *
 * VSCode's normal flow sets `vscode.workspace.workspaceFolders` from the
 * folders the user opens. When the user opens a single file (e.g. via
 * `code foo.f90`), `workspaceFolders` is empty — and without intervention,
 * the LSP client sends empty `workspaceFolders` to the server, which
 * disables every workspace-scope feature (workspace check, coverage stats,
 * cross-file analysis). The DimFort server already surfaces this with a
 * toast + INFO log, but those tell the user nothing useful is happening
 * rather than *make* something useful happen.
 *
 * This module fixes that by walking up from the first open Fortran-shaped
 * document looking for `dimfort.toml`, falling back to the document's
 * containing directory, and exposing the result as a synthetic
 * `vscode.WorkspaceFolder` the LSP client can use. Matches the Nvim
 * companion's `find_root` and the Emacs companion's
 * `project-find-functions` entry — same `dimfort.toml`-only marker policy
 * landed across the three companions in 0.2.7.
 *
 * Module-level state:
 *
 * - `_rootSource` — `"dimfort.toml"` / `"file dir"` / `null`. Tracks how
 *   the derived root was resolved so the status-bar can surface it.
 * - `_warnedNestedRoots` — per-root dedup memo for the nested-marker
 *   notification (same root never warns twice in one session).
 *
 * Both are intentionally module-private. Reads go through
 * `getRootSourceTag()` and writes happen inside `deriveRootIfNeeded()`.
 * No event emitter — the source is set at most once per extension session
 * (before the LSP client starts) and consumers read it at render time.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

type RootSource = "dimfort.toml" | "file dir";

let _rootSource: RootSource | null = null;
let _rootDir: string | null = null;
const _warnedNestedRoots = new Set<string>();

const FORTRAN_LANGS = new Set([
  "fortran",
  "FortranFreeForm",
  "fortran-modern",
]);

/**
 * Snapshot of the most recent derive-root resolution for diagnostic
 * display (currently the status-bar tooltip). `null` when no
 * derivation has happened — either because a real folder was open
 * (no derivation needed) or because no Fortran document was open
 * yet when ``deriveRootIfNeeded`` last ran.
 */
export interface DerivedRoot {
  /** Resolved root directory. */
  dir: string;
  /** Which marker policy anchored the root. */
  source: RootSource;
}

/** Return the current derived-root snapshot, or `null`. */
export function getDerivedRoot(): DerivedRoot | null {
  if (_rootSource === null || _rootDir === null) {
    return null;
  }
  return { dir: _rootDir, source: _rootSource };
}

/**
 * If the user has no folder open but a Fortran file is, derive a
 * workspace root from the file's path and return it as a synthetic
 * `WorkspaceFolder` the LanguageClient can use as its root. Returns
 * `null` when no derivation is needed (the user already opened a real
 * folder), or when no Fortran document is open yet (lazy activation
 * may race; the next attach attempt re-runs this).
 *
 * Side effects: sets the module-level root-source state so
 * `getRootSourceTag()` reflects the resolution, and may show a one-time
 * information notification when nested `dimfort.toml` files are found.
 */
export function deriveRootIfNeeded(): vscode.WorkspaceFolder | null {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return null;
  }
  const doc = vscode.workspace.textDocuments.find(
    (d) => FORTRAN_LANGS.has(d.languageId) && d.uri.scheme === "file",
  );
  if (!doc) {
    return null;
  }
  const walked = walkUpForMarker(doc.uri.fsPath);
  _rootSource = walked.source;
  _rootDir = walked.rootDir;
  if (walked.source === "dimfort.toml" && walked.nestedAt) {
    surfaceNestedWarning(walked.rootDir, walked.nestedAt);
  }
  return {
    uri: vscode.Uri.file(walked.rootDir),
    name: path.basename(walked.rootDir),
    index: 0,
  };
}

interface WalkResult {
  rootDir: string;
  source: RootSource;
  /** Path to a second `dimfort.toml` strictly above `rootDir`, or null. */
  nestedAt: string | null;
}

/**
 * Walk upward from `filePath` collecting every `dimfort.toml` encountered.
 * Returns the lowest match (preferred root), the source tag, and the
 * next-higher match if any (for nested-warning purposes).
 */
function walkUpForMarker(filePath: string): WalkResult {
  const matches: string[] = [];
  let dir = path.dirname(filePath);
  // Bound the walk by the filesystem-root fixed point: `path.dirname("/")`
  // returns `"/"` on POSIX and the drive root on Windows.
  while (true) {
    const candidate = path.join(dir, "dimfort.toml");
    try {
      if (fs.statSync(candidate).isFile()) {
        matches.push(candidate);
      }
    } catch {
      // audited(0.2.7): silent-OK — stat failure (ENOENT / permission)
      // just means "no marker here"; continue walking. This is the
      // hot path during walk-up so a log call per directory would
      // be pure noise.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  if (matches.length === 0) {
    return {
      rootDir: path.dirname(filePath),
      source: "file dir",
      nestedAt: null,
    };
  }
  return {
    rootDir: path.dirname(matches[0]),
    source: "dimfort.toml",
    nestedAt: matches.length > 1 ? matches[1] : null,
  };
}

/**
 * Show a one-time information notification when the upward walk found a
 * second `dimfort.toml` above the chosen one. Per-root deduped via
 * `_warnedNestedRoots`; same root never warns twice in one session.
 * Information-level (not a toast that needs dismissal — a passive
 * surfacing of the drift).
 */
function surfaceNestedWarning(rootDir: string, nestedAt: string): void {
  if (_warnedNestedRoots.has(rootDir)) {
    return;
  }
  _warnedNestedRoots.add(rootDir);
  const usedAt = path.join(rootDir, "dimfort.toml");
  void vscode.window.showInformationMessage(
    `DimFort: found dimfort.toml at ${usedAt}; note another exists at ${nestedAt} above. The lower one is in effect — the upper one is ignored.`,
  );
}
