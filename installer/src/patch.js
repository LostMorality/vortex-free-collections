/*
 * VortexFree patch applier.
 *
 * Runs as plain Node through the user's OWN Vortex.exe (ELECTRON_RUN_AS_NODE=1), so the installer
 * ships no separate Node runtime and no npm dependencies - this file uses only Node builtins. It
 * patches an installed Vortex 2.9.0 so free accounts get hands-off collection downloads, by swapping
 * the renderer bundle inside the app.
 *
 * How the swap works (and why it's safe): the shipped Vortex.exe has the Electron fuses
 * EnableEmbeddedAsarIntegrityValidation = OFF and OnlyLoadAppFromAsar = OFF, so Electron will load
 * an unpacked resources\app\ folder and won't hash-check it. We extract resources\app.asar into
 * resources\app\, drop the patched renderer.js in, and rename app.asar aside as a backup so the
 * folder wins. Reverting renames the backup back and deletes the folder. The signed Vortex.exe is
 * never touched.
 *
 * Usage (args):
 *   patch.js apply  --dir "<vortexInstallDir>" --renderer "<renderer.js>"
 *   patch.js revert --dir "<vortexInstallDir>"
 *   patch.js check  --dir "<vortexInstallDir>"
 * Exit codes: 0 ok, 2 bad args, 3 layout/looks-wrong, 4 version mismatch, 5 operation failed.
 */
"use strict";

// This script runs through the user's Vortex.exe as Node (ELECTRON_RUN_AS_NODE). Electron patches
// `fs` to treat *.asar as virtual directories, which would make our raw byte-reads of app.asar fail
// with "ENOENT ... not found in app.asar". Turn that off and use Electron's unpatched fs when
// present (original-fs); under plain Node, original-fs doesn't exist and fs behaves normally anyway.
process.noAsar = true;
const fs = (() => {
  try {
    return require("original-fs");
  } catch {
    return require("fs");
  }
})();
const path = require("path");

const BACKUP_NAME = "app.asar.vortexfree-backup";
const MARKER_NAME = ".vortexfree-patched";
const SUPPORTED_VERSION = "2.9.0";

// ---- self-contained asar reader (no @electron/asar dependency) ------------------------------
//
// asar layout: [8-byte size pickle][header pickle (JSON file tree)][concatenated file data].
// A pickle is a 4-byte LE payload length followed by the payload; readUInt32 reads the 4 bytes
// after that length, and a string is a 4-byte length then the UTF-8 bytes. Files flagged
// "unpacked" live beside the archive in "<archive>.unpacked" instead of inside it. This mirrors
// @electron/asar's readArchiveHeaderSync / readFileSync exactly (see lib/disk.js).

function readAsarHeader(archivePath) {
  const fd = fs.openSync(archivePath, "r");
  try {
    const sizeBuf = Buffer.alloc(8);
    if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) {
      throw new Error("could not read asar size header");
    }
    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) {
      throw new Error("could not read asar header");
    }
    const strLen = headerBuf.readUInt32LE(4);
    const json = headerBuf.toString("utf8", 8, 8 + strLen);
    return { header: JSON.parse(json), dataBase: 8 + headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

/** Extract every file in the archive (packed and unpacked) into destDir. */
function extractAsar(archivePath, destDir) {
  const { header, dataBase } = readAsarHeader(archivePath);
  const unpackedRoot = archivePath + ".unpacked";
  const fd = fs.openSync(archivePath, "r");
  try {
    const walk = (node, relParts) => {
      const outDir = path.join(destDir, ...relParts);
      fs.mkdirSync(outDir, { recursive: true });
      for (const name of Object.keys(node.files || {})) {
        const entry = node.files[name];
        const parts = relParts.concat(name);
        if (entry.files !== undefined) {
          walk(entry, parts);
        } else if (entry.link !== undefined) {
          // symlink inside the archive; Vortex's Windows build has none, so record and skip
          console.error("WARN: skipping symlink entry " + parts.join("/"));
        } else {
          const outFile = path.join(destDir, ...parts);
          if (entry.unpacked === true) {
            fs.copyFileSync(path.join(unpackedRoot, ...parts), outFile);
          } else {
            const size = entry.size | 0;
            const buf = Buffer.alloc(size);
            if (size > 0) {
              const offset = dataBase + parseInt(entry.offset, 10);
              let read = 0;
              while (read < size) {
                const n = fs.readSync(fd, buf, read, size - read, offset + read);
                if (n <= 0) {
                  throw new Error("short read extracting " + parts.join("/"));
                }
                read += n;
              }
            }
            fs.writeFileSync(outFile, buf);
          }
        }
      }
    };
    walk(header, []);
  } finally {
    fs.closeSync(fd);
  }
}

// ---- cli ------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dir") {
      out.dir = argv[++i];
    } else if (a === "--renderer") {
      out.renderer = argv[++i];
    } else if (a === "--force") {
      out.force = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fail(code, msg) {
  console.error("ERROR: " + msg);
  process.exit(code);
}

function ok(msg) {
  console.log(msg);
}

/** Resolve and sanity-check the Vortex install layout from an install dir. */
function layout(dir) {
  if (!dir) {
    fail(2, "no --dir given");
  }
  const root = path.resolve(dir);
  const exe = path.join(root, "Vortex.exe");
  const resources = path.join(root, "resources");
  const asarPath = path.join(resources, "app.asar");
  const appDir = path.join(resources, "app");
  const backup = path.join(resources, BACKUP_NAME);
  const marker = path.join(appDir, MARKER_NAME);
  if (!fs.existsSync(exe) || !fs.existsSync(resources)) {
    fail(3, "that folder doesn't look like a Vortex install (no Vortex.exe / resources): " + root);
  }
  return { root, exe, resources, asarPath, appDir, backup, marker };
}

/** Read Vortex.exe's ProductVersion from the PE version resource (no external tools). */
function exeVersion(exe) {
  try {
    const buf = fs.readFileSync(exe);
    const needle = Buffer.from("ProductVersion\0", "utf16le");
    const idx = buf.indexOf(needle);
    if (idx === -1) {
      return undefined;
    }
    const start = idx + needle.length;
    const slice = buf.subarray(start, start + 64);
    const s = slice.toString("utf16le").replace(/\0/g, " ").trim().split(/\s{2,}/)[0].trim();
    const m = s.match(/\d+\.\d+\.\d+(\.\d+)?/);
    return m ? m[0] : undefined;
  } catch {
    return undefined;
  }
}

function rmrf(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function doApply(args) {
  const L = layout(args.dir);

  const ver = exeVersion(L.exe);
  if (!args.force && ver !== undefined && !ver.startsWith(SUPPORTED_VERSION)) {
    fail(
      4,
      "this patch is built for Vortex " +
        SUPPORTED_VERSION +
        " but the install reports " +
        ver +
        ". Not patching.",
    );
  }

  if (!args.renderer || !fs.existsSync(args.renderer)) {
    fail(2, "missing or unreadable --renderer bundle: " + args.renderer);
  }

  const alreadyPatched = fs.existsSync(L.backup);

  try {
    if (!alreadyPatched) {
      rmrf(L.appDir); // clear any stale app\ from a half-finished run so extraction is clean
      ok("Extracting app.asar (one-time, ~260 MB) ...");
      extractAsar(L.asarPath, L.appDir);
      fs.renameSync(L.asarPath, L.backup);
      ok("Backed up original app.asar -> " + BACKUP_NAME);
    } else {
      ok("Already patched before; refreshing the renderer bundle only.");
      if (!fs.existsSync(L.appDir)) {
        fail(3, "backup exists but resources\\app is missing; run revert first to restore.");
      }
    }

    fs.copyFileSync(args.renderer, path.join(L.appDir, "renderer.js"));
    const staleMap = path.join(L.appDir, "renderer.js.map");
    if (fs.existsSync(staleMap)) {
      fs.rmSync(staleMap, { force: true });
    }
    fs.writeFileSync(
      L.marker,
      JSON.stringify(
        { patchedAt: new Date().toISOString(), forVersion: SUPPORTED_VERSION },
        null,
        2,
      ),
    );
    ok("PATCH-OK");
  } catch (err) {
    fail(5, "apply failed: " + (err && err.message ? err.message : String(err)));
  }
}

function doRevert(args) {
  const L = layout(args.dir);
  try {
    if (fs.existsSync(L.backup)) {
      rmrf(L.appDir);
      if (fs.existsSync(L.asarPath)) {
        fs.rmSync(L.asarPath, { force: true });
      }
      fs.renameSync(L.backup, L.asarPath);
      ok("REVERT-OK (restored original app.asar)");
    } else {
      ok("REVERT-NOOP (no backup found; nothing to restore)");
    }
  } catch (err) {
    fail(5, "revert failed: " + (err && err.message ? err.message : String(err)));
  }
}

function doCheck(args) {
  const L = layout(args.dir);
  const ver = exeVersion(L.exe) || "unknown";
  const patched = fs.existsSync(L.backup) && fs.existsSync(L.marker);
  ok(JSON.stringify({ version: ver, supported: ver.startsWith(SUPPORTED_VERSION), patched }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === "apply") {
    doApply(args);
  } else if (cmd === "revert") {
    doRevert(args);
  } else if (cmd === "check") {
    doCheck(args);
  } else {
    fail(2, "unknown command: " + cmd + " (use apply | revert | check)");
  }
}

// only run the CLI when invoked directly, so the extractor can be unit-tested via require()
if (require.main === module) {
  main();
}

module.exports = { extractAsar, readAsarHeader, exeVersion };
