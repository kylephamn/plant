# Auth-less Multi-Device Sync

Watering and outdoor state should be the same on your phone and laptop without a login. The approach: a short random **sync token** you paste once on each device, used as a namespace key in Workers KV.

---

## How it works

1. On first visit, the app generates a random token (e.g. `plant-x7k2m9`) and shows it to you.
2. You copy it and paste it on your other device — one time, in a settings field.
3. All reads/writes to `/watering` and `/outdoor` include the token as a query param: `?t=x7k2m9`.
4. The worker prefixes every KV key with the token: `x7k2m9:watering:state`, `x7k2m9:outdoor:state`.
5. Anyone with the token can read and write your data — there's no auth beyond possession of the token.

---

## Token format

```
plant-[8 random alphanumeric chars]
```

Generated in the browser:
```js
function generateToken() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no confusable chars
  return 'plant-' + Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => chars[b % chars.length]).join('');
}
```

Store in `localStorage` under key `sync_token`. If none exists, generate one on first load.

---

## Frontend changes

### `index.html` — token bootstrap (add near top of first `<script>`)

```js
function getSyncToken() {
  let t = localStorage.getItem('sync_token');
  if (!t) {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    t = 'plant-' + Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map(b => chars[b % chars.length]).join('');
    localStorage.setItem('sync_token', t);
  }
  return t;
}
const SYNC_TOKEN = getSyncToken();
```

### Replace all worker fetch calls to include the token

```js
// Before
fetch(`${WORKER_URL}/watering`)
fetch(`${WORKER_URL}/watering`, { method: 'POST', ... })
fetch(`${WORKER_URL}/watering/reset`, { method: 'POST' })

// After
fetch(`${WORKER_URL}/watering?t=${SYNC_TOKEN}`)
fetch(`${WORKER_URL}/watering?t=${SYNC_TOKEN}`, { method: 'POST', ... })
fetch(`${WORKER_URL}/watering/reset?t=${SYNC_TOKEN}`, { method: 'POST' })
```

Same for any future `/outdoor` endpoints.

### Token UI — add a small settings drawer or inline display

Show the token and let the user paste a different one:

```html
<div id="sync-token-ui" style="margin-top:1rem;">
  <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:6px;letter-spacing:0.06em;text-transform:uppercase;">Sync token (share to link devices)</div>
  <div style="display:flex;gap:8px;align-items:center;">
    <code id="token-display" style="font-size:13px;color:rgba(255,255,255,0.7);background:rgba(255,255,255,0.06);padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);"></code>
    <button onclick="copyToken()" style="...">Copy</button>
    <button onclick="changeToken()" style="...">Change</button>
  </div>
</div>
```

```js
document.getElementById('token-display').textContent = SYNC_TOKEN;

function copyToken() {
  navigator.clipboard.writeText(SYNC_TOKEN);
}

function changeToken() {
  const t = prompt('Paste a sync token from another device:');
  if (t && t.startsWith('plant-') && t.length > 10) {
    localStorage.setItem('sync_token', t);
    location.reload();
  }
}
```

---

## Worker changes (`worker/src/index.js`)

### Extract token from query param

```js
const token = url.searchParams.get('t') || 'default';
// Validate: only alphanumeric + hyphens, max 32 chars
const safeToken = /^[a-z0-9-]{6,32}$/.test(token) ? token : 'default';
```

### Prefix all KV keys with the token

```js
// Before
const val = await env.PUSH_SUBS.get("watering:state");
await env.PUSH_SUBS.put("watering:state", JSON.stringify(state));

// After
const val = await env.PUSH_SUBS.get(`${safeToken}:watering:state`);
await env.PUSH_SUBS.put(`${safeToken}:watering:state`, JSON.stringify(state));
```

Apply the same prefix to outdoor state and any future per-user keys. Push subscription keys (hashed endpoints) stay unprefixed — they're device-specific, not user-specific.

---

## Migration of existing data

The first time a user visits after this change, their token will be freshly generated and the KV lookup (`newtoken:watering:state`) will return nothing. The app currently falls back to `localStorage` in that case, so existing data won't be lost — it'll just show from localStorage until they do a "mark as watered" which writes the new key.

If you want to migrate the old `watering:state` key to the new token automatically, add this one-time migration endpoint:

```
POST /migrate?t=<token>
```

```js
if (request.method === 'POST' && url.pathname === '/migrate') {
  const old = await env.PUSH_SUBS.get('watering:state');
  if (old) {
    await env.PUSH_SUBS.put(`${safeToken}:watering:state`, old);
    await env.PUSH_SUBS.delete('watering:state'); // optional cleanup
  }
  return new Response('OK', { status: 200, headers: cors });
}
```

Call it once from the browser after deploying: `fetch(WORKER_URL + '/migrate?t=' + SYNC_TOKEN, { method: 'POST' })`.

---

## Security notes

- The token is the only thing protecting your data. It's not a password — it's a namespace. Anyone who sees the token can read/write your watering state. That's intentional and fine for this use case.
- KV keys are scoped per token, so a random visitor hitting `/watering` without a token gets the `default` namespace, not yours.
- If you ever want a fresh start, just click "Change token" and generate a new one. Old data stays in KV under the old token and expires after 400 days.
- Do not embed the token in a public URL or share it in a screenshot.
