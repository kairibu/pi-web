---
"@jmfederico/pi-web": patch
---

Show a sending indicator in the chat while messages with image attachments are uploading. Previously the composer cleared instantly while the upload, server-side image resizing, and first-session open happened in the background, so it looked like nothing was happening. The existing chat activity dock now shows "Sending your message…" during that window (including the folder-mode upload step) and is superseded by the real session activity once the message lands. Attachment sending is now orchestrated in the session controller so there is a single, consistent indicator.
