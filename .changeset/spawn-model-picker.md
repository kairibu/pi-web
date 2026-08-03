---
"@jmfederico/pi-web": patch
---

Let agents pick a model when delegating work: `spawn_session` and `spawn_subsession` accept an optional `model` parameter as an exact `provider/model-id` (an unknown value is rejected; omitting it keeps the inherited model). In the chat composer, typing `#` opens a model completion menu that inserts a `#provider/model-id` reference into the draft, which agents forward as that parameter.
