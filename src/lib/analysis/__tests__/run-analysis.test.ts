import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── 다운스트림 의존성 mock ───
// runAnalysis는 분석 파이프라인의 오케스트레이터다. 본 테스트의 관심은
// sourceFilesAsDiff 옵션을 켰을 때 source_files가 분석 대상 diff로 변환되어
// analyzeStatic에 전달되는지(그리고 세션 비교는 스킵되는지)뿐이므로,
// 그 외 호출은 모두 mock으로 대체한다.

vi.mock('../../agent/ephemeral', () => ({
  getEphemeral: vi.fn(),
  deleteEphemeral: vi.fn().mockResolvedValue(0),
  getEphemeralSourceFiles: vi.fn(),
}));

vi.mock('../static-analyzer', () => ({
  analyzeStatic: vi.fn(),
}));

vi.mock('../session-comparator', () => ({
  analyzeSessionDiff: vi.fn(),
}));

vi.mock('../save-issues', () => ({
  saveDetectedIssues: vi.fn(),
}));

vi.mock('../../specs/save-signatures', () => ({
  upsertFileSignatures: vi.fn().mockResolvedValue({ warnings: [] }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: { name: 'p', title: 't', changed_files: [] },
              error: null,
            }),
        }),
      }),
    }),
  }),
}));

import { runAnalysis } from '../run-analysis';
import {
  getEphemeral,
  getEphemeralSourceFiles,
  deleteEphemeral,
} from '../../agent/ephemeral';
import { analyzeStatic } from '../static-analyzer';
import { analyzeSessionDiff } from '../session-comparator';
import { saveDetectedIssues } from '../save-issues';

const mockedGetEphemeral = getEphemeral as ReturnType<typeof vi.fn>;
const mockedGetSourceFiles = getEphemeralSourceFiles as ReturnType<typeof vi.fn>;
const mockedDeleteEphemeral = deleteEphemeral as ReturnType<typeof vi.fn>;
const mockedAnalyzeStatic = analyzeStatic as ReturnType<typeof vi.fn>;
const mockedAnalyzeSessionDiff = analyzeSessionDiff as ReturnType<typeof vi.fn>;
const mockedSaveDetectedIssues = saveDetectedIssues as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedGetEphemeral.mockReset();
  mockedGetSourceFiles.mockReset();
  mockedDeleteEphemeral.mockReset();
  mockedAnalyzeStatic.mockReset();
  mockedAnalyzeSessionDiff.mockReset();
  mockedSaveDetectedIssues.mockReset();

  // 기본값: ephemeral 비어있음 (diff 없음)
  mockedGetEphemeral.mockResolvedValue([]);
  mockedDeleteEphemeral.mockResolvedValue(0);
  // 기본값: 정적 분석 빈 결과
  mockedAnalyzeStatic.mockResolvedValue({
    issues: [],
    tokenUsage: { input: 0, output: 0 },
    warnings: [],
  });
  mockedAnalyzeSessionDiff.mockResolvedValue({
    issues: [],
    tokenUsage: { input: 0, output: 0 },
    warnings: [],
  });
  mockedSaveDetectedIssues.mockResolvedValue({
    created: 0,
    redetected: 0,
    auto_resolved: 0,
    warnings: [],
  });
});

describe('runAnalysis — sourceFilesAsDiff (부팅 스캔)', () => {
  it('source_files가 신규 파일 diff로 변환되어 analyzeStatic에 전달되고, 세션 비교는 스킵된다', async () => {
    // diff 없음(부팅 스캔) + source_files 2건
    mockedGetEphemeral.mockResolvedValue([]);
    mockedGetSourceFiles.mockResolvedValue([
      { path: 'src/a.ts', content: 'export const a = 1;\nexport const b = 2;', line_count: 2 },
      { path: 'src/b.ts', content: 'export const c = 3;', line_count: 1 },
    ]);

    await runAnalysis('proj-1', 'sess-1', 'full', { sourceFilesAsDiff: true });

    // analyzeStatic이 호출됐고, diffs에 2개 파일이 가짜 diff로 들어갔는지 확인
    expect(mockedAnalyzeStatic).toHaveBeenCalledTimes(1);
    const firstCall = mockedAnalyzeStatic.mock.calls[0];
    const input = firstCall[0] as { diffs: { file_path: string; diff_content: string }[]; contextSources?: unknown };
    expect(input.diffs).toHaveLength(2);
    expect(input.diffs[0].file_path).toBe('src/a.ts');
    // unified diff 형식: hunk 헤더 + 각 라인 앞 '+'
    expect(input.diffs[0].diff_content).toMatch(/^@@ -0,0 \+1,2 @@\n\+export const a = 1;\n\+export const b = 2;$/);
    // contextSources는 첨부되지 않음 (diff 자체가 전체 코드이므로 중복 방지)
    expect(input.contextSources).toBeUndefined();

    // 세션 비교는 호출되지 않음
    expect(mockedAnalyzeSessionDiff).not.toHaveBeenCalled();

    // ephemeral 삭제는 호출됨
    expect(mockedDeleteEphemeral).toHaveBeenCalledWith('sess-1');
  });

  it('source_files가 비어있으면 warning만 남기고 graceful 종료 (analyzeStatic 미호출)', async () => {
    mockedGetEphemeral.mockResolvedValue([]);
    mockedGetSourceFiles.mockResolvedValue([]);

    const result = await runAnalysis('proj-1', 'sess-1', 'full', {
      sourceFilesAsDiff: true,
    });

    // diff/eslint 둘 다 없으면 analyzeStatic을 호출하지 않고 warning만 추가
    expect(mockedAnalyzeStatic).not.toHaveBeenCalled();
    expect(result.warnings).toContain('No diffs available for static analysis');
    expect(result.total_issues_found).toBe(0);
  });

  it('getEphemeralSourceFiles가 실패해도 함수는 throw 없이 warning을 캡처하여 반환한다', async () => {
    mockedGetEphemeral.mockResolvedValue([]);
    mockedGetSourceFiles.mockRejectedValue(new Error('DB connection refused'));

    const result = await runAnalysis('proj-1', 'sess-1', 'full', {
      sourceFilesAsDiff: true,
    });

    expect(result.warnings.some((w) => w.includes('Failed to load source files as diff'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('DB connection refused'))).toBe(true);
    // 후속 분석은 진행되지 않음 (diff 0건이므로)
    expect(mockedAnalyzeStatic).not.toHaveBeenCalled();
  });
});
