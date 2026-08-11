import { createClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import type { DetectedIssue } from './parse-response';
import type { AnalysisMode } from './prompts';

function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export interface SaveIssuesResult {
  created: number;
  redetected: number;
  auto_resolved: number;
  warnings: string[];
}

export interface SaveIssuesOptions {
  /** 분석 모드. (auto_resolve 게이트는 더 이상 모드에 의존하지 않음 — diffFiles로 판정) */
  mode: AnalysisMode;
  /** 정적 분석/세션 비교가 실제로 실행됐는지. false면 auto_resolve 미실행. */
  analysisRan: boolean;
  /**
   * 이번 분석에 포함된 diff 파일 경로 목록.
   * 정의되면: 이 목록에 있는 파일의 unconfirmed 이슈만 auto_resolve 대상.
   * undefined면: 모든 파일을 대상으로 함 (구버전 호환).
   */
  diffFiles?: string[];
}

/**
 * 감지된 이슈를 DB에 저장합니다.
 * - 기존 이슈와 (file + title 키워드)가 매칭되면 재감지(is_redetected) 처리
 * - analysisRan일 때, 재감지 안 된 unconfirmed 이슈 중 diffFiles에 포함된 파일의 이슈는
 *   auto_resolved로 전환 (diff에 없는 파일은 분석되지 않았으므로 건드리지 않음)
 */
export async function saveDetectedIssues(
  projectId: string,
  sessionId: string,
  issues: DetectedIssue[],
  options: SaveIssuesOptions
): Promise<SaveIssuesResult> {
  const supabase = createAdminClient();
  const warnings: string[] = [];
  let created = 0;
  let redetected = 0;
  let autoResolved = 0;

  // 기존 미해결 + auto_resolved 조회 (resolved 제외)
  // auto_resolved도 포함 → 재감지되면 unconfirmed + is_redetected=true로 자연 복원
  const { data: existingIssues } = await supabase
    .from('issues')
    .select('id, title, file, status')
    .eq('project_id', projectId)
    .in('status', ['unconfirmed', 'confirmed', 'auto_resolved']);

  const existing = existingIssues ?? [];
  const matchedIds = new Set<string>();

  for (const issue of issues) {
    const match = findMatchingIssue(existing, issue);

    if (match) {
      matchedIds.add(match.id);
      const { error } = await supabase
        .from('issues')
        .update({
          status: 'unconfirmed',
          is_redetected: true,
          fact: issue.fact,
          detail: issue.detail,
          fix_command: issue.fix_command,
          basis: issue.basis,
          confidence: issue.confidence,
          start_line: issue.start_line,
          end_line: issue.end_line,
          detected_at: new Date().toISOString(),
          confirmed_at: null,
        } as any)
        .eq('id', match.id);

      if (error) {
        warnings.push(`Failed to update redetected issue ${match.id}: ${error.message}`);
      } else {
        redetected++;
      }
    } else {
      const { error } = await supabase.from('issues').insert({
        project_id: projectId,
        session_id: sessionId,
        title: issue.title,
        level: issue.level,
        status: 'unconfirmed',
        fact: issue.fact,
        detail: issue.detail,
        fix_command: issue.fix_command,
        file: issue.file,
        basis: issue.basis,
        is_redetected: false,
        confidence: issue.confidence,
        start_line: issue.start_line,
        end_line: issue.end_line,
        detected_at: new Date().toISOString(),
      });

      if (error) {
        warnings.push(`Failed to insert issue "${issue.title}": ${error.message}`);
      } else {
        created++;
      }
    }
  }

  // auto_resolve: 분석이 실제 실행됐을 때만.
  // 재감지 안 된 unconfirmed 이슈 중 diffFiles에 포함된 파일의 이슈를 auto_resolved로 전환.
  // diffFiles undefined → 모든 파일 매칭 (구버전 호환).
  // confirmed/auto_resolved는 그대로 둠.
  if (options.analysisRan) {
    const diffFiles = options.diffFiles;
    const candidates = existing.filter(
      (e) =>
        e.status === 'unconfirmed' &&
        !matchedIds.has(e.id) &&
        (!diffFiles || diffFiles.includes(e.file))
    );

    for (const candidate of candidates) {
      const { error } = await supabase
        .from('issues')
        .update({ status: 'auto_resolved' } as any)
        .eq('id', candidate.id);

      if (error) {
        warnings.push(`Failed to auto-resolve issue ${candidate.id}: ${error.message}`);
      } else {
        autoResolved++;
      }
    }
  }

  return { created, redetected, auto_resolved: autoResolved, warnings };
}

// ─── 재감지 매칭 ───

interface ExistingIssue {
  id: string;
  title: string;
  file: string;
  status: string;
}

/**
 * 기존 이슈와 매칭합니다.
 * 1. file 경로 완전 일치
 * 2. title 키워드 포함 비교 (어느 한 쪽이 다른 쪽을 포함)
 */
function findMatchingIssue(
  existing: ExistingIssue[],
  newIssue: DetectedIssue
): ExistingIssue | null {
  for (const ex of existing) {
    if (ex.file !== newIssue.file) continue;

    const exWords = extractKeywords(ex.title);
    const newWords = extractKeywords(newIssue.title);

    // 키워드 50% 이상 겹치면 매칭
    const overlap = exWords.filter((w) => newWords.includes(w));
    const overlapRatio = overlap.length / Math.min(exWords.length, newWords.length);

    if (overlapRatio >= 0.5) {
      return ex;
    }
  }
  return null;
}

/**
 * 제목에서 키워드 추출 (조사, 공백 제거)
 */
function extractKeywords(title: string): string[] {
  return title
    .replace(/[^가-힣a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}
