/**
 * Refresh resumption: remembers which document the tab was editing so a
 * reload lands back in the editor instead of the dashboard. Scoped to
 * the tab (sessionStorage): new tabs and fresh visits still boot to the
 * dashboard, keeping the cold-start budget intact.
 */
const KEY = "openlogo:editing-document";

export function markEditingSession(documentId: string): void {
  try {
    sessionStorage.setItem(KEY, documentId);
  } catch {
    // Storage may be unavailable (private mode); resumption is best-effort.
  }
}

export function clearEditingSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // See above.
  }
}

export function editingSessionDocumentId(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
