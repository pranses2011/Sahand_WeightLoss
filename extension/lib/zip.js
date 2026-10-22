const textEncoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function dosDateTime(date) {
  const safeDate = date instanceof Date && !Number.isNaN(date.valueOf()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, safeDate.getFullYear()));
  const time = (safeDate.getHours() << 11)
    | (safeDate.getMinutes() << 5)
    | Math.floor(safeDate.getSeconds() / 2);
  const day = (year - 1980) << 9 | ((safeDate.getMonth() + 1) << 5) | safeDate.getDate();
  return { time, date: day };
}

/**
 * Turn a repository path into a safe ZIP entry path.
 * Git permits unusual names, so unsafe traversal components are replaced rather
 * than dropping the complete filename.
 */
export function sanitizeZipPath(path) {
  const segments = String(path)
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .map((segment) => (segment === ".." ? "__parent__" : segment.replaceAll("\0", "")));

  const safePath = segments.join("/");
  if (!safePath) {
    throw new Error("نام فایل برای قرار گرفتن در ZIP معتبر نیست.");
  }
  return safePath;
}

/**
 * Creates a standards-compliant ZIP archive using the STORE method.
 *
 * Avoiding compression keeps the extension dependency-free and lets Blob keep
 * file buffers as separate parts instead of duplicating an entire large
 * archive in memory. GitHub already compresses most binary assets efficiently.
 */
export function createZip(entries, { modifiedAt = new Date() } = {}) {
  if (!Array.isArray(entries)) {
    throw new TypeError("entries must be an array");
  }
  if (entries.length > 0xffff) {
    throw new Error("تعداد فایل‌ها از محدودیت قالب ZIP بیشتر است.");
  }

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let centralSize = 0;
  const { time, date } = dosDateTime(modifiedAt);

  for (const entry of entries) {
    const name = sanitizeZipPath(entry.name);
    const nameBytes = textEncoder.encode(name);
    const data = entry.data instanceof Uint8Array
      ? entry.data
      : new Uint8Array(entry.data);

    if (nameBytes.length > 0xffff) {
      throw new Error(`نام فایل بیش از حد طولانی است: ${name}`);
    }
    if (data.byteLength > 0xffffffff) {
      throw new Error(`فایل برای ZIP32 بیش از حد بزرگ است: ${name}`);
    }
    if (localOffset + 30 + nameBytes.length + data.byteLength > 0xffffffff) {
      throw new Error("حجم خروجی از محدودیت ۴ گیگابایتی ZIP32 بیشتر است.");
    }

    const checksum = crc32(data);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20); // ZIP 2.0
    writeUint16(localView, 6, 0x0800); // UTF-8 filename
    writeUint16(localView, 8, 0); // STORE
    writeUint16(localView, 10, time);
    writeUint16(localView, 12, date);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, data.byteLength);
    writeUint32(localView, 22, data.byteLength);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, (3 << 8) | 20); // Unix, ZIP 2.0
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0x0800);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, time);
    writeUint16(centralView, 14, date);
    writeUint32(centralView, 16, checksum);
    writeUint32(centralView, 20, data.byteLength);
    writeUint32(centralView, 24, data.byteLength);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0o100644 << 16);
    writeUint32(centralView, 42, localOffset);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    centralSize += centralHeader.byteLength;
    localOffset += localHeader.byteLength + data.byteLength;
  }

  if (localOffset + centralSize > 0xffffffff) {
    throw new Error("حجم خروجی از محدودیت ۴ گیگابایتی ZIP32 بیشتر است.");
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, localOffset);
  writeUint16(endView, 20, 0);

  return new Blob([...localParts, ...centralParts, end], {
    type: "application/zip",
  });
}
