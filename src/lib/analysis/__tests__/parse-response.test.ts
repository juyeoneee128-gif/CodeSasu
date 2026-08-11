import { describe, it, expect } from 'vitest';
import {
  parseAnalysisResponse,
  parseGuidelineResponse,
  applyLevelLimits,
  getLevelLimits,
  LEVEL_LIMITS_FULL,
  LEVEL_LIMITS_PROBLEMS_ONLY,
} from '../parse-response';
import type { DetectedIssue } from '../parse-response';
import type { ClaudeCallResult } from '../claude-client';
import type { Message } from '@anthropic-ai/sdk/resources/messages';

// ─── Mock 헬퍼 ───

function mockResult(toolInputs: Record<string, unknown>[]): ClaudeCallResult {
  return {
    toolInputs,
    tokenUsage: { input: 500, output: 200 },
    rawResponse: {} as Message,
  };
}

function fullIssue(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    title: '기본 이슈',
    level: 'info',
    fact: 'fact',
    detail: 'detail',
    fix_command: 'fix',
    file: 'file.ts',
    basis: 'basis',
    confidence: 0.8,
    start_line: 1,
    end_line: 1,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<DetectedIssue> = {}): DetectedIssue {
  return {
    title: 't',
    level: 'info',
    fact: 'f',
    detail: 'd',
    fix_command: 'fc',
    file: 'a.ts',
    basis: 'b',
    confidence: 0.8,
    start_line: 1,
    end_line: 1,
    ...overrides,
  };
}

describe('parseAnalysisResponse', () => {
  it('정상적인 이슈 배열을 파싱한다', () => {
    const result = parseAnalysisResponse(
      mockResult([
        {
          issues: [
            fullIssue({
              title: 'API 키 하드코딩 감지',
              level: 'critical',
              fact: 'src/config.ts에 API 키가 하드코딩되어 있습니다.',
              detail: '코드가 push되면 키가 노출됩니다.',
              fix_command: 'src/config.ts의 API 키를 환경변수로 바꿔줘.',
              file: 'src/config.ts',
              basis: 'OWASP A02:2021',
              confidence: 0.95,
              start_line: 12,
              end_line: 12,
            }),
            fullIssue({
              title: '에러 처리 누락',
              level: 'warning',
              fact: 'async 함수에 try-catch가 없습니다.',
              detail: '에러 발생 시 서버가 크래시할 수 있습니다.',
              fix_command: 'src/api/handler.ts의 async 함수에 에러 처리를 추가해줘.',
              file: 'src/api/handler.ts',
              basis: 'Error Handling Best Practices',
              confidence: 0.7,
              start_line: 24,
              end_line: 31,
            }),
          ],
        },
      ])
    );

    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].title).toBe('API 키 하드코딩 감지');
    expect(result.issues[0].level).toBe('critical');
    expect(result.issues[0].confidence).toBe(0.95);
    expect(result.issues[0].start_line).toBe(12);
    expect(result.issues[1].level).toBe('warning');
    expect(result.warnings).toHaveLength(0);
    expect(result.tokenUsage.input).toBe(500);
  });

  it('빈 이슈 배열을 반환한다', () => {
    const result = parseAnalysisResponse(mockResult([{ issues: [] }]));

    expect(result.issues).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('도구 미호출 시 경고를 반환한다', () => {
    const result = parseAnalysisResponse(mockResult([]));

    expect(result.issues).toHaveLength(0);
    expect(result.warnings).toContain('Claude did not call the analysis tool');
  });

  it('필수 필드 누락 이슈는 스킵하고 경고를 남긴다', () => {
    const result = parseAnalysisResponse(
      mockResult([
        {
          issues: [
            fullIssue({ title: '정상 이슈' }),
            { title: '불완전 이슈', level: 'critical' }, // fact 등 누락
          ],
        },
      ])
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].title).toBe('정상 이슈');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Issue[1]');
  });

  it('잘못된 level 값은 거부한다', () => {
    const result = parseAnalysisResponse(
      mockResult([
        {
          issues: [fullIssue({ level: 'danger' })],
        },
      ])
    );

    expect(result.issues).toHaveLength(0);
    expect(result.warnings[0]).toContain('invalid level');
  });

  it('confidence 범위 외 값은 거부한다', () => {
    const result = parseAnalysisResponse(
      mockResult([
        { issues: [fullIssue({ confidence: 1.5 })] },
      ])
    );

    expect(result.issues).toHaveLength(0);
    expect(result.warnings[0]).toContain('confidence');
  });

  it('confidence가 숫자가 아니면 거부한다', () => {
    const result = parseAnalysisResponse(
      mockResult([
        { issues: [fullIssue({ confidence: 'high' })] },
      ])
    );

    expect(result.issues).toHaveLength(0);
    expect(result.warnings[0]).toContain('confidence');
  });

  it('start_line이 1 미만이면 거부한다', () => {
    const result = parseAnalysisResponse(
      mockResult([
        { issues: [fullIssue({ start_line: 0 })] },
      ])
    );

    expect(result.issues).toHaveLength(0);
    expect(result.warnings[0]).toContain('start_line');
  });

  it('end_line < start_line이면 거부한다', () => {
    const result = parseAnalysisResponse(
      mockResult([
        { issues: [fullIssue({ start_line: 20, end_line: 10 })] },
      ])
    );

    expect(result.issues).toHaveLength(0);
    expect(result.warnings[0]).toContain('end_line');
  });

  it('start_line이 정수가 아니면 거부한다', () => {
    const result = parseAnalysisResponse(
      mockResult([
        { issues: [fullIssue({ start_line: 1.5 })] },
      ])
    );

    expect(result.issues).toHaveLength(0);
    expect(result.warnings[0]).toContain('start_line');
  });

  it('issues가 배열이 아니면 경고를 남긴다', () => {
    const result = parseAnalysisResponse(mockResult([{ issues: 'not an array' }]));

    expect(result.issues).toHaveLength(0);
    expect(result.warnings).toContain('issues field is not an array');
  });

  it('critical 6건 입력 시 5건만 반환되고 truncate 경고를 남긴다', () => {
    const issues = Array.from({ length: 6 }, (_, i) =>
      fullIssue({
        title: `crit-${i}`,
        level: 'critical',
        confidence: 0.5 + i * 0.05, // i=5가 가장 높음
      })
    );

    const result = parseAnalysisResponse(mockResult([{ issues }]));

    expect(result.issues).toHaveLength(5);
    expect(result.warnings.some((w) => w.includes('Truncated 1 critical'))).toBe(true);
    // confidence 가장 낮은 i=0이 잘려야 함
    const titles = result.issues.map((i) => i.title);
    expect(titles).not.toContain('crit-0');
    expect(titles).toContain('crit-5');
  });
});

describe('applyLevelLimits', () => {
  it('상한 이하면 그대로 반환한다', () => {
    const issues = [
      makeIssue({ level: 'critical' }),
      makeIssue({ level: 'warning' }),
      makeIssue({ level: 'info' }),
    ];
    const { issues: limited, truncationWarnings } = applyLevelLimits(issues);
    expect(limited).toHaveLength(3);
    expect(truncationWarnings).toHaveLength(0);
  });

  it('warning 11건이면 10건만 남기고 confidence 낮은 1건이 잘린다', () => {
    const issues = Array.from({ length: 11 }, (_, i) =>
      makeIssue({
        title: `w-${i}`,
        level: 'warning',
        confidence: i / 11, // i=0이 0, i=10이 가장 높음
      })
    );
    const { issues: limited, truncationWarnings } = applyLevelLimits(issues);
    expect(limited).toHaveLength(10);
    expect(truncationWarnings[0]).toContain('Truncated 1 warning');
    expect(limited.find((i) => i.title === 'w-0')).toBeUndefined();
    expect(limited.find((i) => i.title === 'w-10')).toBeDefined();
  });

  it('레벨별 상한이 독립적으로 적용된다', () => {
    const issues = [
      ...Array.from({ length: 7 }, (_, i) => makeIssue({ level: 'critical', title: `c-${i}`, confidence: 0.5 })),
      ...Array.from({ length: 3 }, (_, i) => makeIssue({ level: 'info', title: `i-${i}`, confidence: 0.5 })),
    ];
    const { issues: limited } = applyLevelLimits(issues);
    expect(limited.filter((i) => i.level === 'critical')).toHaveLength(5);
    expect(limited.filter((i) => i.level === 'info')).toHaveLength(3);
  });

  it('limits 파라미터로 커스텀 상한을 적용할 수 있다', () => {
    const issues = [
      ...Array.from({ length: 4 }, (_, i) => makeIssue({ level: 'critical', title: `c-${i}`, confidence: 0.9 - i * 0.1 })),
      ...Array.from({ length: 2 }, (_, i) => makeIssue({ level: 'info', title: `i-${i}`, confidence: 0.5 })),
    ];
    const { issues: limited, truncationWarnings } = applyLevelLimits(
      issues,
      LEVEL_LIMITS_PROBLEMS_ONLY
    );
    expect(limited.filter((i) => i.level === 'critical')).toHaveLength(3);
    expect(limited.filter((i) => i.level === 'info')).toHaveLength(0);
    expect(truncationWarnings.some((w) => w.includes('Truncated 1 critical'))).toBe(true);
    expect(truncationWarnings.some((w) => w.includes('Truncated 2 info'))).toBe(true);
  });
});

describe('getLevelLimits', () => {
  it('full 모드는 LEVEL_LIMITS_FULL을 반환한다', () => {
    expect(getLevelLimits('full')).toBe(LEVEL_LIMITS_FULL);
    expect(LEVEL_LIMITS_FULL).toEqual({ critical: 5, warning: 10, info: 5 });
  });

  it('problems_only 모드는 LEVEL_LIMITS_PROBLEMS_ONLY를 반환한다', () => {
    expect(getLevelLimits('problems_only')).toBe(LEVEL_LIMITS_PROBLEMS_ONLY);
    expect(LEVEL_LIMITS_PROBLEMS_ONLY).toEqual({ critical: 3, warning: 5, info: 0 });
  });
});

describe('parseAnalysisResponse — 모드별 상한', () => {
  it('mode 인자 없이 호출하면 full 모드 상한을 적용한다', () => {
    const issues = Array.from({ length: 6 }, (_, i) =>
      fullIssue({ title: `c-${i}`, level: 'critical', confidence: 0.5 + i * 0.05 })
    );
    const result = parseAnalysisResponse(mockResult([{ issues }]));
    expect(result.issues).toHaveLength(5); // full 상한
  });

  it('problems_only 모드는 critical을 3건으로 제한한다', () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      fullIssue({ title: `c-${i}`, level: 'critical', confidence: 0.5 + i * 0.05 })
    );
    const result = parseAnalysisResponse(mockResult([{ issues }]), 'problems_only');
    expect(result.issues).toHaveLength(3);
    expect(result.warnings.some((w) => w.includes('Truncated 2 critical'))).toBe(true);
  });

  it('problems_only 모드는 info를 전부 잘라낸다 (상한 0)', () => {
    const issues = [
      fullIssue({ title: 'i-0', level: 'info', confidence: 0.9 }),
      fullIssue({ title: 'i-1', level: 'info', confidence: 0.5 }),
    ];
    const result = parseAnalysisResponse(mockResult([{ issues }]), 'problems_only');
    expect(result.issues.filter((i) => i.level === 'info')).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('Truncated 2 info'))).toBe(true);
  });

  it('problems_only 모드는 warning을 5건으로 제한한다', () => {
    const issues = Array.from({ length: 7 }, (_, i) =>
      fullIssue({ title: `w-${i}`, level: 'warning', confidence: i / 7 })
    );
    const result = parseAnalysisResponse(mockResult([{ issues }]), 'problems_only');
    expect(result.issues).toHaveLength(5);
    expect(result.warnings.some((w) => w.includes('Truncated 2 warning'))).toBe(true);
  });
});

describe('parseAnalysisResponse — file_signatures', () => {
  it('file_signatures가 없으면 결과에도 키가 없다 (기존 동작 보존)', () => {
    const result = parseAnalysisResponse(
      mockResult([{ issues: [fullIssue()] }])
    );
    expect(result.file_signatures).toBeUndefined();
    expect(result.issues).toHaveLength(1);
  });

  it('정상 file_signatures 항목을 파싱한다', () => {
    const result = parseAnalysisResponse(
      mockResult([
        {
          issues: [],
          file_signatures: [
            {
              file_path: 'src/auth/login.ts',
              functions: ['handleLogin', 'validateEmail'],
              imports: ['next/server', '@/lib/supabase'],
              exports: ['handleLogin'],
              patterns: ['supabase.auth.signInWithPassword'],
              line_count: 120,
            },
          ],
        },
      ])
    );

    expect(result.file_signatures).toHaveLength(1);
    expect(result.file_signatures![0]).toEqual({
      file_path: 'src/auth/login.ts',
      functions: ['handleLogin', 'validateEmail'],
      imports: ['next/server', '@/lib/supabase'],
      exports: ['handleLogin'],
      patterns: ['supabase.auth.signInWithPassword'],
      line_count: 120,
    });
  });

  it('file_path 누락 항목은 drop하고 warning을 추가한다', () => {
    const result = parseAnalysisResponse(
      mockResult([
        {
          issues: [],
          file_signatures: [
            { functions: ['foo'], line_count: 10 }, // file_path 없음
            { file_path: 'a.ts', functions: ['bar'], imports: [], exports: [], patterns: [], line_count: 5 },
          ],
        },
      ])
    );

    expect(result.file_signatures).toHaveLength(1);
    expect(result.file_signatures![0].file_path).toBe('a.ts');
    expect(result.warnings.some((w) => w.includes('file_signatures'))).toBe(true);
  });

  it('비-배열 필드는 빈 배열로 fallback (LLM이 형식 어긋나도 graceful)', () => {
    const result = parseAnalysisResponse(
      mockResult([
        {
          issues: [],
          file_signatures: [
            {
              file_path: 'a.ts',
              functions: 'not-an-array', // 잘못된 타입
              imports: ['ok'],
              exports: null,
              patterns: undefined,
              line_count: 'forty', // 잘못된 타입
            },
          ],
        },
      ])
    );

    expect(result.file_signatures![0]).toEqual({
      file_path: 'a.ts',
      functions: [],
      imports: ['ok'],
      exports: [],
      patterns: [],
      line_count: 0,
    });
  });

  it('issues 형식이 잘못되어도 file_signatures는 별도로 파싱된다', () => {
    const result = parseAnalysisResponse(
      mockResult([
        {
          issues: 'not-an-array',
          file_signatures: [
            { file_path: 'a.ts', functions: [], imports: [], exports: [], patterns: [], line_count: 0 },
          ],
        },
      ])
    );

    expect(result.issues).toHaveLength(0);
    expect(result.file_signatures).toHaveLength(1);
  });
});

describe('parseGuidelineResponse', () => {
  it('정상적인 규칙을 파싱한다', () => {
    const result = parseGuidelineResponse(
      mockResult([
        {
          title: 'API 키 하드코딩 금지',
          rule: 'API 키를 소스 파일에 절대 하드코딩하지 마라.',
        },
      ])
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('API 키 하드코딩 금지');
    expect(result!.rule).toContain('하드코딩');
  });

  it('도구 미호출 시 null을 반환한다', () => {
    expect(parseGuidelineResponse(mockResult([]))).toBeNull();
  });

  it('빈 문자열이면 null을 반환한다', () => {
    const result = parseGuidelineResponse(
      mockResult([{ title: '', rule: '' }])
    );
    expect(result).toBeNull();
  });
});
