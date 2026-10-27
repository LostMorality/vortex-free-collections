Vortex Free Collections Patch
=============================

What it does
------------
Makes Nexus Mods COLLECTIONS download and install automatically on a FREE Nexus
account - the same hands-off experience Nexus sells as Premium's "Auto-download
all". No per-mod pop-ups, no opening a web browser, no userscript manager.

The one thing you still do, once: sign in to nexusmods.com in a small window the
first time a collection needs it. After that it's remembered and collections run
start to finish on their own. (Premium also requires you to be logged in, so this
is not an extra step.)

Download speed stays at Nexus's normal free limit (~3 MB/s). Everything else -
the automatic, no-click behaviour - matches Premium.

Requirements
------------
- Vortex 2.9.1 installed. The installer checks this and warns if it differs.

How to install
--------------
1. Close Vortex.
2. Run VortexFreeCollections-Setup.exe.
3. It finds your Vortex folder automatically (confirm or pick it), then patches it.
4. Start Vortex and install a collection as normal.

Windows may show a blue "Windows protected your PC" box because this installer is
not code-signed. Click "More info" then "Run anyway".

How to undo
-----------
Uninstall "Vortex Free Collections Patch" from Windows Settings > Apps (or
Add/Remove Programs). That restores Vortex's original files exactly. Updating or
reinstalling Vortex also replaces the patched files.

How it works (for the curious)
------------------------------
Vortex is an Electron app. The patch swaps one file - the renderer bundle - inside
Vortex's app files, extracting the app so Electron loads the patched copy. Your
Vortex.exe is never modified, and the original app is kept as a backup
(resources\app.asar.vortexfree-backup) so the change is fully reversible.

This is an unofficial community patch. It is not made by or affiliated with Nexus
Mods or the Vortex team.
