import { describe, it, expect, vi, beforeEach } from 'vitest';

// callClaude를 mock — 실제 Claude API를 호출하지 않도록 차단
vi.mock('../claude-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude-client')>();
  return {
    ...actual,
    callClaude: vi.fn(),
  };
});

import { callClaude } from '../claude-client';
import {
  analyzeStatic,
  TOKEN_BUDGET,
  MAX_API_CALLS,
  getFilePriority,
  chunkDiffs,
  formatUnprocessedFilesWarning,
} from '../static-analyzer';
import type { Message } from '@anthropic-ai/sdk/resources/messages';

const mockedCallClaude = callClaude as ReturnType<typeof vi.fn>;

// ─── 헬퍼 ───

/**
 * estimateTokens(text) = ceil(text.length / 4) 이므로,
 * targetTokens 토큰의 diff_content를 만들려면 length = targetTokens * 4 필요.
 */
function makeDiff(filePath: string, targetTokens: number) {
  return {
    file_path: filePath,
    diff_content: 'x'.repeat(targetTokens * 4),
  };
}

/** Claude API의 빈 분석 결과 응답 — 청크별 호출 시마다 빈 issues 반환 */
function emptyClaudeResult() {
  return {
    toolInputs: [{ issues: [] }],
    tokenUsage: { input: 100, output: 50 },
    rawResponse: {} as Message,
  };
}

beforeEach(() => {
  mockedCallClaude.mockReset();
  mockedCallClaude.mockResolvedValue(emptyClaudeResult());
});

// ─── getFilePriority ───

describe('getFilePriority', () => {
  it('app/api/ 경로는 1순위(6)', () => {
    expect(getFilePriority('app/api/users/route.ts')).toBe(6);
    expect(getFilePriority('app/api/agent/push/route.ts')).toBe(6);
  });

  it('auth/middleware/proxy 경로는 2순위(5)', () => {
    expect(getFilePriority('middleware.ts')).toBe(5);
    expect(getFilePriority('src/lib/agent/auth-agent.ts')).toBe(5);
    expect(getFilePriority('src/lib/supabase/proxy.ts')).toBe(5);
  });

  it('src/lib/ 경로는 3순위(4)', () => {
    expect(getFilePriority('src/lib/analysis/foo.ts')).toBe(4);
    expect(getFilePriority('src/lib/utils.ts')).toBe(4);
  });

  it('src/components/ 경로는 4순위(3)', () => {
    expect(getFilePriority('src/components/Button.tsx')).toBe(3);
    expect(getFilePriority('src/components/features/issues/IssueList.tsx')).toBe(3);
  });

  it('설정 파일은 5순위(2)', () => {
    expect(getFilePriority('package.json')).toBe(2);
    expect(getFilePriority('tsconfig.json')).toBe(2);
    expect(getFilePriority('next.config.ts')).toBe(2);
    expect(getFilePriority('vercel.json')).toBe(2);
    expect(getFilePriority('.gitignore')).toBe(2);
    expect(getFilePriority('.env.local')).toBe(2);
  });

  it('그 외는 6순위(1)', () => {
    expect(getFilePriority('README.md')).toBe(1);
    expect(getFilePriority('public/logo.svg')).toBe(1);
    expect(getFilePriority('docs/foo.md')).toBe(1);
  });

  it('우선순위가 높은 파일이 정렬에서 앞으로 온다', () => {
    const files = [
      'README.md',
      'src/components/X.tsx',
      'app/api/users/route.ts',
      'src/lib/foo.ts',
      'package.json',
    ];
    const sorted = [...files].sort((a, b) => getFilePriority(b) - getFilePriority(a));
    expect(sorted).toEqual([
      'app/api/users/route.ts', // 6
      'src/lib/foo.ts',          // 4
      'src/components/X.tsx',    // 3
      'package.json',            // 2
      'README.md',               // 1
    ]);
  });
});

// ─── chunkDiffs ───

describe('chunkDiffs', () => {
  it('단일 작은 diff는 1청크로 들어간다', () => {
    const diffs = [makeDiff('a.ts', 1000)];
    const { chunks, oversizedFiles } = chunkDiffs(diffs);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
    expect(oversizedFiles).toHaveLength(0);
  });

  it('여러 파일이 CHUNK_TARGET 안에 들어가면 1청크', () => {
    // CHUNK_TARGET = 10_000. 각 3000씩 3개 = 9000 → 한 청크
    const diffs = [
      makeDiff('a.ts', 3000),
      makeDiff('b.ts', 3000),
      makeDiff('c.ts', 3000),
    ];
    const { chunks, oversizedFiles } = chunkDiffs(diffs);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
    expect(oversizedFiles).toHaveLength(0);
  });

  it('CHUNK_TARGET 초과 시 청크가 나뉜다', () => {
    // 각 6000씩 3개 = 18000, CHUNK_TARGET=10000 → 2개 + 1개로 분할
    const diffs = [
      makeDiff('a.ts', 6000),
      makeDiff('b.ts', 6000),
      makeDiff('c.ts', 6000),
    ];
    const { chunks } = chunkDiffs(diffs);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 모든 파일이 어느 청크엔가 들어가야 함
    const totalFiles = chunks.flat().length;
    expect(totalFiles).toBe(3);
  });

  it('단일 파일이 HARD 초과하면 oversizedFiles로 분리된다', () => {
    // DIFF_HARD_LIMIT = 20_000, 25000짜리 단일 파일 → oversized
    const diffs = [
      makeDiff('huge.ts', 25_000),
      makeDiff('small.ts', 1000),
    ];
    const { chunks, oversizedFiles } = chunkDiffs(diffs);
    expect(oversizedFiles).toHaveLength(1);
    expect(oversizedFiles[0].file_path).toBe('huge.ts');
    // small.ts는 정상 청크에 들어감
    expect(chunks.flat().some((d) => d.file_path === 'small.ts')).toBe(true);
    expect(chunks.flat().some((d) => d.file_path === 'huge.ts')).toBe(false);
  });
});

// ─── formatUnprocessedFilesWarning ───

describe('formatUnprocessedFilesWarning', () => {
  it('5개 이하 파일은 모두 본문에 표시한다', () => {
    const msg = formatUnprocessedFilesWarning(['a.ts', 'b.ts', 'c.ts'], 'token-budget');
    expect(msg).toContain('3 files');
    expect(msg).toContain('a.ts');
    expect(msg).toContain('b.ts');
    expect(msg).toContain('c.ts');
    expect(msg).not.toContain('외');
  });

  it('5개 초과 시 처음 5개 + "...(외 N개)" 축약', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    const msg = formatUnprocessedFilesWarning(files, 'token-budget');
    expect(msg).toContain('7 files');
    expect(msg).toContain('a.ts');
    expect(msg).toContain('e.ts');
    expect(msg).not.toContain('f.ts'); // HEAD_LIMIT(5) 이후는 본문에서 제외
    expect(msg).toContain('외 2개');
  });

  it('reason에 따라 메시지 사유가 달라진다', () => {
    const tokenBudgetMsg = formatUnprocessedFilesWarning(['a.ts'], 'token-budget');
    const oversizedMsg = formatUnprocessedFilesWarning(['a.ts'], 'oversized');
    expect(tokenBudgetMsg).toContain('token budget');
    expect(oversizedMsg).toContain('exceeds hard limit');
  });
});

// ─── analyzeStatic 동작 테스트 ───

describe('analyzeStatic — 임계값 분기', () => {
  it('SOFT 미만 diff는 단일 호출, "Large diff" 경고 없음', async () => {
    const result = await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: ['a.ts'],
      diffs: [makeDiff('a.ts', 5_000)], // < SOFT(10K)
    });

    expect(mockedCallClaude).toHaveBeenCalledTimes(1);
    expect(result.warnings.some((w) => w.includes('Large diff'))).toBe(false);
    expect(result.unprocessed_files).toBeUndefined();
  });

  it('SOFT~HARD 사이 diff는 단일 호출 + "Large diff" 정보 경고', async () => {
    const result = await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: ['a.ts'],
      diffs: [makeDiff('a.ts', 15_000)], // SOFT < x < HARD
    });

    expect(mockedCallClaude).toHaveBeenCalledTimes(1);
    expect(result.warnings.some((w) => w.includes('Large diff'))).toBe(true);
  });

  it('HARD 초과 diff는 청크 분할 진입', async () => {
    // 4파일 × 6000 = 24000 → HARD 초과 → split
    const result = await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      diffs: [
        makeDiff('a.ts', 6_000),
        makeDiff('b.ts', 6_000),
        makeDiff('c.ts', 6_000),
        makeDiff('d.ts', 6_000),
      ],
    });

    // 분할되어 여러 번 호출됨
    expect(mockedCallClaude.mock.calls.length).toBeGreaterThanOrEqual(2);
    // SOFT~HARD 경고는 단일 호출 분기에서만 추가되므로 split에서는 없음
    expect(result.warnings.some((w) => w.includes('Large diff'))).toBe(false);
  });
});

describe('analyzeStatic — 미처리 파일 fallback', () => {
  it('MAX_API_CALLS 초과 시 잔여 청크 파일이 unprocessed_files로 노출', async () => {
    // 청크가 7개 만들어지도록: 7 * 9_000 = 63_000 (각 9K씩, CHUNK_TARGET=10K)
    const diffs = Array.from({ length: 7 }, (_, i) =>
      makeDiff(`other/file${i}.ts`, 9_000)
    );

    const result = await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: diffs.map((d) => d.file_path),
      diffs,
    });

    // MAX_API_CALLS(5)만 호출, 잔여 2청크 = 2개 파일이 미처리
    expect(mockedCallClaude.mock.calls.length).toBe(MAX_API_CALLS);
    expect(result.unprocessed_files).toBeDefined();
    expect(result.unprocessed_files!.length).toBe(2);
    expect(result.warnings.some((w) => w.includes('Reached max API calls'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Unanalyzed files'))).toBe(true);
  });

  it('우선순위 낮은 파일이 먼저 미처리로 잘린다', async () => {
    // 7개 파일, 각 9K. 일부는 app/api/ (priority 6), 일부는 docs (priority 1).
    // priority 정렬 후 chunk되므로 docs/* 파일이 뒤쪽 청크에 → MAX_API_CALLS 초과 시 미처리
    const diffs = [
      makeDiff('app/api/a.ts', 9_000), // priority 6
      makeDiff('app/api/b.ts', 9_000), // priority 6
      makeDiff('app/api/c.ts', 9_000), // priority 6
      makeDiff('app/api/d.ts', 9_000), // priority 6
      makeDiff('app/api/e.ts', 9_000), // priority 6
      makeDiff('docs/x.md', 9_000),    // priority 1
      makeDiff('docs/y.md', 9_000),    // priority 1
    ];

    const result = await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: diffs.map((d) => d.file_path),
      diffs,
    });

    // docs/* 파일이 미처리에 들어가야 함 (낮은 우선순위)
    expect(result.unprocessed_files).toBeDefined();
    expect(result.unprocessed_files).toContain('docs/x.md');
    expect(result.unprocessed_files).toContain('docs/y.md');
    expect(result.unprocessed_files).not.toContain('app/api/a.ts');
  });

  it('단일 파일이 HARD 초과 시 oversized로 분류되어 미처리', async () => {
    const result = await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: ['huge.ts', 'small.ts'],
      diffs: [
        makeDiff('huge.ts', 25_000),  // HARD(20K) 초과
        makeDiff('small.ts', 1_000),
      ],
    });

    expect(result.unprocessed_files).toContain('huge.ts');
    expect(result.unprocessed_files).not.toContain('small.ts');
    expect(result.warnings.some((w) => w.includes('exceeds hard limit'))).toBe(true);
  });
});

describe('TOKEN_BUDGET 상수', () => {
  it('SOFT < HARD < MAX_INPUT 부등식이 성립한다', () => {
    expect(TOKEN_BUDGET.DIFF_SOFT_LIMIT).toBeLessThan(TOKEN_BUDGET.DIFF_HARD_LIMIT);
    expect(TOKEN_BUDGET.DIFF_HARD_LIMIT).toBeLessThanOrEqual(TOKEN_BUDGET.MAX_INPUT);
  });

  it('CHUNK_TARGET <= DIFF_HARD_LIMIT', () => {
    expect(TOKEN_BUDGET.CHUNK_TARGET).toBeLessThanOrEqual(TOKEN_BUDGET.DIFF_HARD_LIMIT);
  });

  it('OUTPUT_BUFFER_PROBLEMS_ONLY <= OUTPUT_BUFFER_FULL', () => {
    expect(TOKEN_BUDGET.OUTPUT_BUFFER_PROBLEMS_ONLY).toBeLessThanOrEqual(
      TOKEN_BUDGET.OUTPUT_BUFFER_FULL
    );
  });
});

describe('analyzeStatic — ESLint 통합', () => {
  function eslintRaw(overrides: Record<string, unknown> = {}) {
    return {
      file_path: 'src/foo.ts',
      line: 1,
      column: 1,
      rule_id: 'no-eval',
      severity: 2 as const,
      message: 'eval is bad',
      ...overrides,
    };
  }

  it('ESLint 결과가 LLM user 메시지에 첨부된다', async () => {
    await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: ['a.ts'],
      diffs: [makeDiff('a.ts', 1_000)],
      eslintResults: [eslintRaw({ file_path: 'a.ts', line: 5, message: 'oh' })],
    });

    expect(mockedCallClaude).toHaveBeenCalledTimes(1);
    const userMessage = mockedCallClaude.mock.calls[0][0].userMessage as string;
    expect(userMessage).toContain('정적 분석 결과 (ESLint)');
    expect(userMessage).toContain('a.ts:5');
    expect(userMessage).toContain('no-eval');
  });

  it('ESLint 결과 없으면 user 메시지에 ESLint 섹션이 없다', async () => {
    await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: ['a.ts'],
      diffs: [makeDiff('a.ts', 1_000)],
    });
    const userMessage = mockedCallClaude.mock.calls[0][0].userMessage as string;
    expect(userMessage).not.toContain('정적 분석 결과 (ESLint)');
  });

  it('severity 2 ESLint 결과가 CodeSasu warning 이슈로 변환된다', async () => {
    const result = await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: ['a.ts'],
      diffs: [makeDiff('a.ts', 1_000)],
      eslintResults: [
        eslintRaw({ rule_id: 'no-eval', severity: 2, line: 8, file_path: 'a.ts' }),
      ],
    });

    const evalIssue = result.issues.find((i) => i.basis === 'ESLint: no-eval');
    expect(evalIssue).toBeDefined();
    expect(evalIssue!.level).toBe('warning');
    expect(evalIssue!.confidence).toBe(0.9);
    expect(evalIssue!.start_line).toBe(8);
  });

  it('LLM이 basis="ESLint:..."로 보고하면 드롭된다 (이중 보고 방지)', async () => {
    mockedCallClaude.mockResolvedValueOnce({
      toolInputs: [
        {
          issues: [
            {
              title: 'eval 사용',
              level: 'warning',
              fact: 'fact',
              detail: 'detail',
              fix_command: 'fix',
              file: 'a.ts',
              basis: 'ESLint: no-eval', // 이중 보고
              confidence: 0.85,
              start_line: 8,
              end_line: 8,
            },
            {
              title: 'API 키 노출',
              level: 'critical',
              fact: 'API key',
              detail: 'detail',
              fix_command: 'fix',
              file: 'a.ts',
              basis: 'OWASP A07:2021',
              confidence: 0.95,
              start_line: 12,
              end_line: 12,
            },
          ],
        },
      ],
      tokenUsage: { input: 100, output: 50 },
      rawResponse: {} as Message,
    });

    const result = await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: ['a.ts'],
      diffs: [makeDiff('a.ts', 1_000)],
      eslintResults: [eslintRaw({ rule_id: 'no-eval', file_path: 'a.ts', line: 8 })],
    });

    // basis가 'ESLint:'로 시작하는 LLM 이슈는 드롭됨
    // → 그러나 ESLint 자체 변환에서 'ESLint: no-eval'은 들어옴 (한 번만)
    const eslintIssues = result.issues.filter((i) => i.basis.startsWith('ESLint:'));
    expect(eslintIssues).toHaveLength(1);
    expect(eslintIssues[0].confidence).toBe(0.9); // ESLint 변환의 confidence

    // OWASP 이슈는 정상 보존
    const owasp = result.issues.find((i) => i.basis.includes('OWASP'));
    expect(owasp).toBeDefined();
  });

  it('diff가 없어도 ESLint 결과만으로 결과 반환', async () => {
    const result = await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: [],
      diffs: [],
      eslintResults: [eslintRaw({ rule_id: 'no-eval', severity: 2 })],
    });

    expect(mockedCallClaude).not.toHaveBeenCalled();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].basis).toBe('ESLint: no-eval');
  });

  it('warnings에 "ESLint integration: N raw findings, M auto-converted" 추가', async () => {
    const result = await analyzeStatic({
      projectName: 'p',
      sessionTitle: 's',
      filesChanged: ['a.ts'],
      diffs: [makeDiff('a.ts', 1_000)],
      eslintResults: [
        eslintRaw({ rule_id: 'no-eval', file_path: 'a.ts' }),
        eslintRaw({ rule_id: '@typescript-eslint/no-unused-vars', file_path: 'a.ts' }),
      ],
    });

    const integrationWarning = result.warnings.find((w) =>
      w.includes('ESLint integration')
    );
    expect(integrationWarning).toBeDefined();
    expect(integrationWarning).toContain('2 raw findings');
    // no-unused-vars는 변환 제외 → 1건만 변환
    expect(integrationWarning).toContain('1 auto-converted');
  });
});

describe('analyzeStatic — auditMode (부팅 스캔 전용 프롬프트)', () => {
  it('auditMode=true면 callClaude에 BOOT_SCAN_SYSTEM이 전달된다', async () => {
    // 동기 import는 vi.mock 순서 문제로 ESM 환경에서 안정적이지 않으므로
    // 동적 import로 시점을 늦춰 vi.mock이 먼저 적용되도록 함.
    const { BOOT_SCAN_SYSTEM } = await import('../prompts');

    const diffs = [makeDiff('app/api/auth.ts', 1_000)];
    await analyzeStatic(
      {
        projectName: 'p',
        sessionTitle: 's',
        filesChanged: diffs.map((d) => d.file_path),
        diffs,
      },
      'full',
      { auditMode: true }
    );

    expect(mockedCallClaude).toHaveBeenCalledTimes(1);
    const callArgs = mockedCallClaude.mock.calls[0][0] as { systemPrompt: string };
    expect(callArgs.systemPrompt).toBe(BOOT_SCAN_SYSTEM);
    // 운영 코드 감사 톤의 시그니처 키워드도 확인 (BOOT_SCAN_SYSTEM 본문 검증은 prompts.test.ts)
    expect(callArgs.systemPrompt).toContain('운영 중인');
  });

  it('auditMode 미지정 시에는 buildStaticAnalysisSystem(mode)이 사용된다 (기본 동작 유지)', async () => {
    const { buildStaticAnalysisSystem, BOOT_SCAN_SYSTEM } = await import('../prompts');

    const diffs = [makeDiff('src/lib/foo.ts', 1_000)];
    await analyzeStatic(
      {
        projectName: 'p',
        sessionTitle: 's',
        filesChanged: diffs.map((d) => d.file_path),
        diffs,
      },
      'full'
      // options 없음 — 코딩 세션 분석의 기본 경로
    );

    const callArgs = mockedCallClaude.mock.calls[0][0] as { systemPrompt: string };
    expect(callArgs.systemPrompt).toBe(buildStaticAnalysisSystem('full'));
    expect(callArgs.systemPrompt).not.toBe(BOOT_SCAN_SYSTEM);
  });

  it('maxApiCallsOverride=15면 split 경로에서 최대 15회까지 호출된다 (부팅 스캔 한도 상향)', async () => {
    // 16개 청크가 만들어지도록: 16 * 9_000 = 144_000 (각 9K씩, CHUNK_TARGET=10K)
    // 기본 MAX_API_CALLS=5라면 11청크 미처리, override=15면 1청크만 미처리.
    const diffs = Array.from({ length: 16 }, (_, i) =>
      makeDiff(`src/lib/file${i}.ts`, 9_000)
    );

    const result = await analyzeStatic(
      {
        projectName: 'p',
        sessionTitle: 's',
        filesChanged: diffs.map((d) => d.file_path),
        diffs,
      },
      'full',
      { auditMode: true, maxApiCallsOverride: 15 }
    );

    // 정확히 15회 호출, 1청크(=1개 파일)만 미처리
    expect(mockedCallClaude.mock.calls.length).toBe(15);
    expect(result.unprocessed_files).toBeDefined();
    expect(result.unprocessed_files!.length).toBe(1);
    // warning 메시지의 한도 표기도 15로 갱신됨
    expect(
      result.warnings.some((w) => w.includes('Reached max API calls (15)'))
    ).toBe(true);
  });

  it('maxApiCallsOverride 미지정 시 기존 MAX_API_CALLS(5) 한도 유지', async () => {
    // 7개 청크 → 기본 5회까지만 호출, 2청크 미처리 (기존 회귀 보호 테스트와 동일)
    const diffs = Array.from({ length: 7 }, (_, i) =>
      makeDiff(`src/lib/g${i}.ts`, 9_000)
    );

    const result = await analyzeStatic(
      {
        projectName: 'p',
        sessionTitle: 's',
        filesChanged: diffs.map((d) => d.file_path),
        diffs,
      },
      'full',
      { auditMode: true } // override 없음 — auditMode만 켜져도 한도는 그대로
    );

    expect(mockedCallClaude.mock.calls.length).toBe(MAX_API_CALLS);
    expect(result.unprocessed_files!.length).toBe(2);
    expect(
      result.warnings.some((w) => w.includes(`Reached max API calls (${MAX_API_CALLS})`))
    ).toBe(true);
  });
});
