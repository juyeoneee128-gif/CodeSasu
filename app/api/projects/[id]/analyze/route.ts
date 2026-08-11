import { NextResponse } from 'next/server';
import { createClient } from '@/src/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import type { Database } from '@/src/lib/supabase/types';

type Params = { params: Promise<{ id: string }> };

// POST /api/projects/[id]/analyze — 수동 재분석 트리거
//   기존: 즉시 runAnalysis 실행 (현재 세션의 diff만 사용)
//   변경: projects.pending_full_scan=true 마킹 → 에이전트가 polling으로 픽업 →
//         다음 idle 시 source_files 포함하여 push → 자동 파이프라인이 'full' 모드로 분석
//   크레딧 차감은 실제 분석이 일어나는 push 라우트에서 수행 (선차감 X).
export async function POST(_request: Request, { params }: Params) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다' }, { status: 401 });
  }

  // 프로젝트 소유권 확인 + 에이전트 연결 상태 확인
  const { data: project } = await supabase
    .from('projects')
    .select('id, agent_status, agent_last_seen, pending_full_scan, pending_full_scan_at')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single();

  if (!project) {
    return NextResponse.json({ error: '프로젝트를 찾을 수 없습니다' }, { status: 404 });
  }

  if (project.agent_status !== 'connected') {
    return NextResponse.json(
      {
        error: '에이전트가 연결되어 있지 않습니다. 에이전트를 실행한 뒤 다시 시도하세요.',
        agent_status: project.agent_status,
      },
      { status: 409 }
    );
  }

  // service_role로 업데이트 (RLS 우회 — pending 플래그는 사용자 권한 외 컬럼)
  const admin = createAdminClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const nowIso = new Date().toISOString();
  const { error: updateError } = await admin
    .from('projects')
    .update({
      pending_full_scan: true,
      pending_full_scan_at: nowIso,
    })
    .eq('id', projectId);

  if (updateError) {
    console.error('[analyze] pending flag set failed:', updateError.message);
    return NextResponse.json(
      { error: '재분석 요청을 등록하지 못했습니다', detail: updateError.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    pending: true,
    message:
      '에이전트가 다음 폴링(최대 60초)에서 요청을 픽업하여 전체 분석을 시작합니다.',
    pending_full_scan_at: nowIso,
  });
}
