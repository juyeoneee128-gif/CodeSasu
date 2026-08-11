import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase mock — SELECT 결과를 주입하고 INSERT/UPDATE 호출을 캡처
const selectResult = vi.fn();
const inserts: Record<string, unknown>[] = [];
const updates: { match: Record<string, string>; patch: Record<string, unknown> }[] = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => selectResult(),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        return Promise.resolve({ error: null });
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (col1: string, val1: string) => ({
          eq: (col2: string, val2: string) => {
            updates.push({
              match: { [col1]: val1, [col2]: val2 },
              patch,
            });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    }),
  }),
}));

import { upsertFileSignatures } from '../save-signatures';

beforeEach(() => {
  selectResult.mockReset();
  inserts.length = 0;
  updates.length = 0;
});

describe('upsertFileSignatures', () => {
  it('빈 배열은 즉시 종료한다', async () => {
    const result = await upsertFileSignatures('p1', []);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
    expect(selectResult).not.toHaveBeenCalled();
  });

  it('신규 파일은 INSERT 한다', async () => {
    selectResult.mockResolvedValue({ data: [], error: null });

    const result = await upsertFileSignatures('p1', [
      {
        file_path: 'src/auth/login.ts',
        functions: ['handleLogin', 'validateEmail'],
        imports: ['next/server', '@/lib/supabase'],
        exports: ['handleLogin'],
        patterns: ['supabase.auth.signInWithPassword'],
        line_count: 120,
      },
    ]);

    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      project_id: 'p1',
      file_path: 'src/auth/login.ts',
      functions: ['handleLogin', 'validateEmail'],
      line_count: 120,
    });
  });

  it('기존 row가 있으면 합집합으로 UPDATE 한다 (functions 누적)', async () => {
    selectResult.mockResolvedValue({
      data: [
        {
          file_path: 'src/auth/login.ts',
          functions: ['handleLogin'],
          imports: ['next/server'],
          exports: [],
          patterns: ['supabase.auth.signInWithPassword'],
          line_count: 100,
        },
      ],
      error: null,
    });

    const result = await upsertFileSignatures('p1', [
      {
        file_path: 'src/auth/login.ts',
        functions: ['validateEmail', 'logout'],
        imports: ['@/lib/supabase'],
        exports: ['handleLogin', 'logout'],
        patterns: ['supabase.auth.signOut'],
        line_count: 120,
      },
    ]);

    expect(result.updated).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.functions).toEqual([
      'handleLogin',
      'validateEmail',
      'logout',
    ]);
    expect(updates[0].patch.imports).toEqual(['next/server', '@/lib/supabase']);
    expect(updates[0].patch.exports).toEqual(['handleLogin', 'logout']);
    expect(updates[0].patch.patterns).toEqual([
      'supabase.auth.signInWithPassword',
      'supabase.auth.signOut',
    ]);
    // line_count는 max
    expect(updates[0].patch.line_count).toBe(120);
    // last_seen_at은 갱신
    expect(typeof updates[0].patch.last_seen_at).toBe('string');
  });

  it('line_count는 max 값으로 머지된다 (기존이 더 큰 경우 유지)', async () => {
    selectResult.mockResolvedValue({
      data: [
        {
          file_path: 'a.ts',
          functions: [],
          imports: [],
          exports: [],
          patterns: [],
          line_count: 200,
        },
      ],
      error: null,
    });

    await upsertFileSignatures('p1', [
      { file_path: 'a.ts', functions: [], imports: [], exports: [], patterns: [], line_count: 150 },
    ]);

    expect(updates[0].patch.line_count).toBe(200);
  });

  it('같은 push 안에 같은 file_path가 여러 번 들어오면 미리 머지된다', async () => {
    selectResult.mockResolvedValue({ data: [], error: null });

    await upsertFileSignatures('p1', [
      { file_path: 'a.ts', functions: ['f1'], imports: [], exports: [], patterns: [], line_count: 50 },
      { file_path: 'a.ts', functions: ['f2'], imports: [], exports: [], patterns: [], line_count: 80 },
    ]);

    // 같은 file_path → INSERT는 1회
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      file_path: 'a.ts',
      functions: ['f1', 'f2'],
      line_count: 80,
    });
  });

  it('빈 문자열·중복 함수명은 dedup된다', async () => {
    selectResult.mockResolvedValue({ data: [], error: null });

    await upsertFileSignatures('p1', [
      {
        file_path: 'a.ts',
        functions: ['handleLogin', '', '  ', 'handleLogin', 'logout'],
        imports: [],
        exports: [],
        patterns: [],
        line_count: 50,
      },
    ]);

    expect(inserts[0].functions).toEqual(['handleLogin', 'logout']);
  });

  it('SELECT 에러 시 warning 추가 후 다음 배치 진행', async () => {
    selectResult.mockResolvedValue({
      data: null,
      error: { message: 'connection refused' },
    });

    const result = await upsertFileSignatures('p1', [
      { file_path: 'a.ts', functions: [], imports: [], exports: [], patterns: [], line_count: 0 },
    ]);

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('connection refused');
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
  });
});
