/**
 * Deterministic ZIP container for .tassproj (Modern Build Plan Section 3.5). Same entries,
 * same bytes: fixed 1980-01-01 timestamps, fixed flags, entries written in the caller's
 * (sorted) order, and STORE (method 0) rather than DEFLATE — compression output can vary
 * across zlib builds, and byte-identity of the container is a product guarantee worth more
 * than the disk space. (A future schema generation may add DEFLATE once pinned; the READER
 * already accepts method 8 via node:zlib for that day.)
 *
 * Implements the minimal ZIP subset per the PKWARE APPNOTE structure: local file headers,
 * central directory, end-of-central-directory. UTF-8 names (general-purpose bit 11). No
 * ZIP64: a .tassproj beyond 4 GB is out of scope for schema 1 and rejected loudly.
 */
import { inflateRawSync } from 'node:zlib';
import { TassError } from '@simdad/tass-core';

// CRC-32 (IEEE 802.3 polynomial, the ZIP standard), table-driven.
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) { c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); }
    return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
    /** Forward-slash path inside the archive. */
    name: string;
    data: Buffer;
}

const DOS_DATE = 0x0021; // 1980-01-01, the ZIP epoch: deterministic forever
const DOS_TIME = 0x0000;

/** Write entries (in the given order) to a STORE-only, timestamp-free ZIP buffer. */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const crc = crc32(e.data);
        if (e.data.length > 0xfffffffe || offset > 0xfffffffe) {
            throw TassError.runtime('project/too-large', 'project exceeds the 4 GB schema-1 container limit');
        }
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);   // local file header signature
        local.writeUInt16LE(20, 4);           // version needed
        local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
        local.writeUInt16LE(0, 8);            // method: STORE
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(e.data.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);           // extra length
        parts.push(local, name, e.data);

        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);     // central directory signature
        cen.writeUInt16LE(20, 4);             // version made by
        cen.writeUInt16LE(20, 6);             // version needed
        cen.writeUInt16LE(0x0800, 8);         // flags: UTF-8
        cen.writeUInt16LE(0, 10);             // method
        cen.writeUInt16LE(DOS_TIME, 12);
        cen.writeUInt16LE(DOS_DATE, 14);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(e.data.length, 20);
        cen.writeUInt32LE(e.data.length, 24);
        cen.writeUInt16LE(name.length, 28);
        // extra/comment/disk/attrs all zero
        cen.writeUInt32LE(offset, 42);        // local header offset
        central.push(cen, name);

        offset += local.length + name.length + e.data.length;
    }
    const centralStart = offset;
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(centralStart, 16);
    return Buffer.concat([...parts, centralBuf, eocd]);
}

/** Read a ZIP produced by writeZip (STORE) or a schema-2+ writer (DEFLATE). CRC-verified. */
export function readZip(buf: Buffer): Map<string, Buffer> {
    // Find end-of-central-directory (no comment in our files, but scan defensively).
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) { throw TassError.runtime('project/not-a-container', 'not a .tassproj container (no ZIP end record)'); }
    const count = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);
    const out = new Map<string, Buffer>();
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(pos) !== 0x02014b50) {
            throw TassError.runtime('project/corrupt', 'corrupt container: bad central directory entry');
        }
        const method = buf.readUInt16LE(pos + 10);
        const crc = buf.readUInt32LE(pos + 16);
        const compSize = buf.readUInt32LE(pos + 20);
        const nameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const localOff = buf.readUInt32LE(pos + 42);
        const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
        // Local header: skip its (possibly different) name/extra lengths.
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(dataStart, dataStart + compSize);
        let data: Buffer;
        if (method === 0) { data = Buffer.from(raw); }
        else if (method === 8) { data = inflateRawSync(raw); }
        else { throw TassError.runtime('project/corrupt', `corrupt container: unsupported method ${method} for ${name}`); }
        if (crc32(data) !== crc) {
            throw TassError.runtime('project/corrupt', `corrupt container: CRC mismatch for ${name}`);
        }
        out.set(name, data);
        pos += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}
