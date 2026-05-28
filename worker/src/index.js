// Plant Weather Alert Worker
// Runs on cron at 7 AM Mountain Time
// Checks Open-Meteo for Highlands Ranch weather, pushes alerts if unsafe for outdoor plants

// Safe outdoor thresholds for your plants
const OUTDOOR_PLANTS = [
  { id: "calamansi",  name: "Calamansi",          emoji: "🍊", minTempF: 55 },
  { id: "herb-pot",   name: "Cocktail Herb Pot",   emoji: "🌿", minTempF: 45 },
];

// Highlands Ranch coordinates (outdoor tracker plants are in Highlands Ranch)
const LAT = 39.5594;
const LON = -104.9719;

export default {
  // Handle cron triggers
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWeatherCheck(env));
  },

  // Handle HTTP requests (subscription save + manual trigger)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = ["https://kylecross.com", "https://www.kylecross.com", "http://localhost"];
    const corsOrigin = allowed.some(o => origin.startsWith(o)) ? origin : allowed[0];

    const cors = {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // POST /subscribe — save push subscription
    if (request.method === "POST" && url.pathname === "/subscribe") {
      try {
        const sub = await request.json();
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          return new Response("Invalid subscription", { status: 400, headers: cors });
        }
        // Store keyed by endpoint hash so one device = one record
        const key = await hashEndpoint(sub.endpoint);
        await env.PUSH_SUBS.put(key, JSON.stringify(sub), { expirationTtl: 60 * 60 * 24 * 400 });
        return new Response("Subscribed", { status: 200, headers: cors });
      } catch (e) {
        return new Response("Error: " + e.message, { status: 500, headers: cors });
      }
    }

    // DELETE /unsubscribe
    if (request.method === "POST" && url.pathname === "/unsubscribe") {
      try {
        const { endpoint } = await request.json();
        const key = await hashEndpoint(endpoint);
        await env.PUSH_SUBS.delete(key);
        return new Response("Unsubscribed", { status: 200, headers: cors });
      } catch (e) {
        return new Response("Error: " + e.message, { status: 500, headers: cors });
      }
    }

    // Extract and validate sync token
    const rawToken = url.searchParams.get('t') || 'default';
    const safeToken = /^[a-z0-9-]{6,32}$/.test(rawToken) ? rawToken : 'default';

    // GET /watering — return all plant watering timestamps
    if (request.method === "GET" && url.pathname === "/watering") {
      try {
        const val = await env.PUSH_SUBS.get(`${safeToken}:watering:state`);
        const state = val ? JSON.parse(val) : {};
        return new Response(JSON.stringify(state), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response("Error: " + e.message, { status: 500, headers: cors });
      }
    }

    // POST /watering — save a plant's last-watered timestamp { id, ts }
    if (request.method === "POST" && url.pathname === "/watering") {
      try {
        const { id, ts } = await request.json();
        if (!id || typeof ts !== "number") {
          return new Response("Invalid body", { status: 400, headers: cors });
        }
        const val = await env.PUSH_SUBS.get(`${safeToken}:watering:state`);
        const state = val ? JSON.parse(val) : {};
        state[id] = ts;
        await env.PUSH_SUBS.put(`${safeToken}:watering:state`, JSON.stringify(state));
        return new Response("OK", { status: 200, headers: cors });
      } catch (e) {
        return new Response("Error: " + e.message, { status: 500, headers: cors });
      }
    }

    // POST /watering/reset — clear all watering history
    if (request.method === "POST" && url.pathname === "/watering/reset") {
      try {
        await env.PUSH_SUBS.put(`${safeToken}:watering:state`, JSON.stringify({}));
        return new Response("OK", { status: 200, headers: cors });
      } catch (e) {
        return new Response("Error: " + e.message, { status: 500, headers: cors });
      }
    }

    // POST /migrate — one-time migration of old unprefixed watering:state to token namespace
    if (request.method === "POST" && url.pathname === "/migrate") {
      try {
        const old = await env.PUSH_SUBS.get('watering:state');
        if (old) {
          await env.PUSH_SUBS.put(`${safeToken}:watering:state`, old);
          await env.PUSH_SUBS.delete('watering:state');
        }
        return new Response("OK", { status: 200, headers: cors });
      } catch (e) {
        return new Response("Error: " + e.message, { status: 500, headers: cors });
      }
    }

    // GET /trigger — manual test trigger (only from allowed origins)
    if (request.method === "GET" && url.pathname === "/trigger") {
      ctx.waitUntil(runWeatherCheck(env));
      return new Response("Weather check triggered", { status: 200, headers: cors });
    }

    // GET /vapid-public-key — return public key for browser subscription
    if (request.method === "GET" && url.pathname === "/vapid-public-key") {
      return new Response(JSON.stringify({ key: env.VAPID_PUBLIC_KEY }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404, headers: cors });
  },
};

async function runWeatherCheck(env) {
  const weather = await fetchWeather();
  if (!weather) return;

  const { tempF, precipMm, weatherCode, windGustKph } = weather;
  const alerts = buildAlerts(tempF, precipMm, weatherCode, windGustKph);
  if (alerts.length === 0) return;

  const subs = await getAllSubscriptions(env);
  await Promise.allSettled(subs.map(sub => sendPush(sub, alerts, env)));
}

async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&current=temperature_2m,precipitation,weather_code,wind_gusts_10m` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America/Denver`;

  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const c = data.current;

  return {
    tempF: c.temperature_2m,
    precipMm: c.precipitation,
    weatherCode: c.weather_code,
    windGustKph: c.wind_gusts_10m,
  };
}

function buildAlerts(tempF, precipMm, weatherCode, windGustMph) {
  const alerts = [];

  // Temperature alerts per plant
  for (const plant of OUTDOOR_PLANTS) {
    if (tempF < plant.minTempF) {
      alerts.push({
        plant,
        reason: "cold",
        message: `${Math.round(tempF)}°F — below safe minimum of ${plant.minTempF}°F. Bring ${plant.name} inside.`,
      });
    }
  }

  // Precipitation (any rain/snow/hail is risky for outdoor potted plants)
  const isPrecip = precipMm > 0.1;
  // WMO weather code: 61-67 rain, 71-77 snow, 80-82 showers, 85-86 snow showers, 95-99 thunderstorm
  const isSevere = weatherCode >= 80 || (weatherCode >= 61 && weatherCode <= 77);
  const isHail = weatherCode >= 96;
  const isThunder = weatherCode >= 95;

  if (isPrecip || isSevere) {
    const precipLabel = isHail ? "hail" : isThunder ? "thunderstorm" : isSevere ? "rain/storms" : "rain";
    // Flag plants that are currently outdoors (all OUTDOOR_PLANTS)
    const plantNames = OUTDOOR_PLANTS.map(p => `${p.emoji} ${p.name}`).join(", ");
    alerts.push({
      plant: null,
      reason: "precip",
      message: `${precipLabel.charAt(0).toUpperCase() + precipLabel.slice(1)} expected. Bring in: ${plantNames}.`,
    });
  }

  // High wind (>35 mph gusts can tip pots)
  if (windGustMph > 35) {
    alerts.push({
      plant: null,
      reason: "wind",
      message: `Wind gusts up to ${Math.round(windGustMph)} mph — secure or bring in outdoor plants.`,
    });
  }

  return alerts;
}

async function getAllSubscriptions(env) {
  const list = await env.PUSH_SUBS.list();
  const subs = await Promise.all(
    list.keys.map(async ({ name }) => {
      const val = await env.PUSH_SUBS.get(name);
      try { return val ? JSON.parse(val) : null; } catch { return null; }
    })
  );
  return subs.filter(Boolean);
}

async function sendPush(subscription, alerts, env) {
  const title = alerts.length === 1 && alerts[0].plant
    ? `🌡️ ${alerts[0].plant.emoji} Plant Alert`
    : "🌿 Plant Weather Alert";

  const body = alerts.map(a => a.message).join("\n");

  const payload = JSON.stringify({
    title,
    body,
    tag: "weather-alert",
    url: "/#outdoor-tracker",
  });

  // Build VAPID JWT
  const vapidHeaders = await buildVapidHeaders(
    subscription.endpoint,
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

  // Encrypt payload using Web Push encryption (RFC 8291)
  const encrypted = await encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      ...vapidHeaders,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
    },
    body: encrypted,
  });

  // 410 Gone = subscription expired, clean it up
  if (res.status === 410) {
    const key = await hashEndpoint(subscription.endpoint);
    await env.PUSH_SUBS.delete(key);
  }
}

// ── Web Push encryption (RFC 8291 / aes128gcm) ──────────────────────────────

async function encryptPayload(payload, p256dhBase64, authBase64) {
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(payload);

  const receiverPublicKey = base64urlDecode(p256dhBase64);
  const authSecret = base64urlDecode(authBase64);

  // Generate ephemeral key pair
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const ephemeralPublicKey = await crypto.subtle.exportKey("raw", ephemeralKeyPair.publicKey);

  // Import receiver public key
  const receiverKey = await crypto.subtle.importKey(
    "raw", receiverPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []
  );

  // ECDH shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: receiverKey }, ephemeralKeyPair.privateKey, 256
  );

  // HKDF to derive content encryption key and nonce
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const prk = await hkdf(
    new Uint8Array(sharedSecret),
    authSecret,
    buildInfo("auth", new Uint8Array(0), new Uint8Array(0)),
    32
  );

  const contentEncryptionKey = await hkdf(
    prk, salt,
    buildInfo("aesgcm", new Uint8Array(receiverPublicKey), new Uint8Array(ephemeralPublicKey)),
    16
  );

  const nonce = await hkdf(
    prk, salt,
    buildInfo("nonce", new Uint8Array(receiverPublicKey), new Uint8Array(ephemeralPublicKey)),
    12
  );

  // Encrypt
  const aesKey = await crypto.subtle.importKey("raw", contentEncryptionKey, "AES-GCM", false, ["encrypt"]);
  const paddedPlaintext = addPadding(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, aesKey, paddedPlaintext
  );

  // Build aes128gcm content-encoding header (RFC 8188)
  const header = buildAes128gcmHeader(salt, new Uint8Array(ephemeralPublicKey));
  const result = new Uint8Array(header.byteLength + ciphertext.byteLength);
  result.set(new Uint8Array(header), 0);
  result.set(new Uint8Array(ciphertext), header.byteLength);
  return result;
}

function buildInfo(type, receiverKey, senderKey) {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(`Content-Encoding: ${type}\0`);
  // For auth, no key material
  if (type === "auth") {
    const info = new Uint8Array(typeBytes.length);
    info.set(typeBytes);
    return info;
  }
  const contextBytes = new Uint8Array(5 + receiverKey.length + 2 + senderKey.length + 2);
  let offset = 0;
  encoder.encode("P-256").forEach(b => contextBytes[offset++] = b);
  contextBytes[offset++] = 0x00; contextBytes[offset++] = receiverKey.length;
  receiverKey.forEach(b => contextBytes[offset++] = b);
  contextBytes[offset++] = 0x00; contextBytes[offset++] = senderKey.length;
  senderKey.forEach(b => contextBytes[offset++] = b);
  const info = new Uint8Array(typeBytes.length + contextBytes.length);
  info.set(typeBytes); info.set(contextBytes, typeBytes.length);
  return info;
}

async function hkdf(ikm, salt, info, length) {
  const saltKey = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = await crypto.subtle.sign("HMAC", saltKey, ikm);
  const prkKey = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const t = new Uint8Array(info.length + 1);
  t.set(info); t[info.length] = 0x01;
  const okm = await crypto.subtle.sign("HMAC", prkKey, t);
  return new Uint8Array(okm).slice(0, length);
}

function addPadding(data) {
  // 2-byte big-endian length prefix (value = 0 = no padding), then data
  const result = new Uint8Array(2 + data.length);
  result[0] = 0; result[1] = 0;
  result.set(data, 2);
  return result;
}

function buildAes128gcmHeader(salt, senderPublicKey) {
  // salt (16) + rs (4) + idlen (1) + keyid (senderPublicKey)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + senderPublicKey.length);
  header.set(salt, 0);
  const view = new DataView(header.buffer);
  view.setUint32(16, rs, false);
  header[20] = senderPublicKey.length;
  header.set(senderPublicKey, 21);
  return header;
}

// ── VAPID JWT signing ────────────────────────────────────────────────────────

async function buildVapidHeaders(endpoint, subject, publicKeyB64, privateKeyB64) {
  const audience = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;

  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({ aud: audience, exp, sub: subject }));
  const unsigned = `${header}.${claims}`;

  const privateKeyBytes = base64urlDecode(privateKeyB64);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", privateKeyBytes,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(unsigned)
  );

  const token = `${unsigned}.${base64urlRaw(new Uint8Array(sig))}`;
  return {
    "Authorization": `vapid t=${token}, k=${publicKeyB64}`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function b64url(str) {
  return base64urlRaw(new TextEncoder().encode(str));
}

function base64urlRaw(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function hashEndpoint(endpoint) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return base64urlRaw(new Uint8Array(buf)).slice(0, 32);
}
