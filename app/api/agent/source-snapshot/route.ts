import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/src/lib/supabase/types';
import { extractBearerToken, verifyAgentToken } from '@/src/lib/agent/auth-agent';
import { verifyHmacSignature } from '@/src/lib/agent/verify-signature';
import {
  validateSourceSnapshotPayload,
  validatePayloadSize,
  MAX_PAYLOAD_SIZE,
} from '@/src/lib/agent/validate-payload';
import {
  saveEphemeralSourceFiles,
  deleteEphemeral,
} from '@/src/lib/agent/ephemeral';
import { assessFeatures } from '@/src/lib/specs/assess-features';
import { runAnalysis } from '@/src/lib/analysis/run-analysis';
import { syncAgentDocs } from '@/src/lib/specs/sync-docs';
import { extractFeaturesForDocument } from '@/src/lib/specs/extract-features';
import { dedupeFeaturesForProject } from '@/src/lib/specs/dedupe-features';
import { shouldBackfillFeatures } from '@/src/lib/agent/backfill-decision';

const VIRTUAL_SESSION_TITLE = '__source_snapshot__';
const EXTRACT_CONCURRENCY = 3;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    await Promise.all(chunk.map(fn));
  }
}

// POST /api/agent/source-snapshot — 에이전트 부팅 시 1회 호출
//   전체 소스 파일을 받아 assessFeatures만 실행 (이슈 감지 미실행).
//   가상 세션을 만들어 ephemeral_data FK를 충족시킨 뒤,
//   분석 완료 후 가상 세션과 ephemeral_data를 모두 정리한다.
//   첫 스캔은 비용 차감 없음 (1회성, MVP 정책).
export async function POST(request: Request) {
  // 1. 토큰 추출
  const token = extractBearerToken(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json(
      { error: 'Missing or invalid Authorization header' },
      { status: 401 }
    );
  }

  // 2. 페이로드 크기 확인
  const rawBody = await request.text();
  if (!validatePayloadSize(rawBody)) {
    return NextResponse.json(
      { error: 'Payload too large', max_size: `${MAX_PAYLOAD_SIZE / 1024 / 1024}MB` },
      { status: 413 }
    );
  }

  // 3. JSON 파싱
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 4. 페이로드 검증
  const validation = validateSourceSnapshotPayload(body);
  if (!validation.valid) {
    return NextResponse.json(
      { error: 'Invalid payload', details: validation.errors },
      { status: 400 }
    );
  }

  const { payload } = validation;

  // 5. 토큰 검증 → project_id 확인
  const authResult = await verifyAgentToken(token);
  if (!authResult) {
    return NextResponse.json({ error: 'Invalid agent token' }, { status: 401 });
  }

  if (authResult.project_id !== payload.project_id) {
    return NextResponse.json(
      { error: 'Agent token does not match project_id' },
      { status: 403 }
    );
  }

  // 6. HMAC 서명 검증 (push 라우트와 동일 정책: 둘 다 없으면 0.3.x 호환 통과)
  const sigHeader = request.headers.get('x-codesasu-signature');
  const tsHeader = request.headers.get('x-codesasu-timestamp');
  let signatureVerified = false;

  if (sigHeader && tsHeader) {
    const result = verifyHmacSignature(
      rawBody,
      sigHeader,
      tsHeader,
      authResult.signing_key
    );
    if (!result.valid) {
      return NextResponse.json(
        { error: 'Invalid signature', reason: result.reason },
        { status: 401 }
      );
    }
    signatureVerified = true;
  } else if (sigHeader || tsHeader) {
    return NextResponse.json(
      {
        error:
          'Malformed signature: both X-CodeSasu-Signature and X-CodeSasu-Timestamp required',
      },
      { status: 400 }
    );
  } else {
    console.warn(
      `[source-snapshot] HMAC headers missing — agent_version=${payload.metadata.agent_version} project=${payload.project_id}`
    );
  }

  const adminClient = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 7. 멱등성 체크 — first_scan_done=true면 short-circuit
  const { data: projRow, error: projErr } = await adminClient
    .from('projects')
    .select('first_scan_done')
    .eq('id', payload.project_id)
    .single();

  if (projErr || !projRow) {
    return NextResponse.json(
      { error: 'Project not found', detail: projErr?.message },
      { status: 404 }
    );
  }

  if (projRow.first_scan_done) {
    return NextResponse.json(
      {
        success: true,
        skipped: 'already_scanned',
        security: { signature_verified: signatureVerified },
      },
      { status: 200 }
    );
  }

  // 8. 가상 세션 INSERT — ephemeral_data FK 충족용
  const { data: virtualSession, error: sessionErr } = await adminClient
    .from('sessions')
    .insert({
      project_id: payload.project_id,
      title: VIRTUAL_SESSION_TITLE,
      summary: 'Initial source snapshot for feature assessment',
      raw_log: '',
      files_changed: 0,
      changed_files: [],
      prompts: [],
      external_session_id: `bootstrap:${randomUUID()}`,
    })
    .select('id')
    .single();

  if (sessionErr || !virtualSession) {
    return NextResponse.json(
      { error: 'Failed to create virtual session', detail: sessionErr?.message },
      { status: 500 }
    );
  }

  const virtualSessionId = virtualSession.id;

  // 8-bis. docs_files 처리 — assessFeatures 전에 spec_features를 채워야 의미 있는 평가 가능.
  //   멱등성: 이미 spec_features가 1건 이상이면 docs 추출 스킵 (LLM 재실행 비용 차단).
  //   실패해도 source 분석은 진행 (graceful degradation).
  let docsSynced = 0;
  let featuresExtracted = 0;
  const docsFiles = payload.docs_files ?? [];

  if (docsFiles.length > 0) {
    const { count: existingFeatureCount, error: countError } = await adminClient
      .from('spec_features')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', payload.project_id);

    // expected_items가 비어있는 legacy features id 목록 — backfill 대상.
    //
    // 주의: supabase-js의 `.eq('jsonb_col', '[]')`는 PostgREST 변환 과정에서
    // 빈 jsonb 배열과 매칭이 실패하므로 사용할 수 없다. 모든 row를 fetch한 뒤
    // JS에서 length 검사로 필터링한다.
    const { data: legacyRows, error: legacyErr } = await adminClient
      .from('spec_features')
      .select('id, expected_items')
      .eq('project_id', payload.project_id)
      .eq('is_duplicate', false);

    const legacyIds = legacyErr
      ? []
      : (legacyRows ?? [])
          .filter(
            (r) =>
              !Array.isArray(r.expected_items) ||
              (r.expected_items as unknown[]).length === 0
          )
          .map((r) => r.id);
    const legacyFeatureCount = legacyIds.length;

    if (countError) {
      console.warn(
        '[source-snapshot] spec_features count failed:',
        countError.message
      );
    } else if (shouldBackfillFeatures(existingFeatureCount, legacyFeatureCount)) {
      console.log(
        `[source-snapshot] backfill triggered: existing=${existingFeatureCount ?? 0} legacy=${legacyFeatureCount}`
      );
      // legacy row가 있으면 그것만 선택 삭제 — 채워진 row는 보존.
      if (legacyFeatureCount > 0) {
        const { error: delErr } = await adminClient
          .from('spec_features')
          .delete()
          .in('id', legacyIds);
        if (delErr) {
          console.error('[source-snapshot] legacy delete failed:', delErr.message);
        }
      }
      // spec_documents.content_hash을 null로 만들어 syncAgentDocs가 강제로 changed 분기를 타도록.
      // 이 단계가 없으면 existingFeatureCount===0(수동 삭제) 케이스에서 모든 doc이 unchanged로
      // 판정되어 extract가 단 한 번도 호출되지 않고 "No features to assess"로 끝난다.
      {
        const { error: hashErr } = await adminClient
          .from('spec_documents')
          .update({ content_hash: null })
          .eq('project_id', payload.project_id)
          .eq('source', 'agent')
          .is('deleted_at', null);
        if (hashErr) {
          console.error('[source-snapshot] content_hash reset failed:', hashErr.message);
        }
      }
      try {
        const sync = await syncAgentDocs(payload.project_id, docsFiles);
        if (sync.errors.length > 0) {
          console.error('[source-snapshot] docs sync errors:', sync.errors);
        }
        docsSynced = sync.changed.length;
        console.log(
          `[source-snapshot] docs sync: ${sync.changed.length} changed, ${sync.unchanged_count} unchanged, ${sync.deleted_count} deleted`
        );

        if (sync.changed.length > 0) {
          await runWithConcurrency(sync.changed, EXTRACT_CONCURRENCY, async (doc) => {
            try {
              const result = await extractFeaturesForDocument(
                payload.project_id,
                doc.document_id,
                doc.type,
                doc.content
              );
              if (result.error) {
                console.error(
                  `[source-snapshot] extract ${doc.path} failed: ${result.error}`
                );
              } else {
                featuresExtracted += result.features_count;
                console.log(
                  `[source-snapshot] extract ${doc.path} → ${result.features_count} features (in ${result.token_usage.input}/out ${result.token_usage.output} tokens)`
                );
              }
            } catch (err) {
              console.error(
                `[source-snapshot] extract ${doc.path} threw:`,
                (err as Error).message
              );
            }
          });

          try {
            const dedupe = await dedupeFeaturesForProject(payload.project_id);
            if (dedupe.warnings.length > 0) {
              console.error('[source-snapshot] dedupe warnings:', dedupe.warnings);
            }
            console.log(
              `[source-snapshot] dedupe: ${dedupe.checked} checked, ${dedupe.marked} marked`
            );
          } catch (err) {
            console.error(
              '[source-snapshot] dedupe failed:',
              (err as Error).message
            );
          }
        }
      } catch (err) {
        console.error(
          '[source-snapshot] docs processing failed:',
          (err as Error).message
        );
      }
    } else {
      console.log(
        `[source-snapshot] docs processing skipped — ${existingFeatureCount} existing features (idempotent)`
      );
    }
  }

  // 9. ephemeral_data에 source_files 저장 + assessFeatures + runAnalysis 실행 + 정리
  //    실행 순서: saveEphemeral → assessFeatures → runAnalysis → cleanup.
  //    runAnalysis는 내부에서 ephemeral을 삭제하지만, 실패 시에도 정리되도록
  //    finally에서 한 번 더 호출(이미 삭제됐으면 0건 반환 — 안전).
  let featuresAssessed = 0;
  let scanDurationMs = 0;
  let assessError: string | null = null;
  let issuesCreated = 0;
  let analysisError: string | null = null;

  try {
    await saveEphemeralSourceFiles(virtualSessionId, payload.source_files);

    const t0 = Date.now();
    const assess = await assessFeatures(payload.project_id, {
      sessionId: virtualSessionId,
      useSourceCode: true,
    });
    scanDurationMs = Date.now() - t0;
    featuresAssessed = assess.assessed_count;

    if (assess.warnings.length > 0) {
      console.warn('[source-snapshot] assess warnings:', assess.warnings);
    }
  } catch (err) {
    assessError = (err as Error).message;
    console.error('[source-snapshot] assessFeatures failed:', assessError);
  }

  // 9-bis. 정적 분석 실행 — 이슈 탭 첫 연결 시 채우기.
  //   assessFeatures 실패와 무관하게 시도(현황과 이슈는 독립).
  //   실패해도 first_scan_done 갱신은 진행 — 다음 코딩 세션에서 자연스럽게 채워짐.
  try {
    const analysis = await runAnalysis(
      payload.project_id,
      virtualSessionId,
      'full',
      { sourceFilesAsDiff: true }
    );
    issuesCreated = analysis.issues_created;
    if (analysis.warnings.length > 0) {
      console.warn('[source-snapshot] analysis warnings:', analysis.warnings);
    }
  } catch (err) {
    analysisError = (err as Error).message;
    console.error('[source-snapshot] runAnalysis failed:', analysisError);
  }

  // ephemeral_data 삭제 (runAnalysis가 성공한 경우 이미 삭제됐을 수 있음 — 멱등)
  try {
    await deleteEphemeral(virtualSessionId);
  } catch (err) {
    console.warn(
      '[source-snapshot] ephemeral cleanup failed:',
      (err as Error).message
    );
  }
  // 가상 세션 삭제 (프론트엔드 세션 리스트에 노이즈 0).
  //   issues.session_id는 ON DELETE SET NULL이므로 감지된 이슈는 보존됨.
  try {
    await adminClient.from('sessions').delete().eq('id', virtualSessionId);
  } catch (err) {
    console.warn(
      '[source-snapshot] virtual session cleanup failed:',
      (err as Error).message
    );
  }

  // 10. assessFeatures 실패 시 first_scan_done은 갱신하지 않음 — 다음 부팅에 재시도
  if (assessError) {
    return NextResponse.json(
      {
        success: false,
        error: 'assessFeatures failed',
        detail: assessError,
        security: { signature_verified: signatureVerified },
      },
      { status: 500 }
    );
  }

  // 11. first_scan_done 마킹 + pending_full_scan 클리어
  try {
    await adminClient
      .from('projects')
      .update({
        first_scan_done: true,
        pending_full_scan: false,
        pending_full_scan_at: null,
      })
      .eq('id', payload.project_id);
  } catch (err) {
    console.error(
      '[source-snapshot] first_scan_done update failed:',
      (err as Error).message
    );
  }

  return NextResponse.json(
    {
      success: true,
      features_assessed: featuresAssessed,
      features_extracted: featuresExtracted,
      docs_synced: docsSynced,
      issues_created: issuesCreated,
      scan_duration_ms: scanDurationMs,
      source_files_count: payload.source_files.length,
      docs_files_count: docsFiles.length,
      ...(analysisError ? { analysis_error: analysisError } : {}),
      security: { signature_verified: signatureVerified },
    },
    { status: 201 }
  );
}
