import type { ReviewScope } from "@openlogo/core";
import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignContext,
  type DesignMateChatMessage,
  type DesignMateChatProviderChunk,
  type DesignMateChatWireRequest,
  type DesignMateConversationMemoryEvent,
  type DesignMateSelection,
  type DesignMateVisualAttachment,
} from "./contracts";
import { DESIGN_CONTEXT_LIMITS } from "./context";
import type { DocumentIdentity } from "./identity";
import { isValidDesignMateProposal } from "./proposal-validation";
import { deepFreeze } from "./snapshot";
import { isValidDesignReview } from "./validation";

type UnknownRecord = Record<string, unknown>;

const CHAT_ROLES = new Set(["user", "assistant"]);
const MEMORY_STATUSES = new Set([
  "prepared",
  "applied",
  "dismissed",
  "rejected",
]);
const ATTACHMENT_KINDS = new Set([
  "selection",
  "active-artboard",
  "document-overview",
]);
const REVIEW_SCOPES = new Set<ReviewScope>([
  "selection",
  "active-artboard",
  "document",
]);
const LOGO_VARIANTS = new Set([
  "primary",
  "icon",
  "wordmark",
  "horizontal",
  "stacked",
]);
const NODE_TYPES = new Set(["rectangle", "ellipse", "path", "text", "group"]);
const PAINT_TYPES = new Set([
  "solid",
  "linear-gradient",
  "radial-gradient",
]);
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const PNG_HEADER_BYTES = 33;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumLength &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isDenseBoundedArray(
  value: unknown,
  maximumLength: number,
  validateItem: (item: unknown, index: number) => boolean,
): value is unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    return false;
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      !validateItem(value[index], index)
    ) {
      return false;
    }
  }
  return true;
}

function isChatId(value: unknown): value is string {
  return isBoundedString(value, DESIGN_MATE_CHAT_LIMITS.chatIdLength);
}

function isReferenceId(value: unknown): value is string {
  return isBoundedString(value, DESIGN_MATE_CHAT_LIMITS.referenceIdLength);
}

function isContextString(value: unknown, maximumLength: number): value is string {
  return isBoundedString(
    value,
    Math.min(maximumLength, DESIGN_MATE_CHAT_LIMITS.contextStringLength),
    true,
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (
    !isBoundedString(
      value,
      DESIGN_MATE_CHAT_LIMITS.timestampLength,
    ) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isDocumentIdentity(value: unknown): value is DocumentIdentity {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "documentId",
      "schemaVersion",
      "generation",
      "revision",
      "contentFingerprint",
    ]) &&
    isReferenceId(value.documentId) &&
    isNonNegativeInteger(value.schemaVersion) &&
    isNonNegativeInteger(value.generation) &&
    isNonNegativeInteger(value.revision) &&
    isBoundedString(
      value.contentFingerprint,
      DESIGN_MATE_CHAT_LIMITS.fingerprintLength,
    )
  );
}

function identitiesEqual(
  left: DocumentIdentity,
  right: DocumentIdentity,
): boolean {
  return (
    left.documentId === right.documentId &&
    left.schemaVersion === right.schemaVersion &&
    left.generation === right.generation &&
    left.revision === right.revision &&
    left.contentFingerprint === right.contentFingerprint
  );
}

function isChatMessage(value: unknown): value is DesignMateChatMessage {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["id", "role", "text", "createdAt"]) ||
    !isChatId(value.id) ||
    typeof value.role !== "string" ||
    !CHAT_ROLES.has(value.role) ||
    !isIsoTimestamp(value.createdAt)
  ) {
    return false;
  }
  const textLimit =
    value.role === "user"
      ? DESIGN_MATE_CHAT_LIMITS.userTextLength
      : DESIGN_MATE_CHAT_LIMITS.assistantTextLength;
  return isBoundedString(value.text, textLimit, true);
}

function isConversationMemoryEvent(
  value: unknown,
): value is DesignMateConversationMemoryEvent {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "id",
      "proposalId",
      "label",
      "status",
      "summary",
      "createdAt",
    ]) &&
    isChatId(value.id) &&
    isReferenceId(value.proposalId) &&
    isBoundedString(value.label, DESIGN_MATE_CHAT_LIMITS.memorySummaryLength) &&
    typeof value.status === "string" &&
    MEMORY_STATUSES.has(value.status) &&
    isBoundedString(
      value.summary,
      DESIGN_MATE_CHAT_LIMITS.memorySummaryLength,
      true,
    ) &&
    isIsoTimestamp(value.createdAt)
  );
}

function decodedBase64Length(value: string): number | null {
  const maximumEncodedLength =
    Math.ceil(DESIGN_MATE_CHAT_LIMITS.attachmentBytes / 3) * 4;
  if (
    value.length === 0 ||
    value.length > maximumEncodedLength ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataEnd = value.length - padding;
  if (padding === 2) {
    const sextet = BASE64_ALPHABET.indexOf(value[dataEnd - 1] ?? "");
    if (sextet < 0 || (sextet & 0x0f) !== 0) {
      return null;
    }
  } else if (padding === 1) {
    const sextet = BASE64_ALPHABET.indexOf(value[dataEnd - 1] ?? "");
    if (sextet < 0 || (sextet & 0x03) !== 0) {
      return null;
    }
  }
  return (value.length / 4) * 3 - padding;
}

function decodeBase64Prefix(value: string, byteCount: number): number[] {
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;
  for (const character of value) {
    if (character === "=") {
      break;
    }
    const sextet = BASE64_ALPHABET.indexOf(character);
    if (sextet < 0) {
      return [];
    }
    bits = (bits << 6) | sextet;
    bitCount += 6;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
      if (bytes.length === byteCount) {
        return bytes;
      }
      bits &= (1 << bitCount) - 1;
    }
  }
  return bytes;
}

function readBigEndianUint32(bytes: ArrayLike<number>, offset: number): number {
  return (
    (bytes[offset]! * 0x1_00_00_00) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

/**
 * Read and validate the fixed PNG signature and IHDR prefix. Checking the
 * encoded dimensions prevents a small compressed payload from lying about a
 * huge image and bypassing the visual-context pixel budget.
 */
export function readDesignMatePngDimensions(
  bytes: ArrayLike<number>,
): { readonly width: number; readonly height: number } | null {
  if (
    bytes.length < PNG_HEADER_BYTES ||
    !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) ||
    readBigEndianUint32(bytes, 8) !== 13 ||
    bytes[12] !== 73 ||
    bytes[13] !== 72 ||
    bytes[14] !== 68 ||
    bytes[15] !== 82
  ) {
    return null;
  }
  const width = readBigEndianUint32(bytes, 16);
  const height = readBigEndianUint32(bytes, 20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const validBitDepth =
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth!)) ||
    (colorType === 2 && (bitDepth === 8 || bitDepth === 16)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth!)) ||
    (colorType === 4 && (bitDepth === 8 || bitDepth === 16)) ||
    (colorType === 6 && (bitDepth === 8 || bitDepth === 16));
  if (
    width <= 0 ||
    height <= 0 ||
    !validBitDepth ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    (bytes[28] !== 0 && bytes[28] !== 1)
  ) {
    return null;
  }
  return { width, height };
}

function isVisualAttachment(
  value: unknown,
  requestIdentity: DocumentIdentity,
): value is DesignMateVisualAttachment {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(
      value,
      [
        "id",
        "kind",
        "mimeType",
        "dataBase64",
        "width",
        "height",
        "byteLength",
        "identity",
      ],
      ["label"],
    ) ||
    !isChatId(value.id) ||
    typeof value.kind !== "string" ||
    !ATTACHMENT_KINDS.has(value.kind) ||
    value.mimeType !== "image/png" ||
    typeof value.dataBase64 !== "string" ||
    !isNonNegativeInteger(value.width) ||
    !isNonNegativeInteger(value.height) ||
    value.width < DESIGN_MATE_CHAT_LIMITS.attachmentMinimumDimension ||
    value.height < DESIGN_MATE_CHAT_LIMITS.attachmentMinimumDimension ||
    value.width > DESIGN_MATE_CHAT_LIMITS.attachmentMaximumDimension ||
    value.height > DESIGN_MATE_CHAT_LIMITS.attachmentMaximumDimension ||
    value.width * value.height > DESIGN_MATE_CHAT_LIMITS.attachmentPixels ||
    !isNonNegativeInteger(value.byteLength) ||
    value.byteLength > DESIGN_MATE_CHAT_LIMITS.attachmentBytes ||
    !isDocumentIdentity(value.identity) ||
    !identitiesEqual(value.identity, requestIdentity) ||
    (hasOwn(value, "label") &&
      !isBoundedString(
        value.label,
        DESIGN_MATE_CHAT_LIMITS.attachmentLabelLength,
      ))
  ) {
    return false;
  }

  const decodedLength = decodedBase64Length(value.dataBase64);
  if (decodedLength === null || decodedLength !== value.byteLength) {
    return false;
  }
  const header = decodeBase64Prefix(value.dataBase64, PNG_HEADER_BYTES);
  const dimensions = readDesignMatePngDimensions(header);
  return (
    dimensions !== null &&
    dimensions.width === value.width &&
    dimensions.height === value.height
  );
}

function isSelection(value: unknown): value is DesignMateSelection {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(
      value,
      ["selectedNodeIds"],
      ["keyObjectId", "activeGroupId"],
    )
  ) {
    return false;
  }
  const ids = new Set<string>();
  if (
    !isDenseBoundedArray(
      value.selectedNodeIds,
      DESIGN_MATE_CHAT_LIMITS.selectionIds,
      (item) => {
        if (!isReferenceId(item) || ids.has(item)) {
          return false;
        }
        ids.add(item);
        return true;
      },
    )
  ) {
    return false;
  }
  return (
    (!hasOwn(value, "keyObjectId") || isReferenceId(value.keyObjectId)) &&
    (!hasOwn(value, "activeGroupId") || isReferenceId(value.activeGroupId))
  );
}

export function isValidDesignMateChatSelection(
  value: unknown,
): value is DesignMateSelection {
  try {
    return isSelection(value);
  } catch {
    return false;
  }
}

function isBounds(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["x", "y", "width", "height"]) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height)
  );
}

function isNullableBounds(value: unknown): boolean {
  return value === null || isBounds(value);
}

function isContextPaint(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["type", "colors", "colorsTruncated"]) &&
    typeof value.type === "string" &&
    PAINT_TYPES.has(value.type) &&
    isDenseBoundedArray(
      value.colors,
      DESIGN_CONTEXT_LIMITS.paintColorsPerNode,
      (color) =>
        isBoundedString(
          color,
          DESIGN_MATE_CHAT_LIMITS.contextStringLength,
          true,
        ),
    ) &&
    typeof value.colorsTruncated === "boolean"
  );
}

function isContextStroke(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["width", "align", "paint"]) &&
    isFiniteNumber(value.width) &&
    (value.align === "center" ||
      value.align === "inside" ||
      value.align === "outside") &&
    isContextPaint(value.paint)
  );
}

function isContextTextDetails(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "content",
      "contentTruncated",
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "letterSpacing",
      "lineHeight",
      "align",
      "onPath",
    ]) &&
    isContextString(value.content, DESIGN_CONTEXT_LIMITS.textContentLength) &&
    typeof value.contentTruncated === "boolean" &&
    isContextString(value.fontFamily, DESIGN_CONTEXT_LIMITS.fontFamilyLength) &&
    isFiniteNumber(value.fontSize) &&
    isFiniteNumber(value.fontWeight) &&
    (value.fontStyle === "normal" || value.fontStyle === "italic") &&
    isFiniteNumber(value.letterSpacing) &&
    isFiniteNumber(value.lineHeight) &&
    (value.align === "left" ||
      value.align === "center" ||
      value.align === "right") &&
    typeof value.onPath === "boolean"
  );
}

function isContextPathDetails(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "fillRule",
      "hasEditableGeometry",
      "subpathCount",
    ]) &&
    (value.fillRule === "nonzero" || value.fillRule === "evenodd") &&
    typeof value.hasEditableGeometry === "boolean" &&
    isNonNegativeInteger(value.subpathCount)
  );
}

function isSelectedNodeArtboard(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "id",
      "name",
      "nameTruncated",
      "purpose",
      "x",
      "y",
      "width",
      "height",
      "background",
    ]) &&
    isReferenceId(value.id) &&
    isContextString(value.name, DESIGN_CONTEXT_LIMITS.nameLength) &&
    typeof value.nameTruncated === "boolean" &&
    typeof value.purpose === "string" &&
    LOGO_VARIANTS.has(value.purpose) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    isBoundedString(
      value.background,
      DESIGN_MATE_CHAT_LIMITS.contextStringLength,
      true,
    )
  );
}

function isSelectedNodeBase(value: UnknownRecord): boolean {
  return (
    isReferenceId(value.id) &&
    isContextString(value.name, DESIGN_CONTEXT_LIMITS.nameLength) &&
    typeof value.nameTruncated === "boolean" &&
    isNullableBounds(value.bounds) &&
    isNullableBounds(value.worldBounds) &&
    (value.artboard === null || isSelectedNodeArtboard(value.artboard)) &&
    isFiniteNumber(value.opacity) &&
    typeof value.visible === "boolean" &&
    typeof value.locked === "boolean"
  );
}

function isSelectedNode(value: unknown): boolean {
  if (
    !isPlainRecord(value) ||
    typeof value.type !== "string" ||
    !NODE_TYPES.has(value.type)
  ) {
    return false;
  }
  const baseKeys = [
    "id",
    "name",
    "nameTruncated",
    "bounds",
    "worldBounds",
    "artboard",
    "opacity",
    "visible",
    "locked",
    "type",
    "rotation",
  ] as const;

  if (value.type === "group") {
    return (
      hasExactKeys(
        value,
        [...baseKeys, "childCount"],
        ["clippingMaskId"],
      ) &&
      isSelectedNodeBase(value) &&
      value.rotation === null &&
      isNonNegativeInteger(value.childCount) &&
      (!hasOwn(value, "clippingMaskId") ||
        isReferenceId(value.clippingMaskId))
    );
  }

  const required =
    value.type === "text"
      ? [...baseKeys, "fill", "text"]
      : value.type === "path"
        ? [...baseKeys, "fill", "path"]
        : value.type === "rectangle"
          ? [...baseKeys, "fill", "cornerRadius"]
          : [...baseKeys, "fill"];
  if (
    !hasExactKeys(value, required, ["stroke"]) ||
    !isSelectedNodeBase(value) ||
    !isFiniteNumber(value.rotation) ||
    !isContextPaint(value.fill) ||
    (hasOwn(value, "stroke") && !isContextStroke(value.stroke))
  ) {
    return false;
  }
  if (value.type === "text") {
    return isContextTextDetails(value.text);
  }
  if (value.type === "path") {
    return isContextPathDetails(value.path);
  }
  return value.type !== "rectangle" || isFiniteNumber(value.cornerRadius);
}

function isDesignBrief(value: unknown): boolean {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(
      value,
      [],
      [
        "brandName",
        "offering",
        "audience",
        "attributes",
        "avoid",
        "competitors",
        "primaryUseCases",
        "mustKeep",
        "constraints",
        "notes",
      ],
    )
  ) {
    return false;
  }
  const proseLimits: Readonly<Record<string, number>> = {
    brandName: DESIGN_CONTEXT_LIMITS.nameLength,
    offering: DESIGN_CONTEXT_LIMITS.briefProseLength,
    audience: DESIGN_CONTEXT_LIMITS.briefProseLength,
    constraints: DESIGN_CONTEXT_LIMITS.briefProseLength,
    notes: DESIGN_CONTEXT_LIMITS.briefProseLength,
  };
  for (const [key, limit] of Object.entries(proseLimits)) {
    if (hasOwn(value, key) && !isContextString(value[key], limit)) {
      return false;
    }
  }
  for (const key of [
    "attributes",
    "avoid",
    "competitors",
    "primaryUseCases",
    "mustKeep",
  ]) {
    if (
      hasOwn(value, key) &&
      !isDenseBoundedArray(
        value[key],
        DESIGN_CONTEXT_LIMITS.briefListItems,
        (item) =>
          isContextString(item, DESIGN_CONTEXT_LIMITS.briefListItemLength),
      )
    ) {
      return false;
    }
  }
  return true;
}

function isContextArtboard(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "id",
      "name",
      "purpose",
      "x",
      "y",
      "width",
      "height",
      "background",
      "topLevelNodeCount",
      "leafNodeCount",
    ]) &&
    isReferenceId(value.id) &&
    isContextString(value.name, DESIGN_CONTEXT_LIMITS.nameLength) &&
    typeof value.purpose === "string" &&
    LOGO_VARIANTS.has(value.purpose) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    isBoundedString(
      value.background,
      DESIGN_MATE_CHAT_LIMITS.contextStringLength,
      true,
    ) &&
    isNonNegativeInteger(value.topLevelNodeCount) &&
    isNonNegativeInteger(value.leafNodeCount)
  );
}

function isContextVariant(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "id",
      "name",
      "purpose",
      "width",
      "height",
      "background",
      "topLevelNodeCount",
    ]) &&
    isReferenceId(value.id) &&
    isContextString(value.name, DESIGN_CONTEXT_LIMITS.nameLength) &&
    typeof value.purpose === "string" &&
    LOGO_VARIANTS.has(value.purpose) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    isBoundedString(
      value.background,
      DESIGN_MATE_CHAT_LIMITS.contextStringLength,
      true,
    ) &&
    isNonNegativeInteger(value.topLevelNodeCount)
  );
}

function isTypography(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["textNodeCount", "fontFamilies", "styles"]) &&
    isNonNegativeInteger(value.textNodeCount) &&
    isDenseBoundedArray(
      value.fontFamilies,
      DESIGN_CONTEXT_LIMITS.typographyFamilies,
      (family) =>
        isPlainRecord(family) &&
        hasExactKeys(family, ["family", "textNodeCount"]) &&
        isContextString(
          family.family,
          DESIGN_CONTEXT_LIMITS.fontFamilyLength,
        ) &&
        isNonNegativeInteger(family.textNodeCount),
    ) &&
    isDenseBoundedArray(
      value.styles,
      DESIGN_CONTEXT_LIMITS.typographyStyles,
      (style) =>
        isPlainRecord(style) &&
        hasExactKeys(style, [
          "fontFamily",
          "fontSize",
          "fontWeight",
          "fontStyle",
          "letterSpacing",
          "lineHeight",
          "textNodeCount",
        ]) &&
        isContextString(
          style.fontFamily,
          DESIGN_CONTEXT_LIMITS.fontFamilyLength,
        ) &&
        isFiniteNumber(style.fontSize) &&
        isFiniteNumber(style.fontWeight) &&
        (style.fontStyle === "normal" || style.fontStyle === "italic") &&
        isFiniteNumber(style.letterSpacing) &&
        isFiniteNumber(style.lineHeight) &&
        isNonNegativeInteger(style.textNodeCount),
    )
  );
}

function isMetrics(value: unknown): boolean {
  const keys = [
    "artboardCount",
    "nodeCount",
    "leafNodeCount",
    "groupNodeCount",
    "textNodeCount",
    "visibleNodeCount",
    "hiddenNodeCount",
    "lockedNodeCount",
    "paletteCount",
    "paletteColorCount",
    "activeArtboardLeafNodeCount",
    "selectedNodeCount",
    "scopeLeafNodeCount",
  ] as const;
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, keys) &&
    keys.every((key) => isNonNegativeInteger(value[key]))
  );
}

function isContextSelection(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(
      value,
      ["selectedNodeCount"],
      ["keyObjectId", "activeGroupId"],
    ) &&
    isNonNegativeInteger(value.selectedNodeCount) &&
    (!hasOwn(value, "keyObjectId") || isReferenceId(value.keyObjectId)) &&
    (!hasOwn(value, "activeGroupId") || isReferenceId(value.activeGroupId))
  );
}

function isSelectionFrame(value: unknown): boolean {
  return (
    value === null ||
    (isPlainRecord(value) &&
      hasExactKeys(value, ["bounds", "rotation"]) &&
      isBounds(value.bounds) &&
      isFiniteNumber(value.rotation))
  );
}

function isTruncation(value: unknown): boolean {
  const keys = [
    "documentText",
    "designBrief",
    "activeArtboard",
    "variants",
    "paletteColors",
    "typographyFamilies",
    "typographyStyles",
    "selectedNodes",
    "selectedNodeText",
  ] as const;
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, keys) &&
    keys.every((key) => typeof value[key] === "boolean")
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

function isDesignContext(
  value: unknown,
  identity: DocumentIdentity,
  scope: ReviewScope,
): value is DesignContext {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "scope",
      "document",
      "designBrief",
      "activeArtboard",
      "variants",
      "paletteColors",
      "typography",
      "metrics",
      "selection",
      "selectedNodes",
      "selectionFrame",
      "truncation",
    ]) ||
    value.scope !== scope ||
    !isPlainRecord(value.document) ||
    !hasExactKeys(value.document, ["id", "name", "schemaVersion"]) ||
    value.document.id !== identity.documentId ||
    value.document.schemaVersion !== identity.schemaVersion ||
    !isContextString(value.document.name, DESIGN_CONTEXT_LIMITS.nameLength) ||
    (value.designBrief !== null && !isDesignBrief(value.designBrief)) ||
    !isContextArtboard(value.activeArtboard)
  ) {
    return false;
  }

  const variantIds = new Set<string>();
  if (
    !isDenseBoundedArray(
      value.variants,
      DESIGN_CONTEXT_LIMITS.variants,
      (variant) => {
        if (!isContextVariant(variant)) {
          return false;
        }
        const id = (variant as { readonly id: string }).id;
        if (variantIds.has(id)) {
          return false;
        }
        variantIds.add(id);
        return true;
      },
    ) ||
    !isDenseBoundedArray(
      value.paletteColors,
      DESIGN_CONTEXT_LIMITS.paletteColors,
      (color) =>
        isBoundedString(
          color,
          DESIGN_MATE_CHAT_LIMITS.contextStringLength,
          true,
        ),
    ) ||
    !isTypography(value.typography) ||
    !isMetrics(value.metrics) ||
    !isContextSelection(value.selection)
  ) {
    return false;
  }

  const selectedIds = new Set<string>();
  if (
    !isDenseBoundedArray(
      value.selectedNodes,
      DESIGN_CONTEXT_LIMITS.selectedNodes,
      (node) => {
        if (!isSelectedNode(node)) {
          return false;
        }
        const id = (node as { readonly id: string }).id;
        if (selectedIds.has(id)) {
          return false;
        }
        selectedIds.add(id);
        return true;
      },
    ) ||
    !isSelectionFrame(value.selectionFrame) ||
    !isTruncation(value.truncation)
  ) {
    return false;
  }

  const serialized = JSON.stringify(value);
  return (
    serialized !== undefined &&
    utf8ByteLength(serialized) <=
      DESIGN_MATE_CHAT_LIMITS.contextSerializedBytes
  );
}

function validateDesignMateChatWireRequest(
  value: unknown,
): value is DesignMateChatWireRequest {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "conversationId",
      "turnId",
      "assistantMessageId",
      "identity",
      "context",
      "review",
      "selection",
      "scope",
      "history",
      "userMessage",
      "attachments",
      "memory",
    ]) ||
    !isChatId(value.conversationId) ||
    !isChatId(value.turnId) ||
    !isChatId(value.assistantMessageId) ||
    !isDocumentIdentity(value.identity) ||
    typeof value.scope !== "string" ||
    !REVIEW_SCOPES.has(value.scope as ReviewScope) ||
    !isSelection(value.selection) ||
    !isChatMessage(value.userMessage) ||
    value.userMessage.role !== "user"
  ) {
    return false;
  }

  const identity = value.identity;
  const messageIds = new Set<string>([value.assistantMessageId]);
  if (
    !isDenseBoundedArray(
      value.history,
      DESIGN_MATE_CHAT_LIMITS.historyMessages,
      (message) => {
        if (
          !isChatMessage(message) ||
          message.text.trim().length === 0 ||
          messageIds.has(message.id)
        ) {
          return false;
        }
        messageIds.add(message.id);
        return true;
      },
    ) ||
    messageIds.has(value.userMessage.id)
  ) {
    return false;
  }
  messageIds.add(value.userMessage.id);

  const memoryIds = new Set<string>();
  if (
    !isDenseBoundedArray(
      value.memory,
      DESIGN_MATE_CHAT_LIMITS.memoryEvents,
      (event) => {
        if (
          !isConversationMemoryEvent(event) ||
          memoryIds.has(event.id)
        ) {
          return false;
        }
        memoryIds.add(event.id);
        return true;
      },
    ) ||
    !isValidDesignReview(value.review)
  ) {
    return false;
  }
  const serializedReview = JSON.stringify(value.review);
  if (
    serializedReview === undefined ||
    utf8ByteLength(serializedReview) >
      DESIGN_MATE_CHAT_LIMITS.reviewSerializedBytes
  ) {
    return false;
  }

  const attachmentIds = new Set<string>();
  if (
    !isDenseBoundedArray(
      value.attachments,
      DESIGN_MATE_CHAT_LIMITS.attachments,
      (attachment) => {
        if (!isVisualAttachment(attachment, identity)) {
          return false;
        }
        const id = (attachment as { readonly id: string }).id;
        if (attachmentIds.has(id)) {
          return false;
        }
        attachmentIds.add(id);
        return true;
      },
    ) ||
    (value.userMessage.text.trim().length === 0 &&
      value.attachments.length === 0) ||
    !isDesignContext(
      value.context,
      identity,
      value.scope as ReviewScope,
    )
  ) {
    return false;
  }
  const serialized = JSON.stringify(value);
  return (
    serialized !== undefined &&
    utf8ByteLength(serialized) <=
      DESIGN_MATE_CHAT_LIMITS.wireSerializedBytes
  );
}

/** Fail-closed runtime guard for untrusted remote chat requests. */
export function isValidDesignMateChatWireRequest(
  value: unknown,
): value is DesignMateChatWireRequest {
  try {
    return validateDesignMateChatWireRequest(value);
  } catch {
    return false;
  }
}

export const isDesignMateChatWireRequest =
  isValidDesignMateChatWireRequest;

/**
 * Validate, clone, validate again, and deeply freeze an untrusted wire value.
 * The second pass prevents accessor or mutation races from entering a snapshot.
 */
export function snapshotValidDesignMateChatWireRequest(
  value: unknown,
): DesignMateChatWireRequest | null {
  try {
    if (!isValidDesignMateChatWireRequest(value)) {
      return null;
    }
    const snapshot: unknown = structuredClone(value);
    return isValidDesignMateChatWireRequest(snapshot)
      ? deepFreeze(snapshot)
      : null;
  } catch {
    return null;
  }
}

export const snapshotDesignMateChatWireRequest =
  snapshotValidDesignMateChatWireRequest;

export function isValidDesignMateChatProviderChunk(
  value: unknown,
): value is DesignMateChatProviderChunk {
  try {
    if (!isPlainRecord(value) || typeof value.type !== "string") {
      return false;
    }
    if (value.type === "text-delta") {
      return (
        hasExactKeys(value, ["type", "delta"]) &&
        isBoundedString(
          value.delta,
          DESIGN_MATE_CHAT_LIMITS.deltaTextLength,
          true,
        ) &&
        value.delta.length > 0
      );
    }
    if (
      value.type !== "proposal-candidate" ||
      !hasExactKeys(value, ["type", "proposal"]) ||
      !isValidDesignMateProposal(value.proposal)
    ) {
      return false;
    }
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      utf8ByteLength(serialized) <=
        DESIGN_MATE_CHAT_LIMITS.proposalSerializedBytes
    );
  } catch {
    return false;
  }
}

export function snapshotValidDesignMateChatProviderChunk(
  value: unknown,
): DesignMateChatProviderChunk | null {
  try {
    if (!isValidDesignMateChatProviderChunk(value)) {
      return null;
    }
    const snapshot: unknown = structuredClone(value);
    return isValidDesignMateChatProviderChunk(snapshot)
      ? deepFreeze(snapshot)
      : null;
  } catch {
    return null;
  }
}
