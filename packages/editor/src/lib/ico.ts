/**
 * Hand-rolled .ico container. Modern ICO allows PNG-compressed entries
 * (Vista+), so the file is just the ICONDIR header, one ICONDIRENTRY
 * per image, and the raw PNG streams — no BMP/AND-mask encoding needed.
 *
 * Layout (all little-endian):
 *   ICONDIR      6 bytes   reserved=0, type=1 (icon), count
 *   ICONDIRENTRY 16 bytes  w, h (0 means 256), colors=0, reserved=0,
 *                          planes=1, bitcount=32, byte size, file offset
 *   image data             PNG bytes, in entry order
 */

export type IcoImage = {
  /** Square pixel size of the entry (16, 32, 48…, max 256). */
  size: number;
  /** Encoded PNG bytes at exactly that size. */
  png: Uint8Array;
};

const HEADER_SIZE = 6;
const ENTRY_SIZE = 16;

export function buildIco(images: readonly IcoImage[]): Uint8Array {
  const dataSize = images.reduce((sum, image) => sum + image.png.length, 0);
  const out = new Uint8Array(
    HEADER_SIZE + ENTRY_SIZE * images.length + dataSize,
  );
  const view = new DataView(out.buffer);

  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);

  let offset = HEADER_SIZE + ENTRY_SIZE * images.length;
  images.forEach((image, index) => {
    const entry = HEADER_SIZE + ENTRY_SIZE * index;
    const dimension = image.size >= 256 ? 0 : image.size;
    view.setUint8(entry, dimension);
    view.setUint8(entry + 1, dimension);
    view.setUint8(entry + 2, 0); // palette colours (none)
    view.setUint8(entry + 3, 0); // reserved
    view.setUint16(entry + 4, 1, true); // colour planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, image.png.length, true);
    view.setUint32(entry + 12, offset, true);
    out.set(image.png, offset);
    offset += image.png.length;
  });

  return out;
}
