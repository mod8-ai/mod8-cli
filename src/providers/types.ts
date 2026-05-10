/** Any provider id (built-in or custom). */
type ProviderId = string;

export interface ProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  model: string;
}

export interface ProviderCallOptions {
  model?: string;
  maxTokens?: number;
}

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
  costUsd: number;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'done'; usage: StreamUsage };

export interface ProviderClient {
  id: ProviderId;
  defaultModel: string;
  call(prompt: string, opts?: ProviderCallOptions): Promise<ProviderResponse>;
  stream(prompt: string, opts?: ProviderCallOptions): AsyncIterable<StreamEvent>;
}
