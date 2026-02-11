## Chat composer / messages — dev checklist

### Paste (multiline + images)
- **Multiline text**: paste 3–10 lines from Notion / Telegram Desktop / VS Code — line breaks stay (not collapsed into spaces).
- **Text + image**: copy a paragraph + image, paste into composer — image attaches and text stays.
- **Image only**: copy image, paste — attachment is added, no stray characters appear in text.

### Typing indicator
- **Start/stop**: begin typing → other side sees typing; stop typing ~2s → indicator disappears.
- **No spam**: keep typing continuously → network events are throttled (not on every keystroke).
- **Blur/submit**: click outside composer or submit message → typing stops immediately.

### Edit messages
- **ArrowUp**: focus empty composer → press ArrowUp → last own message switches to edit mode.
- **Context menu**: right-click / long-tap own message → "Редактировать" opens edit mode.
- **Cancel**: Esc or "Отмена" exits edit mode without changing message.
- **Save**: Enter saves (Shift+Enter makes newline). After save message shows "изменено".
- **Permissions**: cannot edit someone else’s messages; editing deleted messages shows error and exits edit mode.

### Markdown-lite
- **Bold**: select text → Ctrl+B wraps with `**...**` and renders as bold.
- **Italic**: select text → Ctrl+I wraps with `*...*` and renders italic.
- **Code**: inline/backticks and fenced blocks render; HTML is sanitized (no scripts).
- **Line breaks**: single `\n` renders as `<br>` (Discord-like).

### Attachments
- **Preview bar**: paste/upload multiple images → thumbnails appear; each can be removed.
- **DnD**: drag files over composer → drop hint appears; drop attaches files.
- **Empty text**: sending message with attachments and empty text works.

