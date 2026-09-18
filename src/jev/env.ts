/**
 * Reads the TypeSafe API key. Called only from server-side code — the key must
 * never be sent to the browser (spec section 8.2).
 */
export function requireApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.TYPESAFE_API_KEY?.trim()
  if (!key) {
    throw new Error(
      'TYPESAFE_API_KEY is not set. Copy .env.example to .env and paste your key.',
    )
  }
  return key
}
