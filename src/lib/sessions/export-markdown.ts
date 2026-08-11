import type { ErrorEntry, PromptEntry } from '@/src/lib/agent/parse-session';
import { formatDuration } from '@/src/lib/agent/parse-session';

/**
 * sessions.parsed_summary jsonb 컬럼의 실제 형태.
 * (save-session.ts에서 저장하는 4개 필드만 들어감 — duration/prompt_count/total_tokens는 별도 컬럼)
 */
export interface ParsedSummary {
  files_read: string[];
  tool_usage: Record<string, number>;
  errors: ErrorEntry[];
  prompts_meta: PromptEntry[];
}

/**
 * buildSessionMarkdown 입력 — Supabase Row에서 export에 필요한 필드만 추렸습니다.
 * DB 컬럼명 그대로 (files_changed=integer 카운트, changed_files=string[] 경로 목록).
 */
export interface SessionExportInput {
  number: number;
  title: string;
  created_at: string;
  duration_seconds: number | null;
  prompt_count: number | null;
  total_tokens: number | null;
  files_changed: number;
  changed_files: string[];
  prompts: string[];
  parsed_summary: ParsedSummary | null;
}

const FOOTER = '> CodeSasu로 자동 생성됨 · codesasu.dev';

// ─── 시간 포맷 헬퍼 (KST = Asia/Seoul) ───

function formatKstDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '(시간 미상)';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

function formatKstTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h === '24' ? '00' : h}:${m}`;
}

// formatDuration은 < 60s에서 "0분"을 반환하므로, 짧은 세션 가독성용 폴백.
function formatDurationOrSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}초`;
  return formatDuration(seconds);
}

function formatThousands(n: number): string {
  return n.toLocaleString('en-US');
}

// ─── 파일명 slug ───

/**
 * 제목을 파일명 slug로 변환:
 * - 첫 30자 컷 → 한/영/숫자/공백 외 모두 제거 → 공백→하이픈 → 연속 하이픈 단일화 → 양끝 하이픈 제거.
 * - 입력이 비거나 결과가 빈 문자열이면 빈 문자열 반환 (라우트에서 단순 파일명으로 폴백).
 */
export function slugifyTitle(title: string): string {
  const sliced = title.slice(0, 30);
  return sliced
    .replace(/[^a-zA-Z0-9가-힣\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── 마크다운 빌더 ───

export function buildSessionMarkdown(input: SessionExportInput): string {
  const lines: string[] = [];

  lines.push(`# 세션 #${input.number} — ${input.title}`);
  lines.push('');

  // 메타 표
  lines.push('| 항목 | 값 |');
  lines.push('|------|-----|');
  lines.push(`| 날짜 | ${formatKstDateTime(input.created_at)} |`);

  if (input.parsed_summary) {
    const summary = input.parsed_summary;
    if (typeof input.duration_seconds === 'number') {
      lines.push(`| 소요 시간 | ${formatDurationOrSeconds(input.duration_seconds)} |`);
    }
    if (typeof input.prompt_count === 'number') {
      lines.push(`| 프롬프트 | ${input.prompt_count}개 |`);
    }
    lines.push(`| 변경 파일 | ${input.files_changed}개 |`);
    if (Array.isArray(summary.files_read)) {
      lines.push(`| 읽은 파일 | ${summary.files_read.length}개 |`);
    }
    if (typeof input.total_tokens === 'number') {
      lines.push(`| 토큰 사용 | ${formatThousands(input.total_tokens)}개 |`);
    }
  }

  // parsed_summary가 null이면 메타 표만 + footer
  if (!input.parsed_summary) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(FOOTER);
    return lines.join('\n') + '\n';
  }

  const summary = input.parsed_summary;

  // 프롬프트 기록
  const promptsMeta = summary.prompts_meta ?? [];
  const promptsFallback = input.prompts ?? [];
  const hasPrompts = promptsMeta.length > 0 || promptsFallback.length > 0;
  if (hasPrompts) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 프롬프트 기록');
    lines.push('');
    if (promptsMeta.length > 0) {
      promptsMeta.forEach((p, i) => {
        const time = formatKstTime(p.timestamp);
        const header = time ? `### ${i + 1}. (${time})` : `### ${i + 1}.`;
        lines.push(header);
        lines.push(p.content);
        lines.push('');
      });
    } else {
      promptsFallback.forEach((content, i) => {
        lines.push(`### ${i + 1}.`);
        lines.push(content);
        lines.push('');
      });
    }
  }

  // 변경된 파일
  const changed = input.changed_files ?? [];
  if (changed.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 변경된 파일');
    for (const f of changed) lines.push(`- ${f}`);
    lines.push('');
  }

  // 읽은 파일
  const filesRead = summary.files_read ?? [];
  if (filesRead.length > 0) {
    lines.push('## 읽은 파일');
    for (const f of filesRead) lines.push(`- ${f}`);
    lines.push('');
  }

  // 도구 사용 통계 (횟수 내림차순)
  const toolUsage = summary.tool_usage ?? {};
  const toolEntries = Object.entries(toolUsage).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 도구 사용 통계');
    lines.push('| 도구 | 횟수 |');
    lines.push('|------|------|');
    for (const [name, count] of toolEntries) {
      lines.push(`| ${name} | ${count} |`);
    }
    lines.push('');
  }

  // 에러
  const errors = summary.errors ?? [];
  if (errors.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(`## 에러 (${errors.length}건)`);
    for (const e of errors) {
      const time = formatKstTime(e.timestamp);
      const suffix = time ? ` (${time})` : '';
      lines.push(`- [${e.tool_name}] ${e.message}${suffix}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(FOOTER);

  return lines.join('\n') + '\n';
}
