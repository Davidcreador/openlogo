export type ShortcutModalState = {
  documentLibraryOpen: boolean;
  transformDialogOpen: boolean;
  exportDialogOpen: boolean;
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
    libraryOperationPending
  );
}
