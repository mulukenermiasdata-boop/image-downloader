/**
 * Builds dist/image-downloader-<version>.zip containing only the files that
 * ship — no tests, tools or editor config. Uses the extension's own ZIP writer.
 *
 *   node tools/package.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const INCLUDE_DIRS = ['src', 'icons'];
const INCLUDE_FILES = ['manifest.json'];

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(path.join(base, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, base, out);
    else out.push(rel);
  }
  return out;
}

const files = [...INCLUDE_FILES];
for (const dir of INCLUDE_DIRS) walk(dir, root, files);
files.sort();

// Load the extension's zip writer the same way the tests do.
const sandbox = {
  console, URL, URLSearchParams, TextEncoder, TextDecoder, Blob, Math, Date, JSON,
  Number, String, Object, Array, Map, Set, Promise, Uint8Array, Uint32Array, DataView, ArrayBuffer, Error, RegExp
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ['constants', 'zip']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'utils', `${file}.js`), 'utf8'), sandbox);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const stamp = new Date(2024, 0, 1, 0, 0, 0); // fixed date -> reproducible archive

const entries = files.map((name) => ({
  name,
  data: new Uint8Array(fs.readFileSync(path.join(root, name))),
  date: stamp
}));

const blob = sandbox.IMGDL.zip.createZip(entries);
const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `image-downloader-${manifest.version}.zip`);
fs.writeFileSync(outFile, Buffer.from(await blob.arrayBuffer()));

console.log(`${entries.length} files -> ${path.relative(root, outFile)} (${fs.statSync(outFile).size} bytes)`);
for (const entry of entries) console.log('  ' + entry.name);
