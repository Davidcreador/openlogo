/**
 * Clone plain provider-bound data with the platform structured-clone
 * algorithm, then freeze every reachable object. The cycle guard keeps this
 * utility safe for arbitrary provider output as well as Logo Documents.
 */
export function structuredCloneAndDeepFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();

  const visit = (item: unknown): void => {
    if (
      (typeof item !== "object" && typeof item !== "function") ||
      item === null
    ) {
      return;
    }
    if (seen.has(item)) {
      return;
    }
    seen.add(item);

    for (const key of Reflect.ownKeys(item)) {
      visit(Reflect.get(item, key));
    }
    Object.freeze(item);
  };

  visit(value);
  return value;
}
