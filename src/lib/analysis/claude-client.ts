import Anthropic from '@anthropic-ai/sdk';
import type { Tool, Message } from '@anthropic-ai/sdk/resources/messages';

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4096;

let defaultClient: Anthropic | null = null;

function getDefaultClient(): Anthropic {
  if (!defaultClient) {
    defaultClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    });
  }
  return defaultClient;
}

/**
 * BYOK 호출용 — 매번 새 인스턴스 (키 충돌 방지, 메모리 보관 시간 최소화).
 */
function getByokClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

export interface ClaudeCallOptions {
  systemPrompt: string;
  userMessage: string;
  tools: Tool[];
  maxTokens?: number;
  /** override default model (e.g. Haiku for light analysis) */
  model?: string;
  /** BYOK API key. 있으면 유저 키로 호출, 없으면 서비스 키. */
  apiKey?: string;
  /** false면 cache_control 미적용. 기본 true. */
  cacheSystem?: boolean;
}

export interface ClaudeCallResult {
  toolInputs: Record<string, unknown>[];
  tokenUsage: {
    input: number;
    output: number;
  };
  rawResponse: Message;
}

/**
 * Claude API를 호출하고 tool_use 응답을 파싱합니다.
 * temperature=0으로 결정적 분석 결과를 보장합니다.
 *
 * Prompt Caching: cacheSystem !== false면 system prompt에 ephemeral cache_control 적용.
 * 동일 system으로 5분 내 재호출 시 입력 비용 90% 절감.
 */
export async function callClaude(options: ClaudeCallOptions): Promise<ClaudeCallResult> {
  const anthropic = options.apiKey ? getByokClient(options.apiKey) : getDefaultClient();
  const cacheEnabled = options.cacheSystem !== false;

  const system = cacheEnabled
    ? [
        {
          type: 'text' as const,
          text: options.systemPrompt,
          cache_control: { type: 'ephemeral' as const },
        },
      ]
    : options.systemPrompt;

  const response = await anthropic.messages.create({
    model: options.model ?? MODEL,
    max_tokens: options.maxTokens ?? MAX_TOKENS,
    temperature: 0,
    system,
    messages: [
      { role: 'user', content: options.userMessage },
    ],
    tools: options.tools,
    tool_choice: { type: 'any' },
  });

  // max_tokens 도달 시 SDK가 tool_use input을 잘라서 반환할 수 있음 — 사일런트 실패 방지.
  if (response.stop_reason === 'max_tokens') {
    console.warn(
      `[callClaude] stop_reason=max_tokens — response truncated. ` +
        `model=${options.model ?? MODEL} max_tokens=${options.maxTokens ?? MAX_TOKENS} ` +
        `usage=in:${response.usage.input_tokens}/out:${response.usage.output_tokens}. ` +
        `Increase maxTokens or chunk input.`
    );
  }

  // tool_use 블록 추출
  const toolInputs: Record<string, unknown>[] = [];
  for (const block of response.content) {
    if (block.type === 'tool_use') {
      toolInputs.push(block.input as Record<string, unknown>);
    }
  }

  return {
    toolInputs,
    tokenUsage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
    rawResponse: response,
  };
}

/**
 * 토큰 수를 대략적으로 추정합니다. (1 토큰 ≈ 4 chars)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export { MODEL, MAX_TOKENS };
