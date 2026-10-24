import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'

export type AuthUser = { userId: string; email: string | null }

const jwksCache = new Map<string, JWTVerifyGetKey>()

/** Supabase publishes its JWT signing keys here; jose caches them between requests. */
export function supabaseJwks(supabaseUrl: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(supabaseUrl)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', supabaseUrl))
    jwksCache.set(supabaseUrl, jwks)
  }
  return jwks
}

/** Verifies a Supabase access token. Returns null for any invalid, expired or foreign token. */
export async function verifySupabaseToken(
  token: string,
  jwks: JWTVerifyGetKey,
  supabaseUrl: string,
): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: new URL('/auth/v1', supabaseUrl).toString(),
      audience: 'authenticated',
    })
    if (typeof payload.sub !== 'string') return null
    return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : null }
  } catch {
    return null
  }
}
