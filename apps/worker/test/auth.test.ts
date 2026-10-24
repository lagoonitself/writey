import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { verifySupabaseToken } from '../src/auth'

const SUPABASE_URL = 'https://example.supabase.co'
const ISSUER = `${SUPABASE_URL}/auth/v1`

let privateKey: CryptoKey
let jwks: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const pair = await generateKeyPair('ES256')
  privateKey = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'ES256' }
  jwks = createLocalJWKSet({ keys: [jwk] })
})

function sign(
  claims: Record<string, unknown>,
  opts: { iss?: string; aud?: string; exp?: string } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey)
}

describe('verifySupabaseToken', () => {
  it('accepts a valid token', async () => {
    const token = await sign({ sub: 'user-1', email: 'a@b.c' })
    expect(await verifySupabaseToken(token, jwks, SUPABASE_URL)).toEqual({
      userId: 'user-1',
      email: 'a@b.c',
    })
  })

  it('rejects a token from another project', async () => {
    const token = await sign({ sub: 'user-1' }, { iss: 'https://other.supabase.co/auth/v1' })
    expect(await verifySupabaseToken(token, jwks, SUPABASE_URL)).toBeNull()
  })

  it('rejects an anon (non-authenticated) token', async () => {
    const token = await sign({ sub: 'user-1' }, { aud: 'anon' })
    expect(await verifySupabaseToken(token, jwks, SUPABASE_URL)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await sign({ sub: 'user-1' }, { exp: '-1m' })
    expect(await verifySupabaseToken(token, jwks, SUPABASE_URL)).toBeNull()
  })

  it('rejects garbage', async () => {
    expect(await verifySupabaseToken('not-a-jwt', jwks, SUPABASE_URL)).toBeNull()
  })
})
