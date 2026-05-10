/**
 * Generic multi-turn streaming chat — used by the chat REPL.
 *
 * Same dispatch as generic.ts but for the multi-message API surface
 * (system prompt + messages array, with cancellation via AbortSignal).
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { StreamEvent } from './types.js';
import { priceFor } from './pricing.js';
import { resolveConfigured, type ProviderEntry } from '../storage/providers.js';
import { templateById } from './registry.js';
import { resolveModel } from './modelResolution.js';
import {
  debugProviderCall,
  debugProviderError,
  debugProviderResponse,
} from '../util/debug.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamChatOptions {
  providerId: string;
  system: string;
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export async function* streamProviderChat(
  opts: StreamChatOptions
): AsyncIterable<StreamEvent> {
  const entry = await resolveConfigured(opts.providerId);
  if (!entry) {
    const tpl = templateById(opts.providerId);
    const label = tpl?.name ?? opts.providerId;
    throw new Error(
      `No ${label} key configured. Run: mod8 keys set ${opts.providerId}` +
        (tpl ? '' : `, or mod8 add-provider for custom ones`) +
        '.'
    );
  }
  const resolved = resolveModel(opts.providerId, opts.model, entry.defaultModel);
  const model = resolved.model;
  // Preview the most recent user turn (chat REPL prompts are conversation
  // history, not a single user message — first ~200 chars is enough).
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  debugProviderCall({
    providerId: opts.providerId,
    apiType: entry.apiType,
    model,
    modelSource: resolved.source,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    promptPreview: lastUser?.content ?? '',
  });
  try {
    switch (entry.apiType) {
      case 'anthropic':
        yield* streamAnthropic(entry, model, opts);
        return;
      case 'openai-compat':
        yield* streamOpenAICompat(entry, model, opts);
        return;
      case 'gemini':
        yield* streamGemini(entry, model, opts);
        return;
    }
  } catch (err) {
    debugProviderError(opts.providerId, err);
    throw err;
  }
}

async function* streamAnthropic(
  entry: ProviderEntry,
  model: string,
  opts: StreamChatOptions
): AsyncIterable<StreamEvent> {
  const client = new Anthropic({ apiKey: entry.apiKey });
  const start = Date.now();
  const ms = client.messages.stream(
    {
      model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages: opts.messages,
    },
    { signal: opts.signal }
  );
  for await (const event of ms) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      yield { type: 'text', delta: event.delta.text };
    }
  }
  const final = await ms.finalMessage();
  const latencyMs = Date.now() - start;
  const inputTokens = final.usage.input_tokens;
  const outputTokens = final.usage.output_tokens;
  const actualModel = final.model ?? model;
  yield {
    type: 'done',
    usage: {
      inputTokens,
      outputTokens,
      latencyMs,
      model: actualModel,
      costUsd: priceFor(actualModel, inputTokens, outputTokens),
    },
  };
}

async function* streamOpenAICompat(
  entry: ProviderEntry,
  model: string,
  opts: StreamChatOptions
): AsyncIterable<StreamEvent> {
  const client = new OpenAI({
    apiKey: entry.apiKey,
    baseURL: entry.baseUrl,
  });
  const start = Date.now();
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: opts.system },
    ...opts.messages,
  ];
  const stream = await client.chat.completions.create(
    {
      model,
      messages,
      max_tokens: opts.maxTokens ?? 4096,
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal: opts.signal }
  );
  let inputTokens = 0;
  let outputTokens = 0;
  let actualModel = model;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield { type: 'text', delta };
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? 0;
      outputTokens = chunk.usage.completion_tokens ?? 0;
    }
    if (chunk.model) actualModel = chunk.model;
  }
  const latencyMs = Date.now() - start;
  yield {
    type: 'done',
    usage: {
      inputTokens,
      outputTokens,
      latencyMs,
      model: actualModel,
      costUsd: priceFor(actualModel, inputTokens, outputTokens),
    },
  };
}

async function* streamGemini(
  entry: ProviderEntry,
  model: string,
  opts: StreamChatOptions
): AsyncIterable<StreamEvent> {
  const genAI = new GoogleGenerativeAI(entry.apiKey);
  const m = genAI.getGenerativeModel({ model, systemInstruction: opts.system });
  // Gemini takes a history array + a final user message; reshape.
  const history = opts.messages.slice(0, -1).map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));
  const last = opts.messages[opts.messages.length - 1];
  const userText = last && last.role === 'user' ? last.content : '';
  const chat = m.startChat({ history });
  const start = Date.now();
  const result = await chat.sendMessageStream(userText);
  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) yield { type: 'text', delta: text };
    if (opts.signal?.aborted) throw new Error('aborted');
  }
  const final = await result.response;
  const usage = final.usageMetadata;
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;
  const latencyMs = Date.now() - start;
  yield {
    type: 'done',
    usage: {
      inputTokens,
      outputTokens,
      latencyMs,
      model,
      costUsd: priceFor(model, inputTokens, outputTokens),
    },
  };
}
