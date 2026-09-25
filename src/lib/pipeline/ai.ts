import Anthropic from '@anthropic-ai/sdk';
import type { Services } from './services';
import { getJson } from './services';
import { errorMessage } from './text';

export type JsonSchema = Record<string, unknown>;
export type AiResult = { data: Record<string, unknown>; error?: undefined } | { data?: undefined; error: string };

/** Parses the model's JSON reply, tolerating ```json fences. */
export function parseJsonObject(text: string | undefined | null): AiResult {
  if (!text) return { error: 'The AI returned no text' };
  let data: unknown;
  try {
    data = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (e) {
    return { error: 'Could not read the AI JSON: ' + errorMessage(e) };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'The AI did not return a JSON object' };
  return { data: data as Record<string, unknown> };
}

/**
 * Asks the configured model for a JSON object matching `schema`.
 * Never throws: failures come back as { error } so one bad lead can't stop a run.
 */
export async function askJson(svc: Services, systemTemplate: string, userText: string, schema: JsonSchema): Promise<AiResult> {
  const { settings } = svc;
  const system = systemTemplate.replace('{{PRODUCT_DESCRIPTION}}', settings.productDescription);
  try {
    return settings.aiProvider === 'anthropic'
      ? await askClaude(svc, system, userText, schema)
      : await askDeepSeek(svc, system, userText, schema);
  } catch (e) {
    return { error: 'AI call failed: ' + errorMessage(e) };
  }
}

async function askClaude(svc: Services, system: string, userText: string, schema: JsonSchema): Promise<AiResult> {
  if (!svc.keys.anthropic) return { error: 'ANTHROPIC_API_KEY is not set' };
  const client = new Anthropic({ apiKey: svc.keys.anthropic, fetch: svc.fetch, maxRetries: 2 });
  const res = await client.beta.messages.create({
    model: svc.settings.aiModel,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    // If Claude declines a request, retry it on Anthropic's recommended fallback model.
    fallbacks: 'default',
    output_config: { effort: svc.settings.aiEffort, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: userText }],
  });
  if (res.stop_reason === 'refusal') return { error: 'The AI declined this request' };
  if (res.stop_reason === 'max_tokens') return { error: 'AI response was cut off (max_tokens)' };
  const block = res.content.find((b) => b.type === 'text');
  return parseJsonObject(block && block.type === 'text' ? block.text : '');
}

type DeepSeekResponse = { choices?: { finish_reason?: string; message?: { content?: string } }[] };

async function askDeepSeek(svc: Services, system: string, userText: string, schema: JsonSchema): Promise<AiResult> {
  if (!svc.keys.deepseek) return { error: 'DEEPSEEK_API_KEY is not set' };
  let lastError = '';
  // DeepSeek's JSON mode doesn't enforce the schema, so describe it and retry once on a bad reply.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await getJson<DeepSeekResponse>(
      svc,
      'https://api.deepseek.com/chat/completions',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${svc.keys.deepseek}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: svc.settings.aiModel,
          max_tokens: 8000,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `${system}\n\nRespond with only a JSON object that matches this JSON Schema. Include every field:\n${JSON.stringify(schema)}`,
            },
            { role: 'user', content: userText },
          ],
        }),
      },
      120_000,
    );
    const choice = res.choices?.[0];
    if (choice?.finish_reason === 'length') {
      lastError = 'AI response was cut off (max_tokens)';
      continue;
    }
    const parsed = parseJsonObject(choice?.message?.content);
    if (parsed.data) return parsed;
    lastError = parsed.error;
  }
  return { error: lastError };
}
