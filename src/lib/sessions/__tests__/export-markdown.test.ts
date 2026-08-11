import { describe, it, expect } from 'vitest';
import {
  buildSessionMarkdown,
  slugifyTitle,
  type ParsedSummary,
  type SessionExportInput,
} from '../export-markdown';

// ─── 픽스처 헬퍼 ───

function makeInput(overrides: Partial<SessionExportInput> = {}): SessionExportInput {
  return {
    number: 12,
    title: '결제 모듈 리팩토링',
    created_at: '2026-05-07T00:00:00Z',
    duration_seconds: 1425, // 23분 45초
    prompt_count: 4,
    total_tokens: 12345,
    files_changed: 3,
    changed_files: ['src/api/checkout/route.ts', 'src/lib/stripe.ts'],
    prompts: [],
    parsed_summary: makeParsedSummary(),
    ...overrides,
  };
}

function makeParsedSummary(overrides: Partial<ParsedSummary> = {}): ParsedSummary {
  return {
    files_read: ['src/lib/stripe.ts'],
    tool_usage: { Write: 12, Bash: 8, Read: 15 },
    errors: [],
    prompts_meta: [
      { index: 0, content: '결제 모듈을 리팩토링해줘', timestamp: '2026-05-07T00:05:00Z' },
      { index: 1, content: 'Stripe webhook도 함께', timestamp: '2026-05-07T00:30:00Z' },
    ],
    ...overrides,
  };
}

// ─── buildSessionMarkdown ───

describe('buildSessionMarkdown — 기본 구조', () => {
  it('parsed_summary가 null이면 메타 표 + footer만 포함하고 다른 섹션은 미포함', () => {
    const md = buildSessionMarkdown(makeInput({ parsed_summary: null }));
    expect(md).toContain('# 세션 #12 — 결제 모듈 리팩토링');
    expect(md).toContain('| 날짜 |');
    expect(md).toContain('CodeSasu로 자동 생성됨');
    // 다른 섹션 헤더는 없어야 함
    expect(md).not.toContain('## 프롬프트 기록');
    expect(md).not.toContain('## 변경된 파일');
    expect(md).not.toContain('## 도구 사용 통계');
    expect(md).not.toContain('## 에러');
  });

  it('모든 필드가 채워지면 6 섹션을 모두 포함한다', () => {
    const md = buildSessionMarkdown(
      makeInput({
        parsed_summary: makeParsedSummary({
          errors: [{ tool_name: 'Bash', message: 'exit 1', timestamp: '2026-05-07T00:10:00Z' }],
        }),
      })
    );
    expect(md).toContain('# 세션 #12 — 결제 모듈 리팩토링');
    expect(md).toContain('## 프롬프트 기록');
    expect(md).toContain('## 변경된 파일');
    expect(md).toContain('## 읽은 파일');
    expect(md).toContain('## 도구 사용 통계');
    expect(md).toContain('## 에러 (1건)');
    expect(md).toContain('CodeSasu로 자동 생성됨');
  });

  it('footer는 한 줄로 끝난다', () => {
    const md = buildSessionMarkdown(makeInput());
    expect(md).toMatch(/CodeSasu로 자동 생성됨 · codesasu\.dev\n$/);
  });
});

describe('buildSessionMarkdown — 빈 섹션 생략', () => {
  it('files_read가 비면 "## 읽은 파일" 섹션 자체 생략', () => {
    const md = buildSessionMarkdown(
      makeInput({ parsed_summary: makeParsedSummary({ files_read: [] }) })
    );
    expect(md).not.toContain('## 읽은 파일');
  });

  it('tool_usage가 비면 "## 도구 사용 통계" 섹션 생략', () => {
    const md = buildSessionMarkdown(
      makeInput({ parsed_summary: makeParsedSummary({ tool_usage: {} }) })
    );
    expect(md).not.toContain('## 도구 사용 통계');
  });

  it('errors가 비면 "## 에러" 섹션 생략', () => {
    const md = buildSessionMarkdown(
      makeInput({ parsed_summary: makeParsedSummary({ errors: [] }) })
    );
    expect(md).not.toContain('## 에러');
  });

  it('changed_files가 비면 "## 변경된 파일" 섹션 생략', () => {
    const md = buildSessionMarkdown(makeInput({ changed_files: [] }));
    expect(md).not.toContain('## 변경된 파일');
  });

  it('prompts_meta와 prompts 둘 다 비면 "## 프롬프트 기록" 섹션 생략', () => {
    const md = buildSessionMarkdown(
      makeInput({
        prompts: [],
        parsed_summary: makeParsedSummary({ prompts_meta: [] }),
      })
    );
    expect(md).not.toContain('## 프롬프트 기록');
  });
});

describe('buildSessionMarkdown — 도구 사용 정렬', () => {
  it('도구 사용 통계는 횟수 내림차순으로 정렬된다', () => {
    const md = buildSessionMarkdown(
      makeInput({
        parsed_summary: makeParsedSummary({
          tool_usage: { Write: 12, Bash: 8, Read: 15 },
        }),
      })
    );
    const readIdx = md.indexOf('| Read | 15 |');
    const writeIdx = md.indexOf('| Write | 12 |');
    const bashIdx = md.indexOf('| Bash | 8 |');
    expect(readIdx).toBeGreaterThan(0);
    expect(readIdx).toBeLessThan(writeIdx);
    expect(writeIdx).toBeLessThan(bashIdx);
  });
});

describe('buildSessionMarkdown — 프롬프트 fallback', () => {
  it('prompts_meta 비고 prompts(string[])만 있으면 타임스탬프 없는 fallback', () => {
    const md = buildSessionMarkdown(
      makeInput({
        prompts: ['첫번째 요청', '두번째 요청'],
        parsed_summary: makeParsedSummary({ prompts_meta: [] }),
      })
    );
    expect(md).toContain('## 프롬프트 기록');
    expect(md).toContain('### 1.\n첫번째 요청');
    expect(md).toContain('### 2.\n두번째 요청');
    // fallback에는 시각 괄호가 없어야 함
    expect(md).not.toMatch(/### 1\. \(\d{2}:\d{2}\)/);
  });

  it('prompts_meta가 있으면 (HH:mm) 타임스탬프 포함', () => {
    const md = buildSessionMarkdown(makeInput());
    expect(md).toMatch(/### 1\. \(\d{2}:\d{2}\)/);
    expect(md).toContain('결제 모듈을 리팩토링해줘');
  });
});

describe('buildSessionMarkdown — 포맷 헬퍼', () => {
  it('total_tokens는 천 단위 콤마 포맷', () => {
    const md = buildSessionMarkdown(makeInput({ total_tokens: 1234567 }));
    expect(md).toContain('| 토큰 사용 | 1,234,567개 |');
  });

  it('duration_seconds < 60이면 "30초" 폴백', () => {
    const md = buildSessionMarkdown(makeInput({ duration_seconds: 30 }));
    expect(md).toContain('| 소요 시간 | 30초 |');
  });

  it('duration_seconds >= 60이면 기존 formatDuration 사용', () => {
    const md = buildSessionMarkdown(makeInput({ duration_seconds: 1425 }));
    expect(md).toContain('| 소요 시간 | 23분 45초 |');
  });

  it('UTC 자정은 KST 09:00으로 변환된다', () => {
    const md = buildSessionMarkdown(
      makeInput({ created_at: '2026-05-07T00:00:00Z' })
    );
    expect(md).toContain('| 날짜 | 2026-05-07 09:00 |');
  });

  it('잘못된 timestamp는 "(시간 미상)"으로 폴백', () => {
    const md = buildSessionMarkdown(
      makeInput({ created_at: 'not-a-date' })
    );
    expect(md).toContain('| 날짜 | (시간 미상) |');
  });
});

describe('buildSessionMarkdown — 에러 섹션', () => {
  it('에러 라인은 [도구명] 메시지 (HH:mm) 형식', () => {
    const md = buildSessionMarkdown(
      makeInput({
        parsed_summary: makeParsedSummary({
          errors: [
            { tool_name: 'Bash', message: 'exit 1', timestamp: '2026-05-07T01:30:00Z' },
            { tool_name: 'Edit', message: 'file not found', timestamp: '2026-05-07T02:15:00Z' },
          ],
        }),
      })
    );
    expect(md).toContain('## 에러 (2건)');
    expect(md).toContain('- [Bash] exit 1 (10:30)');
    expect(md).toContain('- [Edit] file not found (11:15)');
  });
});

// ─── slugifyTitle ───

describe('slugifyTitle', () => {
  it('한글·영문·숫자 + 공백→하이픈으로 변환한다', () => {
    expect(slugifyTitle('결제 모듈 리팩토링')).toBe('결제-모듈-리팩토링');
  });

  it('특수문자는 제거된다', () => {
    expect(slugifyTitle('feat: API!@# v2.0')).toBe('feat-API-v20');
  });

  it('연속 하이픈은 단일 하이픈으로 합쳐진다', () => {
    expect(slugifyTitle('--abc---def--')).toBe('abc-def');
  });

  it('30자 컷은 slug 전 title에 적용된다', () => {
    const longTitle = '가나다라마바사아자차카타파하12345AbCdEfGhIj' + 'ZZZZZZZZZZZZ';
    const out = slugifyTitle(longTitle);
    // 30자 슬라이스된 원본의 slug — 'ZZZZZZZZZZZZ' 부분은 포함되지 않아야 함
    expect(out).not.toContain('ZZZ');
    expect(out.length).toBeLessThanOrEqual(30);
  });

  it('빈 제목은 빈 문자열 반환', () => {
    expect(slugifyTitle('')).toBe('');
  });

  it('전부 특수문자면 빈 문자열 반환', () => {
    expect(slugifyTitle('!!!@@@###')).toBe('');
  });
});
