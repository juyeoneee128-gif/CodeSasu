import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase mock — UPDATE/INSERT 호출을 캡처
const documentUpdates: { id: string; patch: Record<string, unknown> }[] = [];
const featureInserts: Record<string, unknown>[] = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          if (table === 'spec_documents') {
            documentUpdates.push({ id, patch });
          }
          return Promise.resolve({ error: null });
        },
      }),
      insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        if (table === 'spec_features') {
          if (Array.isArray(rows)) featureInserts.push(...rows);
          else featureInserts.push(rows);
        }
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

// Claude API mock
const callClaudeMock = vi.fn();
vi.mock('../../analysis/claude-client', () => ({
  callClaude: (...args: unknown[]) => callClaudeMock(...args),
}));

import { extractFeaturesForDocument } from '../extract-features';

beforeEach(() => {
  documentUpdates.length = 0;
  featureInserts.length = 0;
  callClaudeMock.mockReset();
});

describe('extractFeaturesForDocument — document_type 분류', () => {
  it('document_type="other"이면 features를 빈 배열로 반환하고 spec_features INSERT를 건너뛴다', async () => {
    callClaudeMock.mockResolvedValue({
      toolInputs: [{ document_type: 'other', features: [] }],
      tokenUsage: { input: 100, output: 20 },
    });

    const result = await extractFeaturesForDocument(
      'p1',
      'doc-1',
      'PRD',
      '## 컴포넌트 목록\n- Button\n- Card\n- Modal'
    );

    expect(result.document_type).toBe('other');
    expect(result.features_count).toBe(0);
    expect(result.features).toEqual([]);
    expect(result.error).toBeNull();
    // spec_features INSERT 미호출
    expect(featureInserts).toHaveLength(0);
    // spec_documents.classification UPDATE 호출됨
    const classifyUpdate = documentUpdates.find(
      (u) => u.id === 'doc-1' && u.patch.classification === 'other'
    );
    expect(classifyUpdate).toBeDefined();
  });

  it('document_type="other"인데 LLM이 features를 반환해도 강제로 비운다', async () => {
    // LLM이 명령을 어기고 other인데도 features를 채운 케이스
    callClaudeMock.mockResolvedValue({
      toolInputs: [
        {
          document_type: 'other',
          features: [
            { name: 'Button 컴포넌트', total_items: 1, prd_summary: '버튼 UI' },
          ],
        },
      ],
      tokenUsage: { input: 100, output: 20 },
    });

    const result = await extractFeaturesForDocument('p1', 'doc-2', 'PRD', '...');

    expect(result.document_type).toBe('other');
    expect(result.features_count).toBe(0);
    expect(featureInserts).toHaveLength(0);
  });

  it('document_type="prd"이면 features를 정상 INSERT한다', async () => {
    callClaudeMock.mockResolvedValue({
      toolInputs: [
        {
          document_type: 'prd',
          features: [
            { name: '사용자 인증', total_items: 3, prd_summary: '이메일/소셜 로그인' },
            { name: '결제 처리', total_items: 5, prd_summary: '카드/계좌이체' },
          ],
        },
      ],
      tokenUsage: { input: 200, output: 80 },
    });

    const result = await extractFeaturesForDocument('p1', 'doc-3', 'PRD', '...');

    expect(result.document_type).toBe('prd');
    expect(result.features_count).toBe(2);
    expect(featureInserts).toHaveLength(2);
    expect(featureInserts[0]).toMatchObject({
      project_id: 'p1',
      document_id: 'doc-3',
      name: '사용자 인증',
      source: 'PRD',
      status: 'unimplemented',
    });
    // classification UPDATE
    const classifyUpdate = documentUpdates.find(
      (u) => u.id === 'doc-3' && u.patch.classification === 'prd'
    );
    expect(classifyUpdate).toBeDefined();
  });

  it('document_type="spec"도 classification으로 정상 저장된다', async () => {
    callClaudeMock.mockResolvedValue({
      toolInputs: [
        {
          document_type: 'spec',
          features: [
            { name: 'API 라우팅', total_items: 4, prd_summary: 'REST 엔드포인트 설계' },
          ],
        },
      ],
      tokenUsage: { input: 150, output: 50 },
    });

    const result = await extractFeaturesForDocument('p1', 'doc-4', 'PRD', '...');

    expect(result.document_type).toBe('spec');
    expect(result.features_count).toBe(1);
    const classifyUpdate = documentUpdates.find(
      (u) => u.id === 'doc-4' && u.patch.classification === 'spec'
    );
    expect(classifyUpdate).toBeDefined();
  });

  it('expected_items를 저장하고 total_items를 expected_items.length로 자동 산출한다 (정상)', async () => {
    callClaudeMock.mockResolvedValue({
      toolInputs: [
        {
          document_type: 'prd',
          features: [
            {
              name: '사용자 인증',
              total_items: 99,  // LLM이 잘못 카운트해도 expected_items.length로 덮어쓰여야 함
              prd_summary: '이메일/소셜 로그인',
              expected_items: ['이메일 로그인', '소셜 로그인 (Google)', '세션 관리'],
            },
          ],
        },
      ],
      tokenUsage: { input: 100, output: 30 },
    });

    const result = await extractFeaturesForDocument('p1', 'doc-exp-1', 'PRD', '...');

    expect(result.features_count).toBe(1);
    expect(result.features[0]).toMatchObject({
      name: '사용자 인증',
      total_items: 3,  // ← expected_items.length, LLM의 99 무시
      expected_items: ['이메일 로그인', '소셜 로그인 (Google)', '세션 관리'],
    });
    expect(featureInserts).toHaveLength(1);
    expect(featureInserts[0]).toMatchObject({
      total_items: 3,
      expected_items: ['이메일 로그인', '소셜 로그인 (Google)', '세션 관리'],
    });
  });

  it('expected_items가 누락되면 빈 배열로 저장 + LLM total_items를 그대로 사용 (legacy 호환 — 엣지)', async () => {
    callClaudeMock.mockResolvedValue({
      toolInputs: [
        {
          document_type: 'prd',
          features: [
            { name: '결제', total_items: 5, prd_summary: '...' },  // expected_items 누락
          ],
        },
      ],
      tokenUsage: { input: 100, output: 30 },
    });

    const result = await extractFeaturesForDocument('p1', 'doc-exp-2', 'PRD', '...');

    expect(result.features[0]).toMatchObject({
      name: '결제',
      total_items: 5,           // LLM 값 보존 (fallback)
      expected_items: [],
    });
    expect(featureInserts[0]).toMatchObject({
      total_items: 5,
      expected_items: [],
    });
  });

  it('expected_items에 문자열 아닌 항목이 섞이면 필터링한다 (방어 — 에러)', async () => {
    callClaudeMock.mockResolvedValue({
      toolInputs: [
        {
          document_type: 'prd',
          features: [
            {
              name: '알림',
              total_items: 2,
              prd_summary: '...',
              expected_items: ['정상 항목', 42, null, '두 번째 정상 항목'],
            },
          ],
        },
      ],
      tokenUsage: { input: 100, output: 30 },
    });

    const result = await extractFeaturesForDocument('p1', 'doc-exp-3', 'PRD', '...');
    expect(result.features[0].expected_items).toEqual(['정상 항목', '두 번째 정상 항목']);
    expect(result.features[0].total_items).toBe(2);
  });

  it('document_type이 enum 외 값이면 null로 fallback하고 classification UPDATE를 건너뛴다', async () => {
    callClaudeMock.mockResolvedValue({
      toolInputs: [
        {
          document_type: 'unknown-foo',
          features: [{ name: '기능 A', total_items: 1, prd_summary: '...' }],
        },
      ],
      tokenUsage: { input: 100, output: 30 },
    });

    const result = await extractFeaturesForDocument('p1', 'doc-5', 'PRD', '...');

    expect(result.document_type).toBeNull();
    // classification UPDATE 미호출 (null이므로)
    const classifyUpdate = documentUpdates.find((u) => u.id === 'doc-5');
    expect(classifyUpdate).toBeUndefined();
    // features는 정상 INSERT (분류 실패해도 추출은 살림)
    expect(featureInserts).toHaveLength(1);
  });
});
