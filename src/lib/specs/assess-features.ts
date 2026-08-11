import { createClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import { callClaude } from '../analysis/claude-client';
import { ANALYSIS_MODELS } from '../analysis/models';
import { getEphemeralSourceFiles } from '../agent/ephemeral';
import {
  ASSESS_FEATURES_TOOL,
  ASSESS_FEATURES_SYSTEM,
  buildAssessMessage,
  buildAssessWithSourceMessage,
} from './prompts';

function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

type FeatureStatus = 'implemented' | 'partial' | 'unimplemented' | 'attention';
const VALID_STATUSES = new Set<string>(['implemented', 'partial', 'unimplemented', 'attention']);

/**
 * 한 번의 callClaude 호출이 안정적으로 응답할 수 있는 feature 수 상한.
 * 100+ 기능에서는 단일 호출 출력 토큰이 16k를 초과해 잘리므로 chunk로 분할 호출한다.
 */
export const ASSESS_CHUNK_SIZE = 50;

/**
 * 임의의 배열을 chunkSize 단위로 분할. chunk 분할 로직이 회귀 없이 동작하는지
 * 단위 테스트로 보호 (assess-features 내부의 LLM 호출과 무관하게 검증 가능).
 */
export function chunkFeatures<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) throw new Error('chunkSize must be positive');
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * implemented_items 길이 vs expected_items 길이로 status를 결정.
 * LLM이 같은 입력에 대해 다른 status 라벨을 붙이는 비결정성을 회피.
 *
 * - expected===0  → unimplemented (legacy fallback에서는 호출 측이 LLM status를 사용)
 * - impl===0      → unimplemented
 * - impl >= exp   → implemented (LLM이 expected 밖 항목을 넣은 경우도 implemented로 흡수,
 *                   호출 측에서 사전 필터링하면 impl ≤ exp 보장됨)
 * - 그 외 (0 < impl < exp) → partial
 */
export function computeStatusFromCounts(impl: number, exp: number): FeatureStatus {
  if (exp === 0) return 'unimplemented';
  if (impl === 0) return 'unimplemented';
  if (impl >= exp) return 'implemented';
  return 'partial';
}

export interface AssessResult {
  assessed_count: number;
  stats: {
    total: number;
    implemented: number;
    partial: number;
    unimplemented: number;
    attention: number;
    implementation_rate: number;
  };
  token_usage: { input: number; output: number };
  warnings: string[];
  /** 어떤 근거로 판정했는지 — 디버깅/관측용 */
  basis: 'source_code' | 'signatures';
}

export interface AssessFeaturesOptions {
  /**
   * full_scan 세션 ID. useSourceCode=true이면 이 세션의 ephemeral_data에서
   * source_files를 로드하여 코드 기반 판정에 사용.
   */
  sessionId?: string;
  /** true이면 source_files를 우선 근거로 사용. false/미설정이면 기존 시그니처 경로. */
  useSourceCode?: boolean;
}

/**
 * 기획서 기능 vs 세션 로그를 대조하여 구현 현황을 판정합니다.
 *
 * 판정 근거 우선순위:
 *   1. useSourceCode=true이고 source_files가 있으면 → 실제 소스코드 기반 (정확도 우선)
 *   2. 그 외 → 기존 file_signatures + 세션 요약 기반 (fallback)
 */
export async function assessFeatures(
  projectId: string,
  options: AssessFeaturesOptions = {}
): Promise<AssessResult> {
  const supabase = createAdminClient();
  const warnings: string[] = [];

  // 1. 기능 목록 조회 (중복 마킹된 항목 제외)
  const { data: features } = await supabase
    .from('spec_features')
    .select('id, name, total_items, prd_summary, expected_items')
    .eq('project_id', projectId)
    .eq('is_duplicate', false);

  if (!features || features.length === 0) {
    return {
      assessed_count: 0,
      stats: { total: 0, implemented: 0, partial: 0, unimplemented: 0, attention: 0, implementation_rate: 0 },
      token_usage: { input: 0, output: 0 },
      warnings: ['No features to assess'],
      basis: 'signatures',
    };
  }

  // 2. 세션 로그 조회
  const { data: sessions } = await supabase
    .from('sessions')
    .select('title, summary, changed_files')
    .eq('project_id', projectId)
    .order('number', { ascending: true });

  const sessionData = (sessions ?? []).map((s) => ({
    title: s.title,
    summary: s.summary,
    changed_files: Array.isArray(s.changed_files) ? (s.changed_files as string[]) : [],
  }));

  // 2.5. 파일 시그니처 조회 (LLM + 정규식 양 경로에서 누적된 데이터)
  const { data: signatureRows } = await supabase
    .from('file_signatures')
    .select('file_path, functions, imports, exports, patterns, line_count')
    .eq('project_id', projectId);

  const signatures = (signatureRows ?? []).map((r) => ({
    file_path: r.file_path,
    functions: r.functions ?? [],
    imports: r.imports ?? [],
    exports: r.exports ?? [],
    patterns: r.patterns ?? [],
    line_count: r.line_count ?? 0,
  }));

  // 2.6. source_files 로드 (full_scan 세션에서만)
  let sourceFiles: { path: string; content: string; line_count: number }[] = [];
  if (options.useSourceCode && options.sessionId) {
    try {
      sourceFiles = await getEphemeralSourceFiles(options.sessionId);
    } catch (err) {
      warnings.push(`Failed to load source_files: ${(err as Error).message}`);
    }
  }

  const featureInputs = features.map((f) => ({
    id: f.id,
    name: f.name,
    total_items: f.total_items,
    prd_summary: f.prd_summary,
    expected_items: Array.isArray(f.expected_items)
      ? (f.expected_items as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
  }));

  // 3. Claude API 호출 — features를 ASSESS_CHUNK_SIZE 단위로 분할하여 순차 호출.
  //    100+ 기능이면 단일 호출 출력 토큰이 16k를 초과해 잘리므로 chunk 분할이 필수.
  //    각 chunk는 system 프롬프트를 공유(ephemeral cache) → 2~3번째 호출은 캐시 hit.
  const useSourceBasis = sourceFiles.length > 0;
  const featureChunks = chunkFeatures(featureInputs, ASSESS_CHUNK_SIZE);

  let assessedCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const featureIds = new Set(features.map((f) => f.id));
  // featureId → expected_items 매핑. 응답 파싱 시 status 보정과 implemented 필터링에 사용.
  const expectedByFeatureId = new Map(
    featureInputs.map((f) => [f.id, f.expected_items])
  );

  for (const chunk of featureChunks) {
    const userMessage = useSourceBasis
      ? buildAssessWithSourceMessage({
          features: chunk,
          sessions: sessionData,
          source_files: sourceFiles,
        })
      : buildAssessMessage({
          features: chunk,
          sessions: sessionData,
          file_signatures: signatures,
        });

    const result = await callClaude({
      systemPrompt: ASSESS_FEATURES_SYSTEM,
      userMessage,
      tools: [ASSESS_FEATURES_TOOL],
      // chunk당 50개 ≤ ~7.5k 출력 토큰. 16k면 충분한 마진.
      maxTokens: 16384,
      model: ANALYSIS_MODELS.ASSESS_FEATURES,
    });

    totalInputTokens += result.tokenUsage.input;
    totalOutputTokens += result.tokenUsage.output;

    // 4. 응답 파싱 + UPDATE — chunk별로 동일 로직, 결과 누적
    for (const input of result.toolInputs) {
      const assessments = input.assessments;
      if (!Array.isArray(assessments)) continue;

      for (const raw of assessments) {
        const a = raw as Record<string, unknown>;
        const featureId = a.feature_id as string;
        const llmStatus = a.status as string;

        if (!featureIds.has(featureId)) {
          warnings.push(`Unknown feature_id: ${featureId}`);
          continue;
        }

        // implemented_items 정규화 — 문자열만 유지.
        const llmImplemented = Array.isArray(a.implemented_items)
          ? (a.implemented_items as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const relatedFiles = Array.isArray(a.related_files) ? a.related_files : [];

        // expected_items가 채워진 경우:
        //   (1) LLM이 반환한 implemented_items 중 expected에 없는 이름은 제거 → "6/5 모순" 방지
        //   (2) status를 코드 측에서 결정 → LLM 비결정성 차단 (구현율 변동 해소)
        // legacy(expected 빈) 경우:
        //   기존 동작 유지 — LLM status 그대로 사용 (단 enum 검증)
        const expected = expectedByFeatureId.get(featureId) ?? [];
        const cleanedImplemented =
          expected.length > 0
            ? llmImplemented.filter((n) => expected.includes(n))
            : llmImplemented;
        const finalStatus: FeatureStatus =
          expected.length > 0
            ? computeStatusFromCounts(cleanedImplemented.length, expected.length)
            : VALID_STATUSES.has(llmStatus)
              ? (llmStatus as FeatureStatus)
              : 'attention';

        if (!VALID_STATUSES.has(finalStatus)) {
          warnings.push(`Invalid status "${finalStatus}" for feature ${featureId}`);
          continue;
        }

        const { error } = await supabase
          .from('spec_features')
          .update({
            status: finalStatus,
            implemented_items: cleanedImplemented as Database['public']['Tables']['spec_features']['Update']['implemented_items'],
            related_files: relatedFiles as Database['public']['Tables']['spec_features']['Update']['related_files'],
          })
          .eq('id', featureId);

        if (error) {
          warnings.push(`Failed to update feature ${featureId}: ${error.message}`);
        } else {
          assessedCount++;
        }
      }
    }
  }

  // 5. 통계 계산 (중복 제외)
  const { data: updatedFeatures } = await supabase
    .from('spec_features')
    .select('status')
    .eq('project_id', projectId)
    .eq('is_duplicate', false);

  const all = updatedFeatures ?? [];
  const stats = {
    total: all.length,
    implemented: all.filter((f) => f.status === 'implemented').length,
    partial: all.filter((f) => f.status === 'partial').length,
    unimplemented: all.filter((f) => f.status === 'unimplemented').length,
    attention: all.filter((f) => f.status === 'attention').length,
    implementation_rate: 0,
  };

  if (stats.total > 0) {
    stats.implementation_rate = Math.round(
      ((stats.implemented + stats.partial * 0.5) / stats.total) * 100
    );
  }

  return {
    assessed_count: assessedCount,
    stats,
    token_usage: { input: totalInputTokens, output: totalOutputTokens },
    warnings,
    basis: useSourceBasis ? 'source_code' : 'signatures',
  };
}
