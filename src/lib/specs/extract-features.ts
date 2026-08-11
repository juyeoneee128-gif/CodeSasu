import { createClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import { callClaude } from '../analysis/claude-client';
import { ANALYSIS_MODELS } from '../analysis/models';
import {
  EXTRACT_FEATURES_TOOL,
  EXTRACT_FEATURES_SYSTEM,
  buildExtractFeaturesMessage,
} from './prompts';

function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

interface ExtractedFeature {
  name: string;
  total_items: number;
  prd_summary: string;
  expected_items: string[];
}

export type DocumentClassification = 'prd' | 'spec' | 'other';

const VALID_CLASSIFICATIONS = new Set<string>(['prd', 'spec', 'other']);

export interface ExtractFeaturesResult {
  document_id: string;
  document_type: DocumentClassification | null;
  features_count: number;
  features: ExtractedFeature[];
  token_usage: { input: number; output: number };
  error: string | null;
}

/**
 * spec_documents에 새 row를 INSERT하고 id를 반환합니다.
 * 수동 업로드 흐름에서 사용. agent 흐름은 syncAgentDocs에서 직접 upsert.
 */
async function insertSpecDocument(
  projectId: string,
  documentName: string,
  documentType: 'FRD' | 'PRD'
): Promise<{ id: string } | { error: string }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('spec_documents')
    .insert({
      project_id: projectId,
      name: documentName,
      type: documentType,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { error: `Failed to save document: ${error?.message}` };
  }
  return { id: data.id };
}

/**
 * 주어진 document_id에 대해 Claude로 기능 추출 → spec_features INSERT.
 * 호출 측은 spec_documents row가 이미 존재한다는 것을 보장해야 함.
 *
 * agent 흐름(syncAgentDocs)과 수동 업로드 흐름(extractAndSaveFeatures)이 공통으로 사용.
 */
export async function extractFeaturesForDocument(
  projectId: string,
  documentId: string,
  documentType: 'FRD' | 'PRD',
  content: string
): Promise<ExtractFeaturesResult> {
  const supabase = createAdminClient();

  // 1. Claude API 호출
  const userMessage = buildExtractFeaturesMessage(content, documentType);

  const result = await callClaude({
    systemPrompt: EXTRACT_FEATURES_SYSTEM,
    userMessage,
    tools: [EXTRACT_FEATURES_TOOL],
    maxTokens: 4096,
    model: ANALYSIS_MODELS.EXTRACT_FEATURES,
  });

  // 2. 응답 파싱 — document_type + features
  let classification: DocumentClassification | null = null;
  const features: ExtractedFeature[] = [];

  for (const input of result.toolInputs) {
    const rawType = input.document_type;
    if (typeof rawType === 'string' && VALID_CLASSIFICATIONS.has(rawType)) {
      classification = rawType as DocumentClassification;
    }

    const rawFeatures = input.features;
    if (!Array.isArray(rawFeatures)) continue;

    for (const raw of rawFeatures) {
      const f = raw as Record<string, unknown>;
      if (typeof f.name === 'string' && typeof f.prd_summary === 'string') {
        const expected_items = Array.isArray(f.expected_items)
          ? f.expected_items.filter((x): x is string => typeof x === 'string')
          : [];
        features.push({
          name: f.name,
          // total_items는 LLM 반환값보다 expected_items.length를 우선 — 두 값 사이 불일치 방지.
          // expected_items 비어있는 legacy 케이스는 LLM total_items로 fallback.
          total_items:
            expected_items.length > 0
              ? expected_items.length
              : typeof f.total_items === 'number'
                ? f.total_items
                : 1,
          prd_summary: f.prd_summary,
          expected_items,
        });
      }
    }
  }

  // 3. classification이 'other'이면 features를 강제로 비움 (LLM이 잘못 추출했을 경우 방어)
  const effectiveFeatures = classification === 'other' ? [] : features;

  // 4. spec_documents.classification UPDATE (분류 결과 영구 저장)
  if (classification !== null) {
    const { error: classifyError } = await supabase
      .from('spec_documents')
      .update({ classification })
      .eq('id', documentId);

    if (classifyError) {
      // 분류 저장 실패는 경고만 — extract 자체는 진행
      console.warn(
        `[extract] failed to save classification for ${documentId}: ${classifyError.message}`
      );
    }
  }

  // 5. spec_features 일괄 INSERT (other이거나 features 0개면 skip)
  if (effectiveFeatures.length > 0) {
    const rows = effectiveFeatures.map((f) => ({
      project_id: projectId,
      document_id: documentId,
      name: f.name,
      source: documentType,
      status: 'unimplemented' as const,
      total_items: f.total_items,
      prd_summary: f.prd_summary,
      expected_items: f.expected_items as Database['public']['Tables']['spec_features']['Insert']['expected_items'],
    }));

    const { error: insertError } = await supabase.from('spec_features').insert(rows);

    if (insertError) {
      return {
        document_id: documentId,
        document_type: classification,
        features_count: 0,
        features: effectiveFeatures,
        token_usage: result.tokenUsage,
        error: `Features extracted but failed to save: ${insertError.message}`,
      };
    }
  }

  return {
    document_id: documentId,
    document_type: classification,
    features_count: effectiveFeatures.length,
    features: effectiveFeatures,
    token_usage: result.tokenUsage,
    error: null,
  };
}

/**
 * 기획서 텍스트에서 기능 목록을 추출하고 DB에 저장합니다.
 *
 * 수동 업로드 흐름 — 항상 새 spec_documents row를 INSERT.
 * agent 흐름은 syncAgentDocs + extractFeaturesForDocument 조합 사용.
 */
export async function extractAndSaveFeatures(
  projectId: string,
  documentName: string,
  documentType: 'FRD' | 'PRD',
  content: string
): Promise<ExtractFeaturesResult> {
  const insertResult = await insertSpecDocument(projectId, documentName, documentType);
  if ('error' in insertResult) {
    return {
      document_id: '',
      document_type: null,
      features_count: 0,
      features: [],
      token_usage: { input: 0, output: 0 },
      error: insertResult.error,
    };
  }

  return extractFeaturesForDocument(
    projectId,
    insertResult.id,
    documentType,
    content
  );
}
