import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase mock — SELECT 결과를 주입하고 UPDATE 호출을 캡처
const selectResult = vi.fn();
const featureUpdates: { id: string; patch: Record<string, unknown> }[] = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => selectResult(),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          featureUpdates.push({ id, patch });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  }),
}));

import { dedupeFeaturesForProject, isSimilarFeature } from '../dedupe-features';

beforeEach(() => {
  selectResult.mockReset();
  featureUpdates.length = 0;
});

describe('isSimilarFeature — 키워드 50% 매칭', () => {
  it('100% 일치하는 부분집합은 동일 기능으로 판단', () => {
    expect(isSimilarFeature('사용자 인증', '사용자 인증 시스템')).toBe(true);
  });

  it('단어 0% 일치는 별개', () => {
    expect(isSimilarFeature('결제 기능', '이메일 알림')).toBe(false);
  });

  it('단어 50% 이상 겹치면 동일로 판단', () => {
    expect(isSimilarFeature('소셜 로그인 인증', '소셜 로그인')).toBe(true);
  });

  it('한 단어만 겹치고 짧으면 매칭 (min 기준 50%)', () => {
    // ["로그인","처리"] vs ["로그인"] → overlap 1, min=1 → 100%
    expect(isSimilarFeature('로그인 처리', '로그인')).toBe(true);
  });

  it('빈 문자열·1글자 키워드는 매칭 실패', () => {
    expect(isSimilarFeature('', '결제')).toBe(false);
    expect(isSimilarFeature('a b c', '')).toBe(false);
  });

  it('단어 경계가 유지된 특수문자(느낌표·물음표)는 키워드 추출에 영향 없다', () => {
    expect(isSimilarFeature('사용자 인증!', '사용자 인증')).toBe(true);
  });
});

describe('dedupeFeaturesForProject', () => {
  function feature(
    id: string,
    name: string,
    documentId: string,
    modifiedAt: string | null
  ) {
    return {
      id,
      name,
      document_id: documentId,
      is_duplicate: false,
      spec_documents: {
        modified_at: modifiedAt,
        uploaded_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
      },
    };
  }

  it('feature가 1개 이하면 marking 없이 종료', async () => {
    selectResult.mockResolvedValue({
      data: [feature('f1', '사용자 인증', 'd1', '2026-05-01T00:00:00Z')],
      error: null,
    });

    const result = await dedupeFeaturesForProject('p1');
    expect(result.checked).toBe(1);
    expect(result.marked).toBe(0);
    expect(featureUpdates).toHaveLength(0);
  });

  it('다른 문서 간 동일 기능 — 더 오래된 쪽이 마킹된다', async () => {
    selectResult.mockResolvedValue({
      data: [
        feature('f1', '사용자 인증', 'd-old', '2026-03-01T00:00:00Z'),
        feature('f2', '사용자 인증 시스템', 'd-new', '2026-05-01T00:00:00Z'),
      ],
      error: null,
    });

    const result = await dedupeFeaturesForProject('p1');
    expect(result.checked).toBe(2);
    expect(result.marked).toBe(1);
    expect(featureUpdates).toHaveLength(1);
    expect(featureUpdates[0]).toEqual({
      id: 'f1',
      patch: { is_duplicate: true },
    });
  });

  it('같은 문서 내 동일 기능은 매칭하지 않는다', async () => {
    selectResult.mockResolvedValue({
      data: [
        feature('f1', '사용자 인증', 'd1', '2026-05-01T00:00:00Z'),
        feature('f2', '사용자 인증 시스템', 'd1', '2026-05-01T00:00:00Z'),
      ],
      error: null,
    });

    const result = await dedupeFeaturesForProject('p1');
    expect(result.marked).toBe(0);
    expect(featureUpdates).toHaveLength(0);
  });

  it('완전히 다른 기능은 마킹하지 않는다', async () => {
    selectResult.mockResolvedValue({
      data: [
        feature('f1', '결제 기능', 'd1', '2026-03-01T00:00:00Z'),
        feature('f2', '이메일 알림', 'd2', '2026-05-01T00:00:00Z'),
      ],
      error: null,
    });

    const result = await dedupeFeaturesForProject('p1');
    expect(result.marked).toBe(0);
    expect(featureUpdates).toHaveLength(0);
  });

  it('3개 문서 + 동일 기능 → 가장 최근 1건만 살아남는다', async () => {
    selectResult.mockResolvedValue({
      data: [
        feature('f1', '사용자 인증', 'd-v1', '2026-01-01T00:00:00Z'),
        feature('f2', '사용자 인증', 'd-v2', '2026-03-01T00:00:00Z'),
        feature('f3', '사용자 인증', 'd-v3', '2026-05-01T00:00:00Z'),
      ],
      error: null,
    });

    const result = await dedupeFeaturesForProject('p1');
    expect(result.marked).toBe(2);
    const markedIds = featureUpdates.map((u) => u.id).sort();
    expect(markedIds).toEqual(['f1', 'f2']);
  });

  it('modified_at이 null이면 uploaded_at으로 fallback해서 비교한다', async () => {
    selectResult.mockResolvedValue({
      data: [
        // f1: modified_at=null, uploaded=2026-01
        {
          id: 'f1',
          name: '결제',
          document_id: 'd1',
          is_duplicate: false,
          spec_documents: {
            modified_at: null,
            uploaded_at: '2026-01-01T00:00:00Z',
            created_at: '2026-01-01T00:00:00Z',
          },
        },
        // f2: modified_at=null, uploaded=2026-05 → 더 최근
        {
          id: 'f2',
          name: '결제 처리',
          document_id: 'd2',
          is_duplicate: false,
          spec_documents: {
            modified_at: null,
            uploaded_at: '2026-05-01T00:00:00Z',
            created_at: '2026-05-01T00:00:00Z',
          },
        },
      ],
      error: null,
    });

    const result = await dedupeFeaturesForProject('p1');
    expect(result.marked).toBe(1);
    expect(featureUpdates[0].id).toBe('f1');
  });

  it('SELECT 에러 시 warnings 반환하고 마킹 안 함', async () => {
    selectResult.mockResolvedValue({
      data: null,
      error: { message: 'connection refused' },
    });

    const result = await dedupeFeaturesForProject('p1');
    expect(result.marked).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('connection refused');
  });
});
