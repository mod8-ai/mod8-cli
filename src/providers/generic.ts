/**
 * Generic provider client factory.
 *
 * Given a ProviderEntry from the store, returns a ProviderClient that calls
 * the right SDK based on apiType. Three dispatch paths:
 *
 *   - anthropic:     @anthropic-ai/sdk (native Messages API)
 *   - gemini:        @google/generative-ai (native)
 *   - openai-compat: openai SDK with a custom baseURL — covers OpenAI,
 *                    DeepSeek, Mistral, Groq, OpenRouter, xAI, Together, …
 *
 * The mock provider short-circuits everything when MOD8_MOCK=1.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
  ProviderClient,
  ProviderResponse,
  ProviderCallOptions,
  StreamEvent,
} from './types.js';
import { priceFor } from './pricing.js';
import { resolveConfigured, type ProviderEntry } from '../storage/providers.js';
import { templateById } from './registry.js';
import { mockProvider } from './mock.js';
import { resolveModel } from './modelResolution.js';
import {
  debugProviderCall,
  debugProviderError,
  debugProviderResponse,
} from '../util/debug.js';

/**
 * Build a ProviderClient bound to a specific configured provider id.
 * Throws a friendly error if the provider isn't configured.
 */
export async function buildProviderClient(id: string): Promise<ProviderClient> {
  if (process.env.MOD8_MOCK === '1') return mockProvider(id);

  const entry = await resolveConfigured(id);
  if (!entry) {
    const tpl = templateById(id);
    const label = tpl?.name ?? id;
    throw new Error(
      `No ${label} key configured. Run: mod8 keys set ${id}` +
        (tpl ? '' : `, or mod8 add-provider for custom ones`) +
        '.'
    );
  }
  return clientForEntry(id, entry);
}

function clientForEntry(id: string, entry: ProviderEntry): ProviderClient {
  switch (entry.apiType) {
    case 'anthropic':
      return anthropicClient(id, entry);
    case 'openai-compat':
      return openaiCompatClient(id, entry);
    case 'gemini':
      return geminiClient(id, entry);
  }
}

// ---------- Anthropic ----------

function anthropicClient(id: string, entry: ProviderEntry): ProviderClient {
  const client = new Anthropic({ apiKey: entry.apiKey });

  return {
    id,
    defaultModel: entry.defaultModel,

    async call(prompt: string, opts: ProviderCallOptions = {}): Promise<ProviderResponse> {
      const resolved = resolveModel(id, opts.model, entry.defaultModel);
      const model = resolved.model;
      debugProviderCall({
        providerId: id,
        apiType: 'anthropic',
        model,
        modelSource: resolved.source,
        apiKey: entry.apiKey,
        promptPreview: prompt,
      });
      const start = Date.now();
      try {
        const res = await client.messages.create({
          model,
          max_tokens: opts.maxTokens ?? 1024,
          messages: [{ role: 'user', content: prompt }],
        });
        const latencyMs = Date.now() - start;
        const text = res.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: unknown) => (b as { text: string }).text)
          .join('');
        const inputTokens = res.usage.input_tokens;
        const outputTokens = res.usage.output_tokens;
        const actualModel = res.model ?? model;
        debugProviderResponse(id, actualModel, { input: inputTokens, output: outputTokens, latencyMs });
        return {
          text,
          inputTokens,
          outputTokens,
          costUsd: priceFor(actualModel, inputTokens, outputTokens),
          latencyMs,
          model: actualModel,
        };
      } catch (err) {
        debugProviderError(id, err);
        throw err;
      }
    },

    async *stream(prompt: string, opts: ProviderCallOptions = {}): AsyncIterable<StreamEvent> {
      const resolved = resolveModel(id, opts.model, entry.defaultModel);
      const model = resolved.model;
      debugProviderCall({
        providerId: id,
        apiType: 'anthropic',
        model,
        modelSource: resolved.source,
        apiKey: entry.apiKey,
        promptPreview: prompt,
      });
      const start = Date.now();
      try {
        const ms = client.messages.stream({
          model,
          max_tokens: opts.maxTokens ?? 1024,
          messages: [{ role: 'user', content: prompt }],
        });
        for await (const ev of ms) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            yield { type: 'text', delta: ev.delta.text };
          }
        }
        const final = await ms.finalMessage();
        const latencyMs = Date.now() - start;
        const inputTokens = final.usage.input_tokens;
        const outputTokens = final.usage.output_tokens;
        const actualModel = final.model ?? model;
        debugProviderResponse(id, actualModel, { input: inputTokens, output: outputTokens, latencyMs });
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
      } catch (err) {
        debugProviderError(id, err);
        throw err;
      }
    },
  };
}

// ---------- OpenAI-compatible (OpenAI, DeepSeek, Mistral, Groq, ...) ----------

function openaiCompatClient(id: string, entry: ProviderEntry): ProviderClient {
  const client = new OpenAI({
    apiKey: entry.apiKey,
    baseURL: entry.baseUrl,
  });

  return {
    id,
    defaultModel: entry.defaultModel,

    async call(prompt: string, opts: ProviderCallOptions = {}): Promise<ProviderResponse> {
      const resolved = resolveModel(id, opts.model, entry.defaultModel);
      const model = resolved.model;
      debugProviderCall({
        providerId: id,
        apiType: 'openai-compat',
        model,
        modelSource: resolved.source,
        baseUrl: entry.baseUrl,
        apiKey: entry.apiKey,
        promptPreview: prompt,
      });
      const start = Date.now();
      try {
        const res = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: opts.maxTokens ?? 1024,
        });
        const latencyMs = Date.now() - start;
        const text = res.choices[0]?.message?.content ?? '';
        const inputTokens = res.usage?.prompt_tokens ?? 0;
        const outputTokens = res.usage?.completion_tokens ?? 0;
        const actualModel = res.model ?? model;
        debugProviderResponse(id, actualModel, { input: inputTokens, output: outputTokens, latencyMs });
        return {
          text,
          inputTokens,
          outputTokens,
          costUsd: priceFor(actualModel, inputTokens, outputTokens),
          latencyMs,
          model: actualModel,
        };
      } catch (err) {
        debugProviderError(id, err);
        throw err;
      }
    },

    async *stream(prompt: string, opts: ProviderCallOptions = {}): AsyncIterable<StreamEvent> {
      const resolved = resolveModel(id, opts.model, entry.defaultModel);
      const model = resolved.model;
      debugProviderCall({
        providerId: id,
        apiType: 'openai-compat',
        model,
        modelSource: resolved.source,
        baseUrl: entry.baseUrl,
        apiKey: entry.apiKey,
        promptPreview: prompt,
      });
      const start = Date.now();
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: opts.maxTokens ?? 1024,
          stream: true,
          stream_options: { include_usage: true },
        });
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
        debugProviderResponse(id, actualModel, { input: inputTokens, output: outputTokens, latencyMs });
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
      } catch (err) {
        debugProviderError(id, err);
        throw err;
      }
    },
  };
}

// ---------- Gemini ----------

function geminiClient(id: string, entry: ProviderEntry): ProviderClient {
  const genAI = new GoogleGenerativeAI(entry.apiKey);

  return {
    id,
    defaultModel: entry.defaultModel,

    async call(prompt: string, opts: ProviderCallOptions = {}): Promise<ProviderResponse> {
      const resolved = resolveModel(id, opts.model, entry.defaultModel);
      const modelName = resolved.model;
      debugProviderCall({
        providerId: id,
        apiType: 'gemini',
        model: modelName,
        modelSource: resolved.source,
        apiKey: entry.apiKey,
        promptPreview: prompt,
      });
      const model = genAI.getGenerativeModel({ model: modelName });
      const start = Date.now();
      try {
        const result = await model.generateContent(prompt);
        const latencyMs = Date.now() - start;
        const text = result.response.text();
        const usage = result.response.usageMetadata;
        const inputTokens = usage?.promptTokenCount ?? 0;
        const outputTokens = usage?.candidatesTokenCount ?? 0;
        debugProviderResponse(id, modelName, { input: inputTokens, output: outputTokens, latencyMs });
        return {
          text,
          inputTokens,
          outputTokens,
          costUsd: priceFor(modelName, inputTokens, outputTokens),
          latencyMs,
          model: modelName,
        };
      } catch (err) {
        debugProviderError(id, err);
        throw err;
      }
    },

    async *stream(prompt: string, opts: ProviderCallOptions = {}): AsyncIterable<StreamEvent> {
      const resolved = resolveModel(id, opts.model, entry.defaultModel);
      const modelName = resolved.model;
      debugProviderCall({
        providerId: id,
        apiType: 'gemini',
        model: modelName,
        modelSource: resolved.source,
        apiKey: entry.apiKey,
        promptPreview: prompt,
      });
      const model = genAI.getGenerativeModel({ model: modelName });
      const start = Date.now();
      try {
        const result = await model.generateContentStream(prompt);
        for await (const chunk of result.stream) {
          const text = chunk.text();
          if (text) yield { type: 'text', delta: text };
        }
        const final = await result.response;
        const usage = final.usageMetadata;
        const inputTokens = usage?.promptTokenCount ?? 0;
        const outputTokens = usage?.candidatesTokenCount ?? 0;
        const latencyMs = Date.now() - start;
        debugProviderResponse(id, modelName, { input: inputTokens, output: outputTokens, latencyMs });
        yield {
          type: 'done',
          usage: {
            inputTokens,
            outputTokens,
            latencyMs,
            model: modelName,
            costUsd: priceFor(modelName, inputTokens, outputTokens),
          },
        };
      } catch (err) {
        debugProviderError(id, err);
        throw err;
      }
    },
  };
}
