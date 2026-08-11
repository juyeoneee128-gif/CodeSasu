import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/src/lib/supabase/types';
import { extractBearerToken, verifyAgentToken } from '@/src/lib/agent/auth-agent';

// GET /api/agent/check — 에이전트 polling endpoint
//   에이전트가 60초마다 호출하여 pending_full_scan / first_scan_done 상태를 확인.
//   true이면 다음 push에 source_files를 포함하여 전송.
//   응답에 코드/소스는 포함되지 않음 — 플래그만 반환하므로 비용/대역폭 최소.
export async function GET(request: Request) {
  const token = extractBearerToken(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json(
      { error: 'Missing or invalid Authorization header' },
      { status: 401 }
    );
  }

  const auth = await verifyAgentToken(token);
  if (!auth) {
    return NextResponse.json({ error: 'Invalid agent token' }, { status: 401 });
  }

  const adminClient = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data, error } = await adminClient
    .from('projects')
    .select('first_scan_done, pending_full_scan, pending_full_scan_at')
    .eq('id', auth.project_id)
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: 'Project not found', detail: error?.message },
      { status: 404 }
    );
  }

  // first_scan은 부팅 시 source-snapshot 라우트가 처리 — check는 수동 재분석(pending)만 책임진다.
  // 다만 first_scan_done은 부팅 경로에서 멱등성 판단에 사용하므로 응답에 그대로 노출.
  const requestFullScan = data.pending_full_scan;

  return NextResponse.json({
    project_id: auth.project_id,
    request_full_scan: requestFullScan,
    first_scan_done: data.first_scan_done,
    pending_full_scan: data.pending_full_scan,
    pending_full_scan_at: data.pending_full_scan_at,
  });
}
