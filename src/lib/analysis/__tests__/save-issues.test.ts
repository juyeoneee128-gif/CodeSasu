import { describe, it, expect, vi, beforeEach } from 'vitest';

// supabase 클라이언트를 mock — 실제 DB를 호출하지 않도록 차단
const existingFetch = vi.fn();
const updates: { id: string; patch: Record<string, unknown> }[] = [];
const inserts: Record<string, unknown>[] = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => existingFetch(),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          updates.push({ id, patch });
          return Promise.resolve({ error: null });
        },
      }),
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

import { saveDetectedIssues } from '../save-issues';
import type { DetectedIssue } from '../parse-response';

function makeIssue(overrides: Partial<DetectedIssue> = {}): DetectedIssue {
  return {
    title: '기본 이슈',
    level: 'warning',
    fact: 'fact',
    detail: 'detail',
    fix_command: 'fix',
    file: 'src/a.ts',
    basis: 'basis',
    confidence: 0.8,
    start_line: 1,
    end_line: 1,
    ...overrides,
  };
}

beforeEach(() => {
  existingFetch.mockReset();
  updates.length = 0;
  inserts.length = 0;
});

describe('saveDetectedIssues — auto_resolve', () => {
  it('full 모드 + analysisRan: 재감지 안 된 unconfirmed → auto_resolved', async () => {
    existingFetch.mockResolvedValue({
      data: [
        { id: 'i1', file: 'src/a.ts', title: 'API 키 노출 문제', status: 'unconfirmed' },
        { id: 'i2', file: 'src/b.ts', title: '에러 처리 누락', status: 'unconfirmed' },
      ],
      error: null,
    });

    // 새 분석에서 i1만 재감지됨 (i2는 사라짐)
    const newIssues = [makeIssue({ title: 'API 키 노출 문제', file: 'src/a.ts' })];

    const result = await saveDetectedIssues('p1', 's1', newIssues, {
      mode: 'full',
      analysisRan: true,
    });

    expect(result.redetected).toBe(1);
    expect(result.auto_resolved).toBe(1);
    expect(result.created).toBe(0);

    // i2가 auto_resolved로 업데이트
    const autoResolveCall = updates.find(
      (u) => u.id === 'i2' && u.patch.status === 'auto_resolved'
    );
    expect(autoResolveCall).toBeDefined();
  });

  it('problems_only + 이슈 파일이 diff에 포함 + 재감지 안 됨 → auto_resolved', async () => {
    existingFetch.mockResolvedValue({
      data: [
        { id: 'i1', file: 'src/a.ts', title: 'API 키 노출', status: 'unconfirmed' },
        { id: 'i2', file: 'src/b.ts', title: '에러 처리 누락', status: 'unconfirmed' },
      ],
      error: null,
    });

    // i1만 재감지, i2는 사라짐. 하지만 i2 파일(src/b.ts)도 diff에 포함됨 → 분석됐는데 재감지 안 됨
    const newIssues = [makeIssue({ title: 'API 키 노출', file: 'src/a.ts' })];

    const result = await saveDetectedIssues('p1', 's1', newIssues, {
      mode: 'problems_only',
      analysisRan: true,
      diffFiles: ['src/a.ts', 'src/b.ts'],
    });

    expect(result.redetected).toBe(1);
    expect(result.auto_resolved).toBe(1);

    // i2가 auto_resolved로 전환
    const autoResolveCall = updates.find(
      (u) => u.id === 'i2' && u.patch.status === 'auto_resolved'
    );
    expect(autoResolveCall).toBeDefined();
  });

  it('problems_only + 이슈 파일이 diff에 미포함 → 상태 변경 없음', async () => {
    existingFetch.mockResolvedValue({
      data: [
        { id: 'i1', file: 'src/a.ts', title: 'API 키 노출', status: 'unconfirmed' },
        { id: 'i2', file: 'src/b.ts', title: '에러 처리 누락', status: 'unconfirmed' },
      ],
      error: null,
    });

    // i1 파일만 diff에 포함, 재감지됨. i2는 diff에 없음 → 분석되지 않았으므로 건드리지 않음
    const newIssues = [makeIssue({ title: 'API 키 노출', file: 'src/a.ts' })];

    const result = await saveDetectedIssues('p1', 's1', newIssues, {
      mode: 'problems_only',
      analysisRan: true,
      diffFiles: ['src/a.ts'],
    });

    expect(result.redetected).toBe(1);
    expect(result.auto_resolved).toBe(0);

    // i2는 diff에 없으니 어떤 업데이트도 가지 않아야 함
    const i2Update = updates.find((u) => u.id === 'i2');
    expect(i2Update).toBeUndefined();
  });

  it('analysisRan=false: auto_resolve 미실행 (분석 자체가 스킵된 push)', async () => {
    existingFetch.mockResolvedValue({
      data: [{ id: 'i1', file: 'src/a.ts', title: 'API 키 노출', status: 'unconfirmed' }],
      error: null,
    });

    const result = await saveDetectedIssues('p1', 's1', [], {
      mode: 'full',
      analysisRan: false,
    });

    expect(result.auto_resolved).toBe(0);
    expect(updates.length).toBe(0);
  });

  it('auto_resolved 이슈가 다시 감지되면 unconfirmed + is_redetected=true 복원', async () => {
    existingFetch.mockResolvedValue({
      data: [{ id: 'i1', file: 'src/a.ts', title: 'API 키 노출', status: 'auto_resolved' }],
      error: null,
    });

    const newIssues = [makeIssue({ title: 'API 키 노출', file: 'src/a.ts' })];

    const result = await saveDetectedIssues('p1', 's1', newIssues, {
      mode: 'full',
      analysisRan: true,
    });

    expect(result.redetected).toBe(1);

    // i1이 unconfirmed + is_redetected=true로 업데이트됨
    const restoreCall = updates.find((u) => u.id === 'i1');
    expect(restoreCall).toBeDefined();
    expect(restoreCall!.patch.status).toBe('unconfirmed');
    expect(restoreCall!.patch.is_redetected).toBe(true);
  });

  it('confirmed 이슈가 다시 감지되면 unconfirmed + is_redetected=true 복원', async () => {
    existingFetch.mockResolvedValue({
      data: [{ id: 'i1', file: 'src/a.ts', title: 'API 키 노출', status: 'confirmed' }],
      error: null,
    });

    const newIssues = [makeIssue({ title: 'API 키 노출', file: 'src/a.ts' })];

    const result = await saveDetectedIssues('p1', 's1', newIssues, {
      mode: 'full',
      analysisRan: true,
    });

    expect(result.redetected).toBe(1);

    const restoreCall = updates.find((u) => u.id === 'i1');
    expect(restoreCall).toBeDefined();
    expect(restoreCall!.patch.status).toBe('unconfirmed');
    expect(restoreCall!.patch.is_redetected).toBe(true);
    expect(restoreCall!.patch.confirmed_at).toBeNull();
  });

  it('confirmed 이슈는 auto_resolve 대상이 아님', async () => {
    existingFetch.mockResolvedValue({
      data: [
        { id: 'i_conf', file: 'src/a.ts', title: '확인된 이슈', status: 'confirmed' },
        { id: 'i_unc', file: 'src/b.ts', title: '미확인 이슈', status: 'unconfirmed' },
      ],
      error: null,
    });

    // 새 분석에서 둘 다 재감지 안 됨
    const result = await saveDetectedIssues('p1', 's1', [], {
      mode: 'full',
      analysisRan: true,
    });

    expect(result.auto_resolved).toBe(1); // unconfirmed만 전환

    // confirmed 이슈는 건드리지 않음
    const confirmedUpdate = updates.find((u) => u.id === 'i_conf');
    expect(confirmedUpdate).toBeUndefined();

    // unconfirmed 이슈만 auto_resolved로 전환
    const uncResolved = updates.find((u) => u.id === 'i_unc');
    expect(uncResolved).toBeDefined();
    expect(uncResolved!.patch.status).toBe('auto_resolved');
  });

  it('이슈 0개 + analysisRan=true: 모든 unconfirmed 이슈 auto_resolved', async () => {
    existingFetch.mockResolvedValue({
      data: [
        { id: 'i1', file: 'src/a.ts', title: 'A', status: 'unconfirmed' },
        { id: 'i2', file: 'src/b.ts', title: 'B', status: 'unconfirmed' },
        { id: 'i3', file: 'src/c.ts', title: 'C', status: 'unconfirmed' },
      ],
      error: null,
    });

    const result = await saveDetectedIssues('p1', 's1', [], {
      mode: 'full',
      analysisRan: true,
    });

    expect(result.created).toBe(0);
    expect(result.redetected).toBe(0);
    expect(result.auto_resolved).toBe(3);
  });
});
