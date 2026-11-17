# Building from source

Two outputs: (1) the patched **renderer bundle** (`renderer.js`), built from a Vortex checkout with this patch applied, and (2) the **installer** (`VortexFreeCollections-Setup.exe`), built with Inno Setup from that bundle plus `patch.js`.

## Prerequisites

- **Vortex 2.10.1 source** — clone the repository and check out tag `v2.10.1` (commit `0514276ed038745a059cf5230b289df6b576c87d`).
- **Node 24.22.1** and **pnpm 11.10.0** (Vortex 2.10.1 is a pnpm + nx monorepo).
- **Inno Setup 6** for the installer — `winget install JRSoftware.InnoSetup` (gives `ISCC.exe`).

## 1. Build the patched renderer bundle

From the Vortex checkout:

```bash
# apply this repo's changes on top of Vortex 2.10.1
git apply /path/to/this-repo/patches/free-collections.patch

# install JS deps only — the native modules (loot, winapi-bindings, font-scanner)
# are NOT needed for the renderer bundle and fail on deep Windows paths
pnpm install --ignore-scripts

# build just the renderer (webpack externalizes node_modules)
set NODE_ENV=production
pnpm exec nx build @vortex/renderer --skip-nx-cache
```

The output is `src/main/build/renderer.js`. That is the only built file the patch ships.

> On Windows, clone with `git -c core.autocrlf=false clone https://github.com/Nexus-Mods/Vortex.git` and check out `v2.10.1` before applying the patch. This keeps the source files in the line-ending format expected by `git apply`. Alternatively, copy the files under this repo's `src/` into the matching paths in your Vortex checkout (they are the complete modified/new files) and build the same way.

## 2. Build the installer

Copy the built bundle and the patch script into the installer's `build/` staging folder, then compile:

```bash
copy "src\main\build\renderer.js"   "installer\build\renderer.js"
copy "installer\src\patch.js"       "installer\build\patch.js"
# installer\build\README.txt is already in the repo

"%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" installer\vortexfree.iss
```

The installer lands in `installer\out\VortexFreeCollections-Setup.exe`.

## How the installer applies the patch

`patch.js` runs through the user's own `Vortex.exe` as Node (`ELECTRON_RUN_AS_NODE=1`), so the installer ships **no** Node runtime and no npm dependencies. It has a self-contained, zero-dependency asar reader: it extracts `resources\app.asar` into `resources\app\`, drops the patched `renderer.js` in, and renames the original asar aside as `app.asar.vortexfree-backup`. Reverting (via the uninstaller) renames the backup back and removes the folder. `Vortex.exe` itself is never modified.

`patch.js` can also be run by hand for testing:

```
Vortex.exe patch.js apply  --dir "<vortexInstallDir>" --renderer "<renderer.js>"   (with ELECTRON_RUN_AS_NODE=1)
Vortex.exe patch.js revert --dir "<vortexInstallDir>"
Vortex.exe patch.js check  --dir "<vortexInstallDir>"
```
