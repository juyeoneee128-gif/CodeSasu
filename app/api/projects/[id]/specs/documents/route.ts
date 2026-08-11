import { NextResponse } from 'next/server';
import { createClient } from '@/src/lib/supabase/server';
import { extractAndSaveFeatures } from '@/src/lib/specs/extract-features';
import { assessFeatures } from '@/src/lib/specs/assess-features';
import { dedupeFeaturesForProject } from '@/src/lib/specs/dedupe-features';

type Params = { params: Promise<{ id: string }> };

// GET /api/projects/[id]/specs/documents — 문서 목록
export async function GET(_request: Request, { params }: Params) {
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

  const { data: documents, error } = await supabase
    .from('spec_documents')
    .select('*')
    .eq('project_id', projectId)
    .order('uploaded_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ documents: documents ?? [] });
}

// POST /api/projects/[id]/specs/documents — 문서 업로드 + 기능 추출
export async function POST(request: Request, { params }: Params) {
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

  const body = await request.json();
  const { name, type, content } = body;

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'name은 필수입니다' }, { status: 400 });
  }
  if (!type || !['FRD', 'PRD'].includes(type)) {
    return NextResponse.json({ error: 'type은 "FRD" 또는 "PRD"만 허용됩니다' }, { status: 400 });
  }
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return NextResponse.json({ error: 'content는 필수입니다' }, { status: 400 });
  }

  try {
    const result = await extractAndSaveFeatures(projectId, name, type, content);

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // 이번 업로드로 features가 추출됐으면 dedupe → assess를 fire-and-forget으로 트리거.
    // 자동 호출이라 유저 통제 불가 → 무료 (assessFeatures 자체에 크레딧 차감 없음).
    if (result.features_count > 0) {
      (async () => {
        try {
          const dedupe = await dedupeFeaturesForProject(projectId);
          if (dedupe.warnings.length > 0) {
            console.error('[specs/documents POST] dedupe warnings:', dedupe.warnings);
          }
        } catch (err) {
          console.error(
            '[specs/documents POST] dedupe failed:',
            (err as Error).message
          );
        }
        try {
          await assessFeatures(projectId);
        } catch (err) {
          console.error(
            '[specs/documents POST] assessFeatures failed:',
            (err as Error).message
          );
        }
      })();
    }

    return NextResponse.json({
      success: true,
      ...result,
    }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: 'Feature extraction failed', detail: (err as Error).message },
      { status: 500 }
    );
  }
}
