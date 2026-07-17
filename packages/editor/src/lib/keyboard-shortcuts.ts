export type ShortcutModalState = {
  documentLibraryOpen: boolean;
  transformDialogOpen: boolean;
  exportDialogOpen: boolean;
  commandPaletteOpen?: boolean;
  shortcutOverlayOpen?: boolean;
  contextMenuOpen?: boolean;
};

/** Workspace mutations must never leak through an open modal dialog. */
export function shouldBlockWorkspaceShortcuts(
  state: ShortcutModalState,
  libraryOperationPending: boolean,
): boolean {
  return (
    state.documentLibraryOpen ||
    state.transformDialogOpen ||
    state.exportDialogOpen ||
    state.commandPaletteOpen ||
    state.shortcutOverlayOpen ||
    state.contextMenuOpen ||
    libraryOperationPending
  );
}
