// Thin client for the Hopscotch API (OpenAI-compatible). All calls stay server-side.

const BASE_URL = (process.env.HOPSCOTCH_BASE_URL || 'https://api.hopscotchlabs.ai/v1').replace(/\/$/, '');
// In the Claude Code cloud environment the proxy injects the real credential, so a dummy works there.
const API_KEY = process.env.HOPSCOTCH_API_KEY || 'dummy-key-replaced-by-proxy';
export const hasRealKey = Boolean(process.env.HOPSCOTCH_API_KEY);

export const STT_MODELS = ['openai-main/gpt-4o-mini-transcribe', 'deepinfra/whisper-large-v3'];
export const TTS_MODELS = ['openai-main/gpt-4o-mini-tts', 'deepinfra/Kokoro-82M'];
export const CHAT_FALLBACK_ORDER = ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5'];

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
  /** Errors where trying a different model might help. */
  get retryable() {
    return this.status === 404 || this.status === 408 || this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

function headers(json = true): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${API_KEY}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function toApiError(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } };
    if (body?.error?.message) msg = body.error.message;
    code = body?.error?.code;
  } catch {
    /* non-JSON body */
  }
  return new ApiError(msg, res.status, code);
}

async function doFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error;
    throw new ApiError(`Network error contacting Hopscotch API: ${err.message}`, 0);
  }
}

// ---------- Pricing (from /v1/models) ----------

interface Pricing {
  input: number; // $ per 1M tokens
  output: number;
}
let pricing: Record<string, Pricing> = {};
let pricingLoadedAt = 0;

export async function loadPricing(force = false) {
  if (!force && Date.now() - pricingLoadedAt < 6 * 3600_000 && Object.keys(pricing).length) return pricing;
  try {
    const res = await doFetch(`${BASE_URL}/models`, { headers: headers(false) }, 30_000);
    if (!res.ok) throw await toApiError(res);
    const body = (await res.json()) as { data: { id: string; uniblock?: Record<string, unknown> }[] };
    const next: Record<string, Pricing> = {};
    for (const m of body.data) {
      const u = m.uniblock ?? {};
      const inRate = Number(u.input_rate_thousandths ?? u.audio_input_rate);
      const outRate = Number(u.output_rate_thousandths ?? u.audio_output_rate);
      if (Number.isFinite(inRate) || Number.isFinite(outRate)) {
        // "rate_thousandths" is thousandths of a dollar per 1M tokens.
        next[m.id] = { input: (inRate || 0) / 1000, output: (outRate || 0) / 1000 };
      }
    }
    pricing = next;
    pricingLoadedAt = Date.now();
  } catch (e) {
    console.warn('[hopscotch] could not load model pricing:', (e as Error).message);
  }
  return pricing;
}

export function priceFor(model: string): Pricing | undefined {
  return pricing[model];
}

export function chatCost(model: string, inputTokens: number, outputTokens: number) {
  const p = pricing[model];
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ---------- Chat ----------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StreamResult {
  text: string;
  model: string;
  usage: ChatUsage;
}

function fallbackChain(model: string) {
  return [model, ...CHAT_FALLBACK_ORDER.filter((m) => m !== model)];
}

/**
 * Streams a chat completion. Falls back to the next model if the request fails
 * before any text has been produced.
 */
export async function streamChat(opts: {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  onDelta: (text: string) => void;
  onFallback?: (from: string, to: string, reason: string) => void;
  signal?: AbortSignal;
}): Promise<StreamResult> {
  const chain = fallbackChain(opts.model);
  let lastErr: ApiError | undefined;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    let produced = false;
    try {
      const res = await doFetch(
        `${BASE_URL}/chat/completions`,
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            model,
            messages: opts.messages,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: opts.maxTokens ?? 1200,
          }),
          signal: opts.signal,
        },
        120_000,
      );
      if (!res.ok || !res.body) throw await toApiError(res);

      let text = '';
      const usage: ChatUsage = { inputTokens: 0, outputTokens: 0 };
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const evt = JSON.parse(data);
            if (evt.error) throw new ApiError(evt.error.message || 'Stream error', 502);
            const delta = evt.choices?.[0]?.delta?.content;
            if (delta) {
              produced = true;
              text += delta;
              opts.onDelta(delta);
            }
            if (evt.usage) {
              usage.inputTokens = evt.usage.prompt_tokens ?? 0;
              usage.outputTokens = evt.usage.completion_tokens ?? 0;
            }
          } catch (e) {
            if (e instanceof ApiError) throw e;
            /* ignore malformed keep-alive lines */
          }
        }
      }
      if (!produced) throw new ApiError('The model returned an empty response.', 502);
      return { text, model, usage };
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError((e as Error).message, 0);
      if (opts.signal?.aborted) throw err;
      lastErr = err;
      if (produced || !err.retryable || i === chain.length - 1) throw err;
      opts.onFallback?.(model, chain[i + 1], err.message);
      console.warn(`[hopscotch] ${model} failed (${err.message}); falling back to ${chain[i + 1]}`);
    }
  }
  throw lastErr ?? new ApiError('Chat failed', 500);
}

/** Non-streaming chat with a strict JSON schema; returns the parsed object. */
export async function structuredChat<T>(opts: {
  model: string;
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<{ data: T; model: string; usage: ChatUsage }> {
  const chain = fallbackChain(opts.model);
  let lastErr: ApiError | undefined;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const res = await doFetch(
        `${BASE_URL}/chat/completions`,
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            model,
            messages: opts.messages,
            max_tokens: opts.maxTokens ?? 2000,
            response_format: {
              type: 'json_schema',
              json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
            },
          }),
        },
        240_000,
      );
      if (!res.ok) throw await toApiError(res);
      const body = (await res.json()) as {
        choices: { message: { content: string }; finish_reason: string }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      const choice = body.choices?.[0];
      const content = (choice?.message?.content ?? '').trim();
      if (choice?.finish_reason === 'length') throw new ApiError('The grader ran out of output tokens.', 502);
      let data: T;
      try {
        data = JSON.parse(content) as T;
      } catch {
        throw new ApiError('The grader returned malformed JSON.', 502);
      }
      return {
        data,
        model,
        usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
      };
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError((e as Error).message, 0);
      lastErr = err;
      if (!err.retryable || i === chain.length - 1) throw err;
      console.warn(`[hopscotch] ${model} failed (${err.message}); falling back to ${chain[i + 1]}`);
    }
  }
  throw lastErr ?? new ApiError('Structured chat failed', 500);
}

// ---------- Speech ----------

export async function transcribe(audio: Buffer, filename: string, mime: string) {
  let lastErr: ApiError | undefined;
  for (const model of STT_MODELS) {
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), filename);
      form.append('model', model);
      const res = await doFetch(`${BASE_URL}/audio/transcriptions`, { method: 'POST', headers: headers(false), body: form }, 120_000);
      if (!res.ok) throw await toApiError(res);
      const body = (await res.json()) as {
        text: string;
        usage?: { input_tokens?: number; output_tokens?: number; input_token_details?: { audio_tokens?: number } };
      };
      const p = pricing[model];
      const cost = p && body.usage ? ((body.usage.input_tokens ?? 0) * p.input + (body.usage.output_tokens ?? 0) * p.output) / 1e6 : 0;
      return { text: (body.text ?? '').trim(), model, cost };
    } catch (e) {
      lastErr = e instanceof ApiError ? e : new ApiError((e as Error).message, 0);
      console.warn(`[hopscotch] transcription with ${model} failed: ${lastErr.message}`);
    }
  }
  throw lastErr ?? new ApiError('Transcription failed', 500);
}

// gpt-4o-mini-tts is about $0.015 per minute of speech (~900 characters).
const TTS_COST_PER_CHAR = 0.015 / 900;

export async function speak(opts: { text: string; voice: string; fallbackVoice: string; instructions?: string }) {
  let lastErr: ApiError | undefined;
  for (const model of TTS_MODELS) {
    const isPrimary = model === TTS_MODELS[0];
    try {
      const res = await doFetch(
        `${BASE_URL}/audio/speech`,
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            model,
            input: opts.text,
            voice: isPrimary ? opts.voice : opts.fallbackVoice,
            response_format: 'mp3',
            ...(isPrimary && opts.instructions ? { instructions: opts.instructions } : {}),
          }),
        },
        90_000,
      );
      if (!res.ok) throw await toApiError(res);
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length < 100) throw new ApiError('Empty audio returned', 502);
      return { audio, model, cost: isPrimary ? opts.text.length * TTS_COST_PER_CHAR : 0 };
    } catch (e) {
      lastErr = e instanceof ApiError ? e : new ApiError((e as Error).message, 0);
      console.warn(`[hopscotch] speech with ${model} failed: ${lastErr.message}`);
    }
  }
  throw lastErr ?? new ApiError('Speech failed', 500);
}
