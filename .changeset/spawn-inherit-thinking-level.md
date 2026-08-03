---
"@jmfederico/pi-web": patch
---

Sessions started via `spawn_session` and `spawn_subsession` now inherit the spawning session's thinking level instead of falling back to the pi default, clamped to the child model's capabilities.
