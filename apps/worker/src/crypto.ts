// AES-256-GCM for stored provider keys (docs §6.2). The master key is a Worker secret
// (base64, 32 bytes). AAD binds each ciphertext to its user and provider, so a row
// copied onto another account or provider fails to decrypt.

export const KEY_VERSION = 1

const keyCache = new Map<string, Promise<CryptoKey>>()

function masterKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret)
  if (!key) {
    const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0))
    if (raw.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes of base64')
    key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    keyCache.set(secret, key)
  }
  return key
}

const aad = (userId: string, provider: string) => new TextEncoder().encode(`${userId}|${provider}`)

export async function encryptSecret(
  secret: string,
  userId: string,
  provider: string,
  plaintext: string,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(userId, provider) },
    await masterKey(secret),
    new TextEncoder().encode(plaintext),
  )
  return { ciphertext: new Uint8Array(buf), iv }
}

/** Returns null if the ciphertext doesn't verify (wrong key, user or provider). */
export async function decryptSecret(
  secret: string,
  userId: string,
  provider: string,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<string | null> {
  try {
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(userId, provider) },
      await masterKey(secret),
      ciphertext,
    )
    return new TextDecoder().decode(buf)
  } catch {
    return null
  }
}

// PostgREST reads and writes bytea as "\x" + hex.

export const toPgBytea = (bytes: Uint8Array): string =>
  `\\x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`

export function fromPgBytea(s: string): Uint8Array {
  const hex = s.startsWith('\\x') ? s.slice(2) : s
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
