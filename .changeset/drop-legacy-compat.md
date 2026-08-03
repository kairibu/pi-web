---
"@jmfederico/pi-web": patch
---

Drop all backwards-compatibility gates for older PI WEB runtimes. This release is incompatible with older components: upgrade every remote machine first, then the gateway, so all machines and the gateway run the new version together.

Also fixes the session daemon staleness check: a session daemon running an older version than the installed package is now correctly reported as stale, so the restart reminder fires as intended.
