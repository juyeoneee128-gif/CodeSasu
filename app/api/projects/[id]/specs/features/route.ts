import { NextResponse } from 'next/server';
import { createClient } from '@/src/lib/supabase/server';

type Params = { params: Promise<{ id: string }> };

// GET /api/projects/[id]/specs/features — 기능 목록 + 현황 통계
// ?include_duplicates=true 면 중복 마킹된 항목까지 포함하여 반환
export async function GET(request: Request, { params }: Params) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: '인증이 필요합니다' }, { status: 401 });
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single();

  if (!project) {
    return NextResponse.json({ error: '프로젝트를 찾을 수 없습니다' }, { status: 404 });
  }

  const url = new URL(request.url);
  const includeDuplicates = url.searchParams.get('include_duplicates') === 'true';

  let query = supabase
    .from('spec_features')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (!includeDuplicates) {
    query = query.eq('is_duplicate', false);
  }

  const { data: features, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const all = features ?? [];
  // stats는 include_duplicates와 무관하게 항상 active 기준
  const active = includeDuplicates ? all.filter((f) => !f.is_duplicate) : all;

  const stats = {
    total: active.length,
    implemented: active.filter((f) => f.status === 'implemented').length,
    partial: active.filter((f) => f.status === 'partial').length,
    unimplemented: active.filter((f) => f.status === 'unimplemented').length,
    attention: active.filter((f) => f.status === 'attention').length,
    implementation_rate: 0,
  };

  if (stats.total > 0) {
    stats.implementation_rate = Math.round(
      ((stats.implemented + stats.partial * 0.5) / stats.total) * 100
    );
  }

  return NextResponse.json({ features: all, stats });
}
