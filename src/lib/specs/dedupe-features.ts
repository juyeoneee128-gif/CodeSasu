import { createClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';

function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export interface DedupeResult {
  checked: number; // 검사 대상 (is_duplicate=false인 feature 수)
  marked: number; // 새로 is_duplicate=true로 전환된 수
  warnings: string[];
}

interface FeatureRow {
  id: string;
  name: string;
  document_id: string | null;
  doc_modified_at: string | null;
  doc_uploaded_at: string;
  doc_created_at: string;
}

/**
 * 프로젝트 단위로 spec_features 간 중복 검사를 수행하고 is_duplicate를 마킹합니다.
 *
 * 매칭 규칙:
 * - 다른 document_id 끼리만 비교 (같은 문서 내부는 LLM이 이미 dedupe했다고 가정)
 * - 기능명 키워드 50% 이상 겹치면 동일 기능으로 판단
 * - 매칭된 그룹에서 가장 최근 문서(modified_at → uploaded_at → created_at) 외 모두 is_duplicate=true
 *
 * 호출 시점: extract 완료 후, assess 직전 (책임 분리 — 별도 함수).
 * fuzzy 매칭은 transitive하지 않을 수 있어 그래프 클러스터링 대신 그리디 전략 사용.
 */
export async function dedupeFeaturesForProject(projectId: string): Promise<DedupeResult> {
  const supabase = createAdminClient();
  const warnings: string[] = [];

  const { data, error } = await supabase
    .from('spec_features')
    .select(
      'id, name, document_id, is_duplicate, spec_documents(modified_at, uploaded_at, created_at)'
    )
    .eq('project_id', projectId)
    .eq('is_duplicate', false);

  if (error) {
    return { checked: 0, marked: 0, warnings: [`Failed to load features: ${error.message}`] };
  }

  type Joined = {
    id: string;
    name: string;
    document_id: string | null;
    is_duplicate: boolean;
    spec_documents:
      | { modified_at: string | null; uploaded_at: string; created_at: string }
      | null;
  };

  const rows: FeatureRow[] = ((data ?? []) as unknown as Joined[]).map((r) => ({
    id: r.id,
    name: r.name,
    document_id: r.document_id,
    doc_modified_at: r.spec_documents?.modified_at ?? null,
    doc_uploaded_at: r.spec_documents?.uploaded_at ?? new Date(0).toISOString(),
    doc_created_at: r.spec_documents?.created_at ?? new Date(0).toISOString(),
  }));

  if (rows.length < 2) {
    return { checked: rows.length, marked: 0, warnings };
  }

  const toMark = new Set<string>();

  // pairwise 매칭 (i<j) — N²이지만 보통 N<50
  for (let i = 0; i < rows.length; i++) {
    if (toMark.has(rows[i].id)) continue;

    for (let j = i + 1; j < rows.length; j++) {
      if (toMark.has(rows[j].id)) continue;
      if (rows[i].document_id === rows[j].document_id) continue; // 같은 문서 skip

      if (!isSimilarFeature(rows[i].name, rows[j].name)) continue;

      // 더 오래된 쪽을 마킹 — 최근 문서가 대표
      const older = pickOlder(rows[i], rows[j]);
      toMark.add(older.id);
    }
  }

  let marked = 0;
  for (const id of toMark) {
    const { error: updateError } = await supabase
      .from('spec_features')
      .update({ is_duplicate: true })
      .eq('id', id);

    if (updateError) {
      warnings.push(`Failed to mark ${id}: ${updateError.message}`);
      continue;
    }
    marked++;
  }

  return { checked: rows.length, marked, warnings };
}

/**
 * 두 기능명의 키워드 50% 이상 일치 여부를 반환합니다.
 * save-issues.ts의 findMatchingIssue와 같은 휴리스틱이지만 의존성을 분리해
 * 한쪽 변경이 다른 쪽에 영향가지 않도록 내부 헬퍼로 둡니다.
 */
export function isSimilarFeature(a: string, b: string): boolean {
  const aWords = extractKeywords(a);
  const bWords = extractKeywords(b);

  if (aWords.length === 0 || bWords.length === 0) return false;

  const overlap = aWords.filter((w) => bWords.includes(w));
  const overlapRatio = overlap.length / Math.min(aWords.length, bWords.length);
  return overlapRatio >= 0.5;
}

function extractKeywords(name: string): string[] {
  return name
    .replace(/[^가-힣a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function pickOlder(a: FeatureRow, b: FeatureRow): FeatureRow {
  return docTimestamp(a) < docTimestamp(b) ? a : b;
}

function docTimestamp(row: FeatureRow): number {
  const t = row.doc_modified_at ?? row.doc_uploaded_at ?? row.doc_created_at;
  return new Date(t).getTime();
}
