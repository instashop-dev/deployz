import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { createZip } from '../src/quick-create/zip.js';

// A Lambda whose Code points at something that is not a real ZIP fails stack
// creation in the CUSTOMER's account ("Could not unzip uploaded file"), after
// the stack has already created IAM roles. These tests check the bytes we
// would publish, since the failure is otherwise only visible in AWS.
describe('createZip', () => {
  const entries = [
    { name: 'index.mjs', content: new TextEncoder().encode('export const handler = () => 1;\n') },
    { name: 'index.mjs.map', content: new TextEncoder().encode('{"version":3}') },
  ];

  it('writes the ZIP signatures and the entry count', () => {
    const zip = createZip(entries);

    expect(zip.readUInt32LE(0)).toBe(0x04034b50); // first local file header
    const eocdOffset = zip.length - 22;
    expect(zip.readUInt32LE(eocdOffset)).toBe(0x06054b50); // end of central directory
    expect(zip.readUInt16LE(eocdOffset + 10)).toBe(entries.length);
  });

  // Reads the archive the way any unzip implementation does — end of central
  // directory, then the central directory, then each local header — rather
  // than trusting the offsets createZip happened to write.
  it('decodes back to the same files, with matching CRCs', () => {
    const zip = createZip(entries);
    const eocdOffset = zip.length - 22;
    let offset = zip.readUInt32LE(eocdOffset + 16);

    for (const entry of entries) {
      expect(zip.readUInt32LE(offset)).toBe(0x02014b50); // central file header
      const nameLength = zip.readUInt16LE(offset + 28);
      const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      const checksum = zip.readUInt32LE(offset + 16);
      const compressedSize = zip.readUInt32LE(offset + 20);
      const localOffset = zip.readUInt32LE(offset + 42);

      expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50); // local file header
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const extraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + extraLength;
      const inflated = inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize));

      expect(name).toBe(entry.name);
      expect(new Uint8Array(inflated)).toEqual(entry.content);
      expect(checksum).toBe(crc32(Buffer.from(entry.content)));
      offset += 46 + nameLength;
    }
  });

  it('is byte-identical for identical input', () => {
    expect(createZip(entries).equals(createZip(entries))).toBe(true);
  });
});
