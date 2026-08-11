import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';

const createMock = vi.fn();
const ConstructorMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages: { create: typeof createMock };
    constructor(opts: { apiKey: string }) {
      ConstructorMock(opts);
      this.messages = { create: createMock };
    }
  }
  return { default: MockAnthropic };
});

const baseResponse = {
  content: [
    {
      type: 'tool_use',
      id: 't1',
      name: 'analyze',
      input: { result: 'ok' },
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
};

const fakeTool: Tool = {
  name: 'analyze',
  description: 'test',
  input_schema: { type: 'object' as const, properties: {} },
};

describe('callClaude — Prompt Caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue(baseResponse);
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('wraps system prompt with cache_control by default', async () => {
    const { callClaude } = await import('../claude-client');

    await callClaude({
      systemPrompt: 'You are a code reviewer.',
      userMessage: 'analyze this',
      tools: [fakeTool],
    });

    expect(createMock).toHaveBeenCalledOnce();
    const callArgs = createMock.mock.calls[0][0];
    expect(Array.isArray(callArgs.system)).toBe(true);
    expect(callArgs.system[0]).toMatchObject({
      type: 'text',
      text: 'You are a code reviewer.',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('skips cache_control when cacheSystem=false', async () => {
    const { callClaude } = await import('../claude-client');

    await callClaude({
      systemPrompt: 'plain',
      userMessage: 'm',
      tools: [fakeTool],
      cacheSystem: false,
    });

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.system).toBe('plain');
  });

  it('uses provided model override', async () => {
    const { callClaude } = await import('../claude-client');

    await callClaude({
      systemPrompt: 's',
      userMessage: 'm',
      tools: [fakeTool],
      model: 'claude-haiku-4-5-20251001',
    });

    expect(createMock.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('callClaude — max_tokens 사일런트 실패 방지', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('stop_reason=max_tokens일 때 console.warn으로 경고를 남긴다 (정상 케이스)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createMock.mockResolvedValue({ ...baseResponse, stop_reason: 'max_tokens' });
    const { callClaude } = await import('../claude-client');

    await callClaude({
      systemPrompt: 's',
      userMessage: 'm',
      tools: [fakeTool],
      maxTokens: 4096,
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('stop_reason=max_tokens');
    expect(msg).toContain('max_tokens=4096');
    expect(msg).toContain('in:100/out:50');
    warnSpy.mockRestore();
  });

  it('stop_reason=end_turn일 때는 경고를 남기지 않는다 (엣지)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createMock.mockResolvedValue({ ...baseResponse, stop_reason: 'end_turn' });
    const { callClaude } = await import('../claude-client');

    await callClaude({
      systemPrompt: 's',
      userMessage: 'm',
      tools: [fakeTool],
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('stop_reason 누락 시에도 경고를 남기지 않는다 (방어 — 에러)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createMock.mockResolvedValue(baseResponse); // stop_reason 미정의
    const { callClaude } = await import('../claude-client');

    await callClaude({
      systemPrompt: 's',
      userMessage: 'm',
      tools: [fakeTool],
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('callClaude — BYOK', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue(baseResponse);
    process.env.ANTHROPIC_API_KEY = 'service-key';
  });

  it('creates new client with user apiKey when provided', async () => {
    const { callClaude } = await import('../claude-client');

    await callClaude({
      systemPrompt: 's',
      userMessage: 'm',
      tools: [fakeTool],
      apiKey: 'sk-ant-user-key',
    });

    // 마지막 Anthropic 생성자 호출이 user 키여야 함
    const lastCall = ConstructorMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ apiKey: 'sk-ant-user-key' });
  });
});
