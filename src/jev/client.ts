import {
  TypeSafeClient,
  type EntryType,
  type Question,
  type Questions,
  type ResultFor,
  type SystemOneResult,
} from '@typesafe-ai/sdk'
import { requireApiKey } from './env'

/**
 * One judgment, shaped by the primitive that produced it: NoulResponse,
 * ScoreResponse or ChoiceResponse. The response types come straight from the
 * SDK so a change in what JEV returns breaks the build rather than a page.
 */
export type JevAnswer = ResultFor<Question>

export interface JevUsage {
  input_tokens: number
  output_tokens: number
}

export interface JevRequest {
  /** Text, JSON object or array to judge — the listing data and the request. */
  state: EntryType
  /** Named questions. Keys are ours; the model never sees them. */
  questions: Questions
  /** Optional model override; omit to use the account default. */
  model?: string
}

export interface JevResult {
  model: string
  answers: Record<string, JevAnswer>
  usage: JevUsage
}

export interface JevClient {
  systemOne(req: JevRequest): Promise<JevResult>
}

/**
 * The real client. Server-side only: `requireApiKey` throws before the SDK is
 * constructed if the key is missing, and the key itself never leaves this
 * process (spec section 8.2).
 */
export function createJevClient(): JevClient {
  requireApiKey()
  const client = new TypeSafeClient()
  return {
    async systemOne(req: JevRequest): Promise<JevResult> {
      const res: SystemOneResult<Questions> = await client.systemOne(req)
      return {
        model: res.model,
        answers: { ...res.answers } as Record<string, JevAnswer>,
        usage: res.usage,
      }
    },
  }
}

export interface FakeJevClient extends JevClient {
  /** Every request this fake received, so tests can assert on batching. */
  calls: JevRequest[]
}

/**
 * Test double. Returns canned answers and records every request, so the whole
 * pipeline can run end to end without spending money or touching the network.
 */
export function createFakeJevClient(
  answers: Record<string, JevAnswer>,
  usage: JevUsage = { input_tokens: 0, output_tokens: 0 },
): FakeJevClient {
  const calls: JevRequest[] = []
  return {
    calls,
    async systemOne(req: JevRequest): Promise<JevResult> {
      calls.push(req)
      return { model: 'fake', answers, usage }
    },
  }
}
