/**
 * Spokify — rewrite an assistant message into natural spoken narration.
 *
 * Used as the pre-processor before TTS. Strips code blocks, drops markdown,
 * smooths punctuation, converts numbered lists into prose. Preserves intent
 * and first-person voice; trims structural noise.
 *
 * Backend: Anthropic Claude Haiku 4.5 (claude-haiku-4-5-20251001).
 * Cost: ~$0.0004/message (negligible at any reasonable rate).
 *
 * Called from sentence-streaming auto-speak, so input may be a single
 * sentence or a longer chunk. The rewriter is robust to either shape.
 */
import { ipcMain } from 'electron'
import { getSecret } from '../secrets'

const SPOKIFY_MODEL = 'claude-haiku-4-5-20251001'
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

const SPOKIFY_SYSTEM_PROMPT = `You rewrite an assistant's written reply into a natural spoken response that an AI voice will read aloud. Output only the rewritten text — no preamble, no quotes, no explanation.

Rules:
- Strip all markdown formatting: bold, italic, headers, links → plain prose.
- Replace fenced code blocks with a brief mention like "I've added a code example for that" or "Here's the snippet on screen." Never read code aloud, character by character or otherwise.
- Convert numbered lists into natural prose: "1. Foo  2. Bar  3. Baz" becomes "There are three options: foo, bar, and baz."
- Convert bulleted lists similarly. The listener can't see bullets.
- Keep the first-person voice if the original is first-person.
- Be decisive. "I'd recommend X" beats "X has merits and tradeoffs you might consider."
- Skip greeting and closing fluff if it's redundant — get to the point.
- Keep meaning intact. Don't add new information.
- Roughly preserve length minus structural noise.
- If the input is a single sentence already (e.g., from sentence-streaming), make minimal changes — just smooth punctuation and drop any inline markdown.

Punctuation hint: TTS engines pause on commas, full stops, and dashes. Use them to control rhythm. Avoid em-dashes and ellipses unless natural.`.trim()

interface SpokifyArgs {
  text: string
  // Optional override; defaults to SPOKIFY_MODEL.
  model?: string
}

async function callAnthropic(text: string, model: string): Promise<string> {
  const apiKey = getSecret('anthropic') ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('No Anthropic API key set. Add one in Settings → Voice or set ANTHROPIC_API_KEY.')

  const body = {
    model,
    max_tokens: 1024,
    system: SPOKIFY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  }

  const resp = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Spokify API error ${resp.status}: ${errText.slice(0, 300)}`)
  }

  const data = await resp.json() as { content?: Array<{ type: string; text?: string }> }
  const blocks = Array.isArray(data.content) ? data.content : []
  const text2 = blocks
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim()
  if (!text2) throw new Error('Spokify returned empty response')
  return text2
}

export function registerSpokifyIpc(): void {
  ipcMain.handle('spokify:run', async (_event, args: SpokifyArgs) => {
    try {
      const text = String(args?.text ?? '').trim()
      if (!text) return { ok: true, text: '' }
      const model = args?.model || SPOKIFY_MODEL
      const spoken = await callAnthropic(text, model)
      return { ok: true, text: spoken }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
