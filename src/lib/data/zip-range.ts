import { fetchWithTimeout } from "./request";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}
interface RemoteZip {
  url: string;
  start: number;
  size: number;
}

export async function readRange(
  zip: RemoteZip,
  start: number,
  length: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (
    !Number.isInteger(length) ||
    length < 1 ||
    length > 262144 ||
    start < 0 ||
    start + length > zip.size
  )
    throw new Error("Index ZIP invalide");
  const response = await fetchWithTimeout(
    zip.url,
    {
      headers: {
        Range: `bytes=${zip.start + start}-${zip.start + start + length - 1}`,
      },
    },
    signal,
    12000,
  );
  if (response.status !== 206)
    throw new Error("La source 3D ne permet pas l’accès sélectif");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== length) throw new Error("Archive 3D incomplète");
  return buffer;
}

/** Central directories are a few kilobytes; the bulk archive is never buffered. */
export async function zipDirectory(
  zip: RemoteZip,
  signal: AbortSignal,
): Promise<ZipEntry[]> {
  const tailSize = Math.min(131072, zip.size),
    tail = await readRange(zip, zip.size - tailSize, tailSize, signal);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--)
    if (tail.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) throw new Error("Index ZIP 3D absent");
  const offset = tail.readUInt32LE(end + 16),
    size = tail.readUInt32LE(end + 12);
  if (size > 262144 || offset + size > zip.size)
    throw new Error("Index ZIP 3D trop volumineux");
  const directory =
    offset >= zip.size - tailSize
      ? tail.subarray(
          offset - zip.size + tailSize,
          offset - zip.size + tailSize + size,
        )
      : await readRange(zip, offset, size, signal);
  const entries: ZipEntry[] = [];
  for (let at = 0; at + 46 <= directory.length;) {
    if (directory.readUInt32LE(at) !== 0x02014b50)
      throw new Error("Index ZIP 3D corrompu");
    const nameLength = directory.readUInt16LE(at + 28),
      extra = directory.readUInt16LE(at + 30),
      comment = directory.readUInt16LE(at + 32);
    entries.push({
      name: directory.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
      method: directory.readUInt16LE(at + 10),
      compressedSize: directory.readUInt32LE(at + 20),
      size: directory.readUInt32LE(at + 24),
      offset: directory.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

export async function entryDataStart(
  zip: RemoteZip,
  entry: ZipEntry,
  signal: AbortSignal,
): Promise<number> {
  const header = await readRange(zip, entry.offset, 30, signal);
  if (header.readUInt32LE(0) !== 0x04034b50)
    throw new Error("Entrée ZIP 3D invalide");
  const start =
    entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressedSize > zip.size)
    throw new Error("Entrée ZIP 3D tronquée");
  return start;
}

export type { RemoteZip };
