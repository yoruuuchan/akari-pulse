# Artifacts

No compiled or packed binaries are distributed in this repository.

- The watch packages (`akari-pulse-watch-debug-*.rpk`) embed a private ingest token compiled in via `watch/src/config.js` (`bridgeToken`), so shipping them would leak a live credential. Build your own following [../watch/README.md](../watch/README.md) after replacing `REPLACE_WITH_YOUR_INGEST_TOKEN` with your own relay's token.
- The Android bridge APK and the server/MCP `.tgz` packs contain no compiled-in secrets (endpoints and tokens are runtime configuration), but they are omitted for the same reason every binary is: this is a research/reference repository — build from the source in this tree.

`SHA256SUMS.txt` is preserved as the historical record of what was privately built and verified on 2026-08-11 / 2026-08-12; it lists those artifacts by hash even though the bytes themselves are not published.
