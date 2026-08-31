# Duck.ai local API (for a router)

Duck.ai has no official API. This keeps **one** slim Chrome and reuses it.

```powershell
cd "C:\Users\\\larprouter reverse engineer\duck.ai"
node chat.mjs --serve
```

Point the router at:

`http://127.0.0.1:8787/v1`

Same as OpenAI: `POST /v1/chat/completions` with `model` + `messages` (or `prompt`).

Chrome stays visible by default so Duck.ai can pass its bot check. For a background window:

```powershell
$env:HEADLESS="1"
node chat.mjs --serve
```

If you get `418 ERR_CHALLENGE`, run headed (`HEADLESS` unset) and try again. You cannot drop Chrome. Without a real browser Duck.ai blocks the request.
