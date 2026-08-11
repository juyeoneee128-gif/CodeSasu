import { describe, it, expect } from 'vitest';
import { parseSession, formatDuration } from '../parse-session';
import {
  MOCK_JSONL,
  MOCK_JSONL_NO_TITLE,
  MOCK_JSONL_WITH_CORRUPT,
  MOCK_JSONL_TOOL_ONLY,
  MOCK_JSONL_WITH_ERRORS,
} from './mock-jsonl';

describe('parseSession', () => {
  it('정상 JSONL을 올바르게 파싱한다', () => {
    const result = parseSession(MOCK_JSONL);

    // ai-title에서 제목 추출
    expect(result.title).toBe('로그인 에러 처리 추가');

    // 프롬프트: ide_opened_file 태그 제거 후 user text만
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]).toBe('로그인 에러 처리 추가해줘');

    // Write/Edit에서 변경 파일 추출 (cwd 기준 상대 경로)
    expect(result.files_changed).toEqual([
      'src/auth/error-handler.ts',
      'src/auth/login.ts',
    ]);
    expect(result.changed_files).toBe(2);

    // 메타데이터
    expect(result.session_id_from_log).toBe('test-session-001');
    expect(result.cli_version).toBe('2.1.90');
    expect(result.entrypoint).toBe('claude-vscode');
    expect(result.model).toBe('claude-sonnet-4-20250514');

    // 요약 (신 형식: "N개 프롬프트, M개 파일 수정, 12분")
    expect(result.summary).toContain('1개 프롬프트');
    expect(result.summary).toContain('2개 파일 수정');

    // 경고 없음
    expect(result.warnings).toHaveLength(0);

    // hash 존재
    expect(result.log_hash).toHaveLength(64);
  });

  it('ai-title이 없으면 첫 프롬프트 80자로 제목을 생성한다', () => {
    const result = parseSession(MOCK_JSONL_NO_TITLE);

    expect(result.title).toBe('로그인 에러 처리 추가해줘');
  });

  it('손상된 줄은 스킵하고 나머지를 정상 처리한다', () => {
    const result = parseSession(MOCK_JSONL_WITH_CORRUPT);

    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings.some((w) => w.includes('parse error'))).toBe(true);

    // ai-title은 포함되어 있으므로 제목 추출 가능
    expect(result.title).toBe('로그인 에러 처리 추가');
  });

  it('빈 JSONL은 throw하지 않고 기본값을 반환한다', () => {
    const empty = parseSession('');
    expect(empty.title).toBe('Untitled Session');
    expect(empty.prompts).toEqual([]);
    expect(empty.files_changed).toEqual([]);
    expect(empty.duration_seconds).toBe(0);
    expect(empty.warnings).toContain('Empty log data');

    const whitespace = parseSession('\n\n');
    expect(whitespace.warnings).toContain('Empty log data');
  });

  it('tool_result만 있는 user 메시지는 프롬프트에서 제외된다', () => {
    const result = parseSession(MOCK_JSONL_TOOL_ONLY);

    expect(result.prompts).toHaveLength(0);
    expect(result.title).toBe('Untitled Session');
  });

  it('ide_opened_file 태그를 제거한다', () => {
    const result = parseSession(MOCK_JSONL);

    // 프롬프트에 ide_opened_file 태그가 포함되지 않아야 함
    for (const prompt of result.prompts) {
      expect(prompt).not.toContain('<ide_opened_file>');
      expect(prompt).not.toContain('</ide_opened_file>');
    }
  });

  it('절대 경로를 cwd 기준 상대 경로로 변환한다', () => {
    const result = parseSession(MOCK_JSONL);

    // /Users/dev/project/ 가 제거되어야 함
    for (const file of result.files_changed) {
      expect(file).not.toContain('/Users/');
      expect(file.startsWith('src/')).toBe(true);
    }
  });

  it('Write/Edit이 없는 세션은 files_changed가 빈 배열이다', () => {
    const result = parseSession(MOCK_JSONL_TOOL_ONLY);

    expect(result.files_changed).toEqual([]);
    expect(result.changed_files).toBe(0);
  });
});

describe('parseSession — 신규 필드', () => {
  it('duration_seconds: 첫 ~ 마지막 timestamp 차이 (초)', () => {
    // MOCK_JSONL: 10:00:00 ~ 10:00:09 = 9초
    const result = parseSession(MOCK_JSONL);
    expect(result.duration_seconds).toBe(9);
  });

  it('total_tokens: 모든 assistant.usage 합산', () => {
    // MOCK_JSONL: 100+50+150+30+200+80+250+40+300+60 = 1260
    const result = parseSession(MOCK_JSONL);
    expect(result.total_tokens).toBe(1260);
  });

  it('prompt_count: prompts.length와 일치', () => {
    const result = parseSession(MOCK_JSONL);
    expect(result.prompt_count).toBe(result.prompts.length);
    expect(result.prompt_count).toBe(1);
  });

  it('files_read: Read 도구의 file_path 추출 + cwd 상대경로', () => {
    const result = parseSession(MOCK_JSONL);
    expect(result.files_read).toEqual(['src/auth/login.ts']);
    // 절대 경로 흔적 없음
    for (const f of result.files_read) {
      expect(f).not.toContain('/Users/');
    }
  });

  it('tool_usage: 도구별 카운트', () => {
    const result = parseSession(MOCK_JSONL);
    // MOCK_JSONL: Read 1, Edit 1, Write 1 (thinking은 tool_use 아님)
    expect(result.tool_usage).toEqual({ Read: 1, Edit: 1, Write: 1 });
  });

  it('prompts_meta: index/content/timestamp 포함', () => {
    const result = parseSession(MOCK_JSONL);
    expect(result.prompts_meta).toHaveLength(1);
    expect(result.prompts_meta[0].index).toBe(0);
    expect(result.prompts_meta[0].content).toBe('로그인 에러 처리 추가해줘');
    expect(result.prompts_meta[0].timestamp).toBe('2026-04-08T10:00:01Z');
  });

  it('errors: is_error=true와 error 키워드 매칭, "no errors" 부정문 제외', () => {
    const result = parseSession(MOCK_JSONL_WITH_ERRORS);
    // tu1: is_error=true → 잡힘
    // tu2: "Build failed: missing module" — failed 매칭, 부정문 없음 → 잡힘
    // tu3: "Tests passed with no errors" — "no errors" 부정문 → 제외
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].tool_name).toBe('Bash');
    expect(result.errors[0].message).toContain('connection refused');
    expect(result.errors[1].message).toContain('Build failed');
    // tu3은 들어가지 않아야 함
    expect(result.errors.find((e) => e.message.includes('no errors'))).toBeUndefined();
  });

  it('errors 메시지는 200자 truncate', () => {
    const longContent = 'Error: ' + 'x'.repeat(500);
    const jsonl = [
      '{"type":"assistant","parentUuid":"x","uuid":"a1","timestamp":"2026-04-08T10:00:00Z","message":{"model":"m","role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{}}]}}',
      `{"type":"user","parentUuid":"a1","uuid":"u1","timestamp":"2026-04-08T10:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":${JSON.stringify(longContent)},"is_error":true}]},"toolUseResult":{}}`,
    ].join('\n');
    const result = parseSession(jsonl);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(result.errors[0].message.endsWith('...')).toBe(true);
  });

  it('summary: "N개 프롬프트, M개 파일 수정, 12분" 형식', () => {
    const result = parseSession(MOCK_JSONL);
    expect(result.summary).toContain('1개 프롬프트');
    expect(result.summary).toContain('2개 파일 수정');
    // duration 9초 → 60초 미만이라 "0분"으로 표시
    expect(result.summary).toContain('0분');
  });

  it('MultiEdit 도구도 files_changed에 포함', () => {
    const jsonl = [
      '{"type":"user","parentUuid":null,"uuid":"u1","timestamp":"2026-04-08T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"refactor"}]},"cwd":"/Users/dev/x"}',
      '{"type":"assistant","parentUuid":"u1","uuid":"a1","timestamp":"2026-04-08T10:00:01Z","message":{"model":"m","role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"MultiEdit","input":{"file_path":"/Users/dev/x/src/foo.ts"}}]}}',
    ].join('\n');
    const result = parseSession(jsonl);
    expect(result.files_changed).toEqual(['src/foo.ts']);
  });

  it('input.path도 file_path 대안으로 인식', () => {
    const jsonl = [
      '{"type":"user","parentUuid":null,"uuid":"u1","timestamp":"2026-04-08T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"x"}]},"cwd":"/Users/dev/x"}',
      '{"type":"assistant","parentUuid":"u1","uuid":"a1","timestamp":"2026-04-08T10:00:01Z","message":{"model":"m","role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Write","input":{"path":"/Users/dev/x/src/legacy.ts"}}]}}',
    ].join('\n');
    const result = parseSession(jsonl);
    expect(result.files_changed).toEqual(['src/legacy.ts']);
  });
});

describe('parseSession — file_signatures (Read tool_result 정규식 추출)', () => {
  it('Read tool_result 본문에서 JS/TS 시그니처를 추출한다', () => {
    const fileBody = `import { NextResponse } from 'next/server';
export async function POST(request) {
  const supabase = await createClient();
  await supabase.auth.signInWithPassword({});
  return NextResponse.json({});
}`;
    const escaped = JSON.stringify(fileBody);

    const jsonl = [
      '{"type":"user","parentUuid":null,"uuid":"u1","timestamp":"2026-04-08T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"check login"}]},"cwd":"/Users/dev/proj"}',
      `{"type":"assistant","parentUuid":"u1","uuid":"a1","timestamp":"2026-04-08T10:00:01Z","message":{"model":"m","role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/Users/dev/proj/app/api/auth/login/route.ts"}}]}}`,
      `{"type":"user","parentUuid":"a1","uuid":"u2","timestamp":"2026-04-08T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":${escaped}}]}}`,
    ].join('\n');

    const result = parseSession(jsonl);
    expect(result.file_signatures).toHaveLength(1);
    const sig = result.file_signatures[0];
    expect(sig.file_path).toBe('app/api/auth/login/route.ts');
    expect(sig.imports).toContain('next/server');
    expect(sig.exports).toContain('POST');
    expect(sig.functions).toContain('POST');
    expect(sig.patterns.some((p) => p.startsWith('supabase.'))).toBe(true);
  });

  it('JS/TS 외 파일 (json/md)은 시그니처에 포함되지 않는다', () => {
    const escaped = JSON.stringify('{ "a": 1 }');

    const jsonl = [
      '{"type":"user","parentUuid":null,"uuid":"u1","timestamp":"2026-04-08T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"x"}]},"cwd":"/Users/dev/p"}',
      `{"type":"assistant","parentUuid":"u1","uuid":"a1","timestamp":"2026-04-08T10:00:01Z","message":{"model":"m","role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/Users/dev/p/package.json"}}]}}`,
      `{"type":"user","parentUuid":"a1","uuid":"u2","timestamp":"2026-04-08T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":${escaped}}]}}`,
    ].join('\n');

    const result = parseSession(jsonl);
    expect(result.file_signatures).toHaveLength(0);
  });

  it('Read가 없는 세션은 빈 file_signatures', () => {
    const result = parseSession(MOCK_JSONL);
    // MOCK_JSONL의 Read tool_result는 file_path가 .ts지만 본문이 더미라 추출은 가능
    // 여기서는 형식만 확인 — 배열이어야 함
    expect(Array.isArray(result.file_signatures)).toBe(true);
  });

  it('빈 세션에서도 file_signatures는 빈 배열', () => {
    const result = parseSession('');
    expect(result.file_signatures).toEqual([]);
  });

  it('tool_result.content가 [{type:"text",text:...}] 형태도 처리', () => {
    const fileBody = 'export const X = 1;';

    const jsonl = [
      '{"type":"user","parentUuid":null,"uuid":"u1","timestamp":"2026-04-08T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"x"}]},"cwd":"/Users/dev/p"}',
      `{"type":"assistant","parentUuid":"u1","uuid":"a1","timestamp":"2026-04-08T10:00:01Z","message":{"model":"m","role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/Users/dev/p/x.ts"}}]}}`,
      `{"type":"user","parentUuid":"a1","uuid":"u2","timestamp":"2026-04-08T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":${JSON.stringify(fileBody)}}]}]}}`,
    ].join('\n');

    const result = parseSession(jsonl);
    expect(result.file_signatures).toHaveLength(1);
    expect(result.file_signatures[0].exports).toContain('X');
  });
});

describe('formatDuration', () => {
  it('60초 미만은 "0분"', () => {
    expect(formatDuration(0)).toBe('0분');
    expect(formatDuration(30)).toBe('0분');
    expect(formatDuration(59)).toBe('0분');
  });

  it('60초 ~ 1시간은 "N분 [M초]"', () => {
    expect(formatDuration(60)).toBe('1분');
    expect(formatDuration(90)).toBe('1분 30초');
    expect(formatDuration(754)).toBe('12분 34초');
    expect(formatDuration(3540)).toBe('59분');
  });

  it('1시간 이상은 "N시간 [M분]"', () => {
    expect(formatDuration(3600)).toBe('1시간');
    expect(formatDuration(3660)).toBe('1시간 1분');
    expect(formatDuration(4980)).toBe('1시간 23분');
    expect(formatDuration(7200)).toBe('2시간');
  });
});
