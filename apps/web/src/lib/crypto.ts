/**
 * Chiffrement AES-256-GCM pour les secrets et credentials.
 * Clé dérivée depuis ELYTRAS_ENCRYPTION_KEY (32 bytes en base64 ou hex).
 *
 * Format stocké : "<iv_hex>:<ciphertext_hex>"
 */

function getRawKey(): string {
  const key = process.env.ELYTRAS_ENCRYPTION_KEY;
  if (!key) {throw new Error("ELYTRAS_ENCRYPTION_KEY n'est pas défini");}
  return key;
}

async function getCryptoKey(): Promise<CryptoKey> {
  const raw = getRawKey();
  // Accepte base64 ou hex, on normalise en ArrayBuffer 32 bytes
  let buf: ArrayBuffer;
  if (raw.length === 64) {
    // hex 256-bit
    const arr = raw.match(/.{2}/g)!.map((b) => parseInt(b, 16));
    buf = new Uint8Array(arr).buffer;
  } else {
    // base64
    const bin = atob(raw);
    const tmp = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {tmp[i] = bin.charCodeAt(i);}
    buf = tmp.buffer;
  }
  return crypto.subtle.importKey("raw", buf, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(plaintext: string): Promise<string> {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const ivHex = Array.from(iv)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const ctHex = Array.from(new Uint8Array(cipherBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${ivHex}:${ctHex}`;
}

export async function decrypt(stored: string): Promise<string> {
  const key = await getCryptoKey();
  const [ivHex, ctHex] = stored.split(":");
  if (!ivHex || !ctHex) {throw new Error("Format de secret invalide");}
  const iv = new Uint8Array(ivHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const ct = new Uint8Array(ctHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ct.buffer,
  );
  return new TextDecoder().decode(plainBuf);
}
