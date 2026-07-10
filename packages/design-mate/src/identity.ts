import type { LogoDocument } from "@openlogo/core";

export type DocumentIdentity = {
  readonly documentId: string;
  readonly schemaVersion: number;
  readonly generation: number;
  readonly revision: number;
  readonly contentFingerprint: string;
};

export type BuildDocumentIdentityOptions = {
  readonly generation: number;
  readonly revision: number;
};

const FNV_1A_64_OFFSET = 0xcbf29ce484222325n;
const FNV_1A_64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/**
 * JSON-equivalent canonical serialization. Object keys are sorted while array
 * order is retained because artboard order, z-order, and effect order are
 * committed document content.
 */
function canonicalize(value: unknown, ancestors: Set<object>): string | undefined {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "bigint":
      throw new TypeError("Logo Documents cannot contain bigint values.");
    case "object": {
      if (ancestors.has(value)) {
        throw new TypeError("Logo Documents must not contain cyclic values.");
      }
      ancestors.add(value);

      let result: string;
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          items.push(canonicalize(value[index], ancestors) ?? "null");
        }
        result = `[${items.join(",")}]`;
      } else {
        const record = value as Record<string, unknown>;
        const properties: string[] = [];
        for (const key of Object.keys(record).sort()) {
          const item = canonicalize(record[key], ancestors);
          if (item !== undefined) {
            properties.push(`${JSON.stringify(key)}:${item}`);
          }
        }
        result = `{${properties.join(",")}}`;
      }

      ancestors.delete(value);
      return result;
    }
  }
}

function fingerprintCanonicalContent(content: string): string {
  let hash = FNV_1A_64_OFFSET;

  // Feed both bytes of every UTF-16 code unit. This avoids TextEncoder and
  // therefore has no DOM, Web Crypto, Node crypto, or platform dependency.
  for (let index = 0; index < content.length; index += 1) {
    const codeUnit = content.charCodeAt(index);
    hash ^= BigInt(codeUnit & 0xff);
    hash = (hash * FNV_1A_64_PRIME) & UINT64_MASK;
    hash ^= BigInt(codeUnit >>> 8);
    hash = (hash * FNV_1A_64_PRIME) & UINT64_MASK;
  }

  return `fnv1a64-v1:${hash.toString(16).padStart(16, "0")}`;
}

export function buildDocumentIdentity(
  document: LogoDocument,
  options: BuildDocumentIdentityOptions,
): DocumentIdentity {
  const canonicalContent = canonicalize(document, new Set());
  if (canonicalContent === undefined) {
    throw new TypeError("A Logo Document must be a serializable object.");
  }

  return {
    documentId: document.id,
    schemaVersion: document.schemaVersion,
    generation: options.generation,
    revision: options.revision,
    contentFingerprint: fingerprintCanonicalContent(canonicalContent),
  };
}
