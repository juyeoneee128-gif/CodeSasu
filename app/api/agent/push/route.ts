import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/src/lib/supabase/types';
import { extractBearerToken, verifyAgentToken } from '@/src/lib/agent/auth-agent';
import { verifyHmacSignature } from '@/src/lib/agent/verify-signature';
import { validatePayload, validatePayloadSize, MAX_PAYLOAD_SIZE } from '@/src/lib/agent/validate-payload';
import { parseSession } from '@/src/lib/agent/parse-session';
import { saveSession, updateAgentStatus, mergeChangedFiles } from '@/src/lib/agent/save-session';
import {
  saveEphemeralDiffs,
  saveEphemeralEslint,
  saveEphemeralFileTree,
  saveEphemeralSourceFiles,
  cleanupExpiredEphemeral,
} from '@/src/lib/agent/ephemeral';
import { runAnalysis } from '@/src/lib/analysis/run-analysis';
import { assessFeatures } from '@/src/lib/specs/assess-features';
import { syncAgentDocs } from '@/src/lib/specs/sync-docs';
import { extractFeaturesForDocument } from '@/src/lib/specs/extract-features';
import { dedupeFeaturesForProject } from '@/src/lib/specs/dedupe-features';
import { upsertFileSignatures } from '@/src/lib/specs/save-signatures';
import { countDiffLines } from '@/src/lib/agent/diff-stats';
import { hasUserApiKey, getUserApiKey } from '@/src/lib/credits/byok';
import { deductCredit, getCreditInfo } from '@/src/lib/credits/deduct';
import {
  checkDailyLimit,
  incrementDailyCount,
  getDailyCount,
} from '@/src/lib/credits/daily-limit';
import {
  CREDIT_COSTS,
  DAILY_PUSH_LIMIT,
  SMALL_DIFF_THRESHOLD,
} from '@/src/lib/credits/constants';

// extract API rate limit 방어용 동시 호출 상한 (사용자 지시: 3개씩 chunking)
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

// POST /api/agent/push — 에이전트 데이터 수신
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
    return NextResponse.json(
      { error: 'Invalid JSON' },
      { status: 400 }
    );
  }

  // 4. 페이로드 검증
  const validation = validatePayload(body);
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
    return NextResponse.json(
      { error: 'Invalid agent token' },
      { status: 401 }
    );
  }

  // 토큰의 project_id와 payload의 project_id 일치 확인
  if (authResult.project_id !== payload.project_id) {
    return NextResponse.json(
      { error: 'Agent token does not match project_id' },
      { status: 403 }
    );
  }

  // 5.5. HMAC 서명 검증 (에이전트 0.4.0+).
  //   - 둘 다 있음 → 검증, 실패 시 401
  //   - 둘 다 없음 → 경고 로그 + 통과 (0.3.x 하위 호환)
  //   - 하나만 있음 → 400 (malformed)
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
      { error: 'Malformed signature: both X-CodeSasu-Signature and X-CodeSasu-Timestamp required' },
      { status: 400 }
    );
  } else {
    console.warn(
      `[push] HMAC headers missing — agent_version=${payload.metadata.agent_version} project=${payload.project_id} (legacy 0.3.x compatibility)`
    );
  }

  // 6. JSONL 파싱
  let parsed;
  try {
    parsed = parseSession(payload.session_data.jsonl_log);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to parse JSONL', detail: (err as Error).message },
      { status: 400 }
    );
  }

  // 7. 세션 저장 (중복 감지 포함)
  let saveResult;
  try {
    saveResult = await saveSession(payload.project_id, parsed);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to save session', detail: (err as Error).message },
      { status: 500 }
    );
  }

  if ('duplicate' in saveResult) {
    return NextResponse.json(
      { error: 'Duplicate session', existing_session_id: saveResult.existing_session_id },
      { status: 409 }
    );
  }

  const { saved } = saveResult;

  // 7.5. Read tool_result 시그니처 upsert (fire-and-forget, 응답 차단 안 함)
  // 비용 0 정규식 추출. 정적 분석 LLM 경로(run-analysis)와 합집합 머지로 누적.
  if (parsed.file_signatures.length > 0) {
    upsertFileSignatures(payload.project_id, parsed.file_signatures).catch((err) => {
      console.error('[push] regex signatures upsert failed:', (err as Error).message);
    });
  }

  // 8. Ephemeral 데이터 저장 (diffs, file_tree, eslint, source_files)
  //    full_scan 모드일 때만 source_files 저장 (분석 후 즉시 파기)
  const scanMode = payload.metadata.scan_mode ?? 'incremental';
  const hasSourceFiles =
    scanMode === 'full' &&
    Array.isArray(payload.session_data.source_files) &&
    payload.session_data.source_files.length > 0;

  try {
    if (payload.session_data.diffs && payload.session_data.diffs.length > 0) {
      await saveEphemeralDiffs(saved.id, payload.session_data.diffs);
    }
    if (payload.session_data.file_tree && payload.session_data.file_tree.length > 0) {
      await saveEphemeralFileTree(saved.id, payload.session_data.file_tree);
    }
    if (payload.session_data.eslint_results && payload.session_data.eslint_results.length > 0) {
      await saveEphemeralEslint(saved.id, payload.session_data.eslint_results);
    }
    if (hasSourceFiles) {
      await saveEphemeralSourceFiles(saved.id, payload.session_data.source_files!);
    }
  } catch (err) {
    console.error('[push] Ephemeral save failed:', (err as Error).message);
    // ephemeral 저장 실패는 세션 저장에 영향 주지 않음
  }

  // 8.5. diff 파일 경로를 changed_files에 병합
  if (payload.session_data.diffs && payload.session_data.diffs.length > 0) {
    try {
      const diffFiles = payload.session_data.diffs.map((d) => d.file_path);
      await mergeChangedFiles(saved.id, diffFiles);
    } catch (err) {
      console.error('[push] Changed files merge failed:', (err as Error).message);
    }
  }

  // 9. 에이전트 상태 업데이트 + full_scan 플래그 처리
  try {
    await updateAgentStatus(payload.project_id);
  } catch (err) {
    console.error('[push] Agent status update failed:', (err as Error).message);
  }

  // 9.5. first_scan_done / pending_full_scan 처리
  //   - full_scan으로 도착했고 source_files가 있으면 두 플래그 모두 클리어
  //   - full_scan이 아직 안 됐다면 (incremental인데 first_scan_done=false) 응답에 알림 — 에이전트가 다음 idle에 full로 재전송
  let isFirstPush = false;
  let pendingConsumed = false;
  try {
    const adminClient = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const { data: projRow } = await adminClient
      .from('projects')
      .select('first_scan_done, pending_full_scan')
      .eq('id', payload.project_id)
      .single();

    if (projRow) {
      isFirstPush = !projRow.first_scan_done;
      pendingConsumed = projRow.pending_full_scan;

      if (hasSourceFiles) {
        await adminClient
          .from('projects')
          .update({
            first_scan_done: true,
            pending_full_scan: false,
            pending_full_scan_at: null,
          })
          .eq('id', payload.project_id);
      }
    }
  } catch (err) {
    console.error('[push] full_scan flag handling failed:', (err as Error).message);
  }

  // 10. 크레딧 가드 + 자동 파이프라인 트리거
  //   분석 흐름:
  //     diff 0줄        → ESLint만 LLM 호출 없이 실행, 미차감
  //     일일 상한 초과  → 분석 skip
  //     크레딧 부족     → 분석 skip (BYOK 제외)
  //     small diff      → Haiku 경량 분석
  //     normal          → Sonnet 정상 분석
  //   docs sync는 모든 케이스에서 실행 (BYOK이면 유저 키, 아니면 무료 — D 결정)
  const hasDiffs = !!(payload.session_data.diffs && payload.session_data.diffs.length > 0);
  const hasDocs = !!(
    payload.session_data.docs_files && payload.session_data.docs_files.length > 0
  );

  const diffLines = countDiffLines(payload.session_data.diffs);
  const isByok = await hasUserApiKey(authResult.user_id);
  const byokKey = isByok ? await getUserApiKey(authResult.user_id) : null;

  // 분석 skip 사유 결정 (우선순위: no_diff > daily_limit > insufficient_credits)
  let analysisSkipped: 'no_diff' | 'daily_limit' | 'insufficient_credits' | null = null;
  let creditsUsed = 0;

  if (hasDiffs) {
    if (diffLines === 0) {
      analysisSkipped = 'no_diff';
    } else if (await checkDailyLimit(payload.project_id, DAILY_PUSH_LIMIT)) {
      analysisSkipped = 'daily_limit';
    } else if (!isByok) {
      try {
        const info = await getCreditInfo(authResult.user_id);
        if (info.remaining < CREDIT_COSTS.PUSH_ANALYSIS) {
          analysisSkipped = 'insufficient_credits';
        }
      } catch (err) {
        console.error('[push] credit check failed:', (err as Error).message);
        analysisSkipped = 'insufficient_credits';
      }
    }

    // 가드 통과 → daily count 증가 + 크레딧 차감 (선차감)
    if (!analysisSkipped) {
      try {
        await incrementDailyCount(payload.project_id);
      } catch (err) {
        console.error('[push] daily count increment failed:', (err as Error).message);
      }

      if (!isByok) {
        try {
          await deductCredit(authResult.user_id, CREDIT_COSTS.PUSH_ANALYSIS, {
            reason: 'push_analysis',
            projectId: payload.project_id,
            sessionId: saved.id,
          });
          creditsUsed = CREDIT_COSTS.PUSH_ANALYSIS;
        } catch (err) {
          console.error('[push] credit deduction failed:', (err as Error).message);
          analysisSkipped = 'insufficient_credits';
        }
      }
    }
  }

  // 자동 파이프라인 (비동기 — 응답 차단 안 함)
  if (hasDiffs || hasDocs) {
    const useLightModel = diffLines > 0 && diffLines < SMALL_DIFF_THRESHOLD;
    const apiKey = byokKey ?? undefined;
    const runMainAnalysis = hasDiffs && !analysisSkipped;

    (async () => {
      try {
        // 10a. docs sync + 변경된 doc 병렬 extract
        if (hasDocs) {
          try {
            const sync = await syncAgentDocs(
              payload.project_id,
              payload.session_data.docs_files!
            );
            if (sync.errors.length > 0) {
              console.error('[push] docs sync errors:', sync.errors);
            }
            console.log(
              `[push] docs sync: ${sync.changed.length} changed, ${sync.unchanged_count} unchanged, ${sync.deleted_count} soft-deleted`
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
                      `[push] extract ${doc.path} failed: ${result.error}`
                    );
                  } else {
                    console.log(
                      `[push] extract ${doc.path} (${doc.reason}) → ${result.features_count} features (in ${result.token_usage.input}/out ${result.token_usage.output} tokens)`
                    );
                  }
                } catch (err) {
                  console.error(
                    `[push] extract ${doc.path} threw:`,
                    (err as Error).message
                  );
                }
              });
            }
          } catch (err) {
            console.error('[push] docs sync failed:', (err as Error).message);
          }
        }

        // 10b. 분석 — 가드 통과한 경우만 (no_diff 케이스도 ESLint는 runAnalysis 내부에서 처리)
        //      full_scan + source_files 있으면 'full' 모드로 전환 (소스코드 컨텍스트 활용)
        const analysisMode = hasSourceFiles ? 'full' : 'problems_only';
        if (runMainAnalysis) {
          await runAnalysis(payload.project_id, saved.id, analysisMode, {
            useLightModel: hasSourceFiles ? false : useLightModel,
            apiKey,
          });
        } else if (hasDiffs && analysisSkipped === 'no_diff') {
          // diff 0줄 → ESLint만으로 정적 분석 실행 (LLM 호출 없음, 무료)
          await runAnalysis(payload.project_id, saved.id, 'problems_only', {
            useLightModel: true, // 안전 기본값 (LLM 호출은 안 일어남)
            apiKey,
          });
        }

        // 10c. assess (features 1건 이상)
        const adminClient = createClient<Database>(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
        const { count, error: countError } = await adminClient
          .from('spec_features')
          .select('id', { count: 'exact', head: true })
          .eq('project_id', payload.project_id);

        if (countError) {
          console.error('[push] spec_features count failed:', countError.message);
          return;
        }

        if (count && count > 0) {
          // dedupe → assess 순서. dedupe는 LLM 호출 없음 (무료).
          try {
            const dedupe = await dedupeFeaturesForProject(payload.project_id);
            if (dedupe.warnings.length > 0) {
              console.error('[push] dedupe warnings:', dedupe.warnings);
            }
            console.log(
              `[push] dedupe: ${dedupe.checked} checked, ${dedupe.marked} marked as duplicate`
            );
          } catch (err) {
            console.error('[push] dedupe failed:', (err as Error).message);
          }

          await assessFeatures(payload.project_id, {
            sessionId: saved.id,
            useSourceCode: hasSourceFiles,
          });
        }
      } catch (err) {
        console.error('[push] Auto pipeline failed:', (err as Error).message);
      }
    })();
  }

  // 11. 기회적 삭제 (만료된 ephemeral 정리, fire-and-forget)
  cleanupExpiredEphemeral().catch((err) => {
    console.error('[push] Ephemeral cleanup failed:', err.message);
  });

  // 12. 응답 — credits 정보 포함
  let creditsRemaining = 0;
  try {
    const info = await getCreditInfo(authResult.user_id);
    creditsRemaining = info.remaining;
  } catch (err) {
    console.error('[push] credits info failed:', (err as Error).message);
  }

  const dailyCount = await getDailyCount(payload.project_id).catch(() => 0);

  // 에이전트가 보고 다음 push에 source_files를 포함할지 결정하는 플래그.
  //   - first_scan은 부팅 시 source-snapshot 라우트가 책임짐 — 여기서는 신경 안 씀.
  //   - request_full_scan: 사용자가 누른 수동 재분석(pending_full_scan)을 픽업하라고 알려주는 신호.
  //   - pending_consumed: 이번 push가 pending 요청을 소화했음을 알림 (에이전트 로그용).
  const requestFullScan = pendingConsumed && !hasSourceFiles;

  return NextResponse.json(
    {
      success: true,
      session_id: saved.id,
      parsed: {
        title: parsed.title,
        prompts_count: parsed.prompts.length,
        files_changed_count: parsed.changed_files,
        warnings: parsed.warnings,
      },
      credits: {
        used: creditsUsed,
        remaining: creditsRemaining,
        is_byok: isByok,
        daily_count: dailyCount,
        daily_limit: DAILY_PUSH_LIMIT,
      },
      analysis_skipped: analysisSkipped,
      security: {
        signature_verified: signatureVerified,
      },
      scan: {
        mode: scanMode,
        is_first_push: isFirstPush,
        request_full_scan: requestFullScan,
        pending_consumed: pendingConsumed && hasSourceFiles,
      },
    },
    { status: 201 }
  );
}
