// Minimal Web Push sender for Cloudflare Workers (WebCrypto only — no deps).
// Implements VAPID (RFC 8292) auth + aes128gcm payload encryption
// (RFC 8291 + RFC 8188). VAPID keys are the base64url forms produced by
// `npx web-push generate-vapid-keys` (public = 65-byte EC point, private = 32-byte d).

const enc = new TextEncoder();

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += '='.repeat(pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  const b = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// HKDF (extract + expand in one) via WebCrypto.
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8
  );
  return new Uint8Array(bits);
}

// --- VAPID JWT (ES256) ---
async function createVapidJWT(audience, subject, publicKeyB64, privateKeyB64) {
  const pub = b64urlToBytes(publicKeyB64); // 0x04 || x(32) || y(32)
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: privateKeyB64,
    ext: true, key_ops: ['sign'],
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput));
  // WebCrypto returns raw r||s (64 bytes) — exactly what JWS ES256 wants.
  return `${signingInput}.${bytesToB64url(sig)}`;
}

// --- aes128gcm payload (RFC 8291) ---
async function encryptPayload(plaintext, p256dhB64, authB64) {
  const uaPublic = b64urlToBytes(p256dhB64); // 65 bytes
  const authSecret = b64urlToBytes(authB64); // 16 bytes

  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 bytes
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  // IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info"\0 || ua || as)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Single record: plaintext || 0x02 (last-record delimiter)
  const record = concat(plaintext, new Uint8Array([0x02]));
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, record));

  // Header: salt(16) | rs(4, BE) | idlen(1)=65 | keyid(as_public, 65) | ciphertext
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, ct);
}

/**
 * Send one Web Push. Returns the fetch Response (caller inspects status:
 * 201/200 = ok; 404/410 = gone → delete subscription).
 * @param subscription {endpoint, keys:{p256dh, auth}}
 * @param payloadString JSON string to deliver
 * @param vapid {publicKey, privateKey, subject}
 */
export async function sendWebPush(subscription, payloadString, vapid, ttl = 3600) {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await createVapidJWT(audience, vapid.subject, vapid.publicKey, vapid.privateKey);
  const body = await encryptPayload(enc.encode(payloadString), subscription.keys.p256dh, subscription.keys.auth);
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${vapid.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': String(ttl),
      'Urgency': 'high',
    },
    body,
  });
}
