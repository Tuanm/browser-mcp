#!/usr/bin/env bun
/**
 * build-extension.ts - Zip the browser extension into dist/browser-extension.zip
 * (pure JS, store method, dependency-free). The server serves it at GET /extension.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

/** Short git hash of the current commit (used as version_name in the manifest). */
function gitHash(): string {
  try {
    const out = Bun.spawnSync(["git", "rev-parse", "--short=7", "HEAD"], {
      stdout: "pipe",
    });
    const h = (out.stdout || "").toString().trim();
    return /^[0-9a-f]{4,}$/.test(h) ? h : "dev";
  } catch {
    return "dev";
  }
}

const EXT_DIR = join(import.meta.dir, "..", "packages", "browser-extension");
const OUT = join(import.meta.dir, "..", "dist", "browser-extension.zip");
const EXCLUDE = new Set(["README.md", ".DS_Store"]);
const EXCLUDE_DIRS = new Set([".git", "node_modules"]);

// ---- minimal ZIP writer (store, no compression) ----
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function u16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
}
function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function buildZip(
  files: Array<{ name: string; data: Uint8Array }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const crc = crc32(f.data);
    // local file header (signature 0x04034b50)
    locals.push(
      new Uint8Array([
        ...u32(0x04034b50),
        ...u16(20),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(crc),
        ...u32(f.data.length),
        ...u32(f.data.length),
        ...u16(nameBytes.length),
        ...u16(0),
        ...nameBytes,
      ]),
    );
    locals.push(f.data);
    // central directory entry (signature 0x02014b50)
    centrals.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(crc),
        ...u32(f.data.length),
        ...u32(f.data.length),
        ...u16(nameBytes.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...nameBytes,
      ]),
    );
    offset += 30 + nameBytes.length + f.data.length;
  }
  const cdStart = offset;
  const cd = concat(centrals);
  const cdSize = cd.length;
  const eocd = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(cdSize),
    ...u32(cdStart),
    ...u16(0),
  ]); // EOCD
  return concat([...locals, cd, eocd]);
}

function main() {
  if (!existsSync(EXT_DIR)) {
    console.error("extension dir not found: " + EXT_DIR);
    process.exit(1);
  }
  mkdirSync(join(import.meta.dir, "..", "dist"), { recursive: true });
  const files: Array<{ name: string; data: Uint8Array }> = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(full);
      } else {
        if (EXCLUDE.has(entry.name)) continue;
        const rel = relative(EXT_DIR, full).split("\\").join("/"); // PKZIP requires forward slashes
        let data: Uint8Array = readFileSync(full);
        if (rel === "manifest.json") {
          // Tag the build with the git hash so the popup can show it.
          const manifest = JSON.parse(new TextDecoder().decode(data));
          manifest.version_name = gitHash();
          data = new TextEncoder().encode(
            JSON.stringify(manifest, null, 2) + "\n",
          );
        }
        files.push({ name: rel, data });
      }
    }
  }
  walk(EXT_DIR);
  const zip = buildZip(files);
  writeFileSync(OUT, zip);
  console.log(
    "[build-extension] wrote " +
      OUT +
      " (" +
      zip.length +
      " bytes, " +
      files.length +
      " files)",
  );
}

main();
