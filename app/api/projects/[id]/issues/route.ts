import { NextResponse } from 'next/server';
import { createClient } from '@/src/lib/supabase/server';

type Params = { params: Promise<{ id: string }> };

// GET /api/projects/[id]/issues — 이슈 목록 + 카운트
export async function GET(request: Request, { params }: Params) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다' }, { status: 401 });
  }

  // 프로젝트 소유권 확인
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single();

  if (!project) {
    return NextResponse.json({ error: '프로젝트를 찾을 수 없습니다' }, { status: 404 });
  }

  // 쿼리 파라미터 파싱
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status')?.split(',').filter(Boolean);
  const levelFilter = url.searchParams.get('level')?.split(',').filter(Boolean);

  // 전체 이슈 조회 (카운트 계산용)
  let query = supabase
    .from('issues')
    .select('*')
    .eq('project_id', projectId)
    .order('detected_at', { ascending: false });

  const { data: allIssues, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const all = allIssues ?? [];

  // 카운트 계산
  const counts = {
    total: all.length,
    by_status: {
      unconfirmed: all.filter((i) => i.status === 'unconfirmed').length,
      confirmed: all.filter((i) => i.status === 'confirmed').length,
      resolved: all.filter((i) => i.status === 'resolved').length,
      auto_resolved: all.filter((i) => i.status === 'auto_resolved').length,
    },
    by_level: {
      critical: all.filter((i) => i.level === 'critical').length,
      warning: all.filter((i) => i.level === 'warning').length,
      info: all.filter((i) => i.level === 'info').length,
    },
  };

  // 필터링
  let filtered = all;
  if (statusFilter && statusFilter.length > 0) {
    filtered = filtered.filter((i) => statusFilter.includes(i.status));
  }
  if (levelFilter && levelFilter.length > 0) {
    filtered = filtered.filter((i) => levelFilter.includes(i.level));
  }

  // 정렬: unconfirmed → confirmed → auto_resolved → resolved, 같은 status 내 detected_at DESC
  const statusOrder: Record<string, number> = {
    unconfirmed: 0,
    confirmed: 1,
    auto_resolved: 2,
    resolved: 3,
  };
  filtered.sort((a, b) => {
    const statusDiff = (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4);
    if (statusDiff !== 0) return statusDiff;
    return new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime();
  });

  return NextResponse.json({ issues: filtered, counts });
}
