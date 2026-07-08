let counter = 0;

/**
 * Collision-resistant, sortable-ish ids. Good enough for local-first;
 * swap for client-prefixed ids when multiplayer lands.
 */
export function createId(prefix: string): string {
  counter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${random}`;
}
