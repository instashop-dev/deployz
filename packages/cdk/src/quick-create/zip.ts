/**
 * Minimal ZIP writer for Lambda deployment packages.
 *
 * Lambda requires `Code.S3Bucket`/`S3Key` to point at a real ZIP archive:
 * uploading the raw esbuild bundle fails stack creation with "Could not
 * unzip uploaded file", after the stack has already created IAM roles. The
 * customer sees a rollback with nothing to act on, so the packaging has to
 * be right before anything is published.
 *
 * Deliberately dependency-free: `zlib.deflateRawSync` plus the ZIP container
 * is all a store of a few bundle files needs, and a build-time tool that
 * writes customer-facing artifacts is a poor place to add a dependency.
 *
 * Writes the classic 32-bit format (no ZIP64) — Lambda bundles are megabytes,
 * far below the 4 GB limit where ZIP64 becomes necessary.
 */
import { crc32, deflateRawSync } from 'node:zlib';

/** One file in the archive. */
export interface ZipEntry {
  /** Path inside the archive, always with forward slashes. */
  readonly name: string;
  readonly content: Uint8Array;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const DEFLATE_METHOD = 8;
// Fixed DOS timestamp (1980-01-01). A ZIP built from the same bundle must be
// byte-identical every time, or every publish looks like a changed artifact.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** Builds a ZIP archive containing `entries`, deflate-compressed. */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content);
    const compressed = deflateRawSync(content);
    const checksum = crc32(content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(DEFLATE_METHOD, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(DEFLATE_METHOD, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    // 0644 in the high 16 bits — the unix mode Lambda expects on a plain
    // file. `>>> 0` because a 32-bit shift that reaches the sign bit yields a
    // negative number, which writeUInt32LE rejects.
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // central directory start disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, end]);
}
