import { beforeAll, describe, it, expect, vi } from 'vitest'
import { createGoogleSheetsClient, SHEET_RANGES } from '../catalogue/googleSheets'
let pem: string, publicKey: CryptoKey
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  publicKey = pair.publicKey
  const bytes = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  pem =
    '-----BEGIN PRIVATE KEY-----\n' +
    Buffer.from(bytes).toString('base64') +
    '\n-----END PRIVATE KEY-----'
})
const workbook = () => ({
  valueRanges: Object.keys(SHEET_RANGES).map((name) => ({
    range: SHEET_RANGES[name as keyof typeof SHEET_RANGES],
    values: [[name]],
  })),
})
describe('server-only Google Sheets', () => {
  it('signs a genuine RS256 JWT, exchanges and reuses an expiring in-memory token', async () => {
    let clock = 1788739200000
    let assertion = ''
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        assertion = new URLSearchParams(String(init?.body)).get('assertion')!
        return Response.json({ access_token: 'test-access', expires_in: 120, token_type: 'Bearer' })
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-access')
      expect(String(url)).toContain(
        'sheets.googleapis.com/v4/spreadsheets/test-workbook/values:batchGet',
      )
      expect(init?.redirect).toBe('error')
      return Response.json(workbook())
    })
    const client = createGoogleSheetsClient(
      {
        CATALOGUE_SHEET_ID: 'test-workbook',
        GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: 'a@test.iam.gserviceaccount.com',
        GOOGLE_SHEETS_PRIVATE_KEY: pem,
      },
      { fetch: fetcher, now: () => clock },
    )
    await client.read()
    await client.read()
    expect(fetcher).toHaveBeenCalledTimes(3)
    const [header, payload, signature] = assertion.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe('RS256')
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      iss: 'a@test.iam.gserviceaccount.com',
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/spreadsheets',
    })
    expect(
      await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        Buffer.from(signature, 'base64url'),
        new TextEncoder().encode(header + '.' + payload),
      ),
    ).toBe(true)
    clock += 90000
    await client.read()
    expect(fetcher).toHaveBeenCalledTimes(5)
  })
  it('exports only fixed ranges using RAW values, clearing stale rows without formula evaluation', async () => {
    let exportedData: { values: string[][] }[] = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('oauth2'))
        return Response.json({ access_token: 'export-token', expires_in: 3600 })
      expect(String(url).endsWith('/values:batchUpdate')).toBe(true)
      const body = JSON.parse(String(init?.body))
      expect(body.valueInputOption).toBe('RAW')
      expect(body.data).toHaveLength(4)
      expect(body.data[0].values[0][0]).toBe('=not a formula')
      exportedData = body.data
      return Response.json({ totalUpdatedCells: 1 })
    })
    const client = createGoogleSheetsClient(
      {
        CATALOGUE_SHEET_ID: 'export-workbook',
        GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: 'b@test.iam.gserviceaccount.com',
        GOOGLE_SHEETS_PRIVATE_KEY: pem,
      },
      { fetch: fetcher },
    )
    await client.write({ Tracks: [['=not a formula']], Sources: [], Aliases: [], Instructions: [] })
    expect(exportedData[0].values).toHaveLength(15002)
    expect(exportedData[1].values).toHaveLength(30002)
    expect(exportedData[0].values[0]).toHaveLength(16)
    expect(SHEET_RANGES.Tracks).toBe("'Tracks'!A1:P15002")
  })
  it('redacts token responses, errors and malformed private keys', async () => {
    const env = {
      CATALOGUE_SHEET_ID: 'failed-workbook',
      GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: 'c@test.iam.gserviceaccount.com',
      GOOGLE_SHEETS_PRIVATE_KEY: 'private-sensitive',
    }
    await expect(createGoogleSheetsClient(env).read()).rejects.toThrow('sheets_unavailable')
    await expect(
      createGoogleSheetsClient(
        { ...env, GOOGLE_SHEETS_PRIVATE_KEY: pem },
        { fetch: async () => new Response('access-token private-sensitive', { status: 403 }) },
      ).read(),
    ).rejects.toThrow('sheets_unavailable')
  })
  it('fails closed before network when workbook configuration is missing or path-injected', async () => {
    const fetcher = vi.fn()
    await expect(
      createGoogleSheetsClient({ CATALOGUE_SHEET_ID: '../../other' }, { fetch: fetcher }).read(),
    ).rejects.toThrow('sheets_unavailable')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
