# Vortex Free Collections Patch

A small, reversible patch for [Vortex Mod Manager](https://github.com/Nexus-Mods/Vortex) **2.9.1** that gives a **free Nexus account** the hands-off download conveniences Nexus otherwise sells as Premium. No per-mod pop-ups, no opening a web browser, no userscript manager.

**What it unlocks for free accounts:**

- **Collections** download and install automatically, start to finish (Premium's "Auto-download all").
- **Update All** — one click updates every mod with a newer version, downloaded in-app.
- **1-click install** of health-check / required files, instead of the "Go Premium" prompt.
- **Parallel downloads** (up to 10) instead of being capped at 1, and the "Go Premium" nags removed.

Everything downloads inside Vortex's own download manager — never a browser hand-off. The one thing you still do, once: sign in to nexusmods.com in a small window the first time a download needs it. After that it's remembered and runs on its own. (Premium needs you logged in too, so it isn't an extra step.)

Per-file **speed** is Nexus's free-tier rate (~3 MB/s) — that's enforced on Nexus's servers and can't be lifted without real Premium — but unlocking parallel downloads lets several files pull at once, so a collection or an Update All finishes much faster overall.

> **Unofficial community patch.** Not made by, or affiliated with, Nexus Mods or the Vortex team.

---

## See it working

A full Nexus collection installed on a **free** account — every mod auto-downloaded and **Enabled**, no per-mod pop-ups and no browser:

![A Nexus collection fully installed and enabled in Vortex's Mods view](docs/mods.png)

The collections themselves, both showing **Enabled** after a hands-off install:

![Installed collections enabled in Vortex](docs/collections.png)

---

## Install (easiest)

1. Grab `VortexFreeCollections-Setup.exe` from the [Releases](../../releases) page.
2. Close Vortex.
3. Run the installer. It finds your Vortex folder automatically (confirm or pick it), then patches it.
4. Start Vortex and install a collection as normal.

Windows may show a blue **"Windows protected your PC"** box because the installer is not code-signed. Click **More info → Run anyway**.

**To undo:** uninstall *"Vortex Free Collections Patch"* from Windows Settings → Apps. That restores Vortex's original files exactly. Updating or reinstalling Vortex also replaces the patched files.

Requires **Vortex 2.9.1**. The installer checks the version and warns if it differs. A Vortex auto-update replaces the patched files, so just re-run the installer after Vortex updates itself.

---

## How it works

Vortex is an Electron app. On a free account the normal "download" button hands collection mods off to a browser; Premium skips that. The website's own *slow-download* button, though, mints a ready-to-use signed CDN link via:

```
POST https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl
body: fid=<fileId>&game_id=<numericGameId>&nmm=1
```

with your website login cookies. This patch runs that same request from a hidden, logged-in web session inside Vortex and feeds the resulting link straight into Vortex's existing download pipeline — so a free account gets the same automatic flow Premium does. Requests are paced to stay within Nexus's limits, and the link is checked to belong to the signed-in account before use.

The same approach powers **Update All** and the other unlocked buttons: the premium-only *feature gates* in the UI are opened, but the account stays honestly "free" so every download keeps using this website-link method. (Forcing the account flag to premium instead would make Vortex call the Premium-only download API, which a free account is 403'd on — so the real `isPremium` check still drives download *routing*.)

The code lives in `src/renderer/src/extensions/nexus_integration/freeDownload/` and hooks `nxmProtocol.ts`; the premium-gate removals are in `eventHandlers.ts`, `selectors.ts`, the mod-management toolbar, and download settings. See [`patches/free-collections.patch`](patches/free-collections.patch) for the exact diff against Vortex 2.9.1.

The installer never touches the signed `Vortex.exe`. It swaps one file — the renderer bundle — inside Vortex's app files (Vortex 2.9.1 ships with the Electron asar-integrity and `onlyLoadAppFromAsar` fuses off, so an unpacked `resources\app\` folder loads cleanly) and keeps the original as a backup for a clean revert.

---

## Build from source

See [`installer/BUILD.md`](installer/BUILD.md). In short: clone Vortex at the 2.9.1 tag, apply `patches/free-collections.patch`, build the renderer bundle, then build the installer with Inno Setup.

---

## License & attribution

Vortex is licensed **GPL-3.0**, and so is this patch — see [`LICENSE`](LICENSE). The patched source (the files under `src/` and the diff in `patches/`) is the corresponding source for the modification, on top of upstream Vortex 2.9.1 (`Nexus-Mods/Vortex`, tag `v2.9.1`). Vortex and the Nexus Mods name are trademarks of their respective owners; this project is not endorsed by them.

**Use at your own risk.** Automating free downloads may be against the Nexus Mods terms of service, and sharing or using this tool could put your account at risk or draw a takedown. You are responsible for how you use it.
