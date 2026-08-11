import { NextResponse } from 'next/server';
import { createClient } from '@/src/lib/supabase/server';
import {
  buildSessionMarkdown,
  slugifyTitle,
  type ParsedSummary,
} from '@/src/lib/sessions/export-markdown';

type Params = { params: Promise<{ id: string; sessionId: string }> };

// GET /api/projects/[id]/sessions/[sessionId]/export — 세션을 마크다운 파일로 다운로드
export async function GET(_request: Request, { params }: Params) {
  const { id: projectId, sessionId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

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

  const { data: session, error } = await supabase
    .from('sessions')
    .select(
      'number, title, created_at, duration_seconds, prompt_count, total_tokens, files_changed, changed_files, prompts, parsed_summary'
    )
    .eq('id', sessionId)
    .eq('project_id', projectId)
    .single();

  if (error || !session) {
    return NextResponse.json({ error: '세션을 찾을 수 없습니다' }, { status: 404 });
  }

  const markdown = buildSessionMarkdown({
    number: session.number,
    title: session.title,
    created_at: session.created_at,
    duration_seconds: session.duration_seconds,
    prompt_count: session.prompt_count,
    total_tokens: session.total_tokens,
    files_changed: session.files_changed,
    changed_files: (session.changed_files as unknown as string[]) ?? [],
    prompts: (session.prompts as unknown as string[]) ?? [],
    parsed_summary: (session.parsed_summary as unknown as ParsedSummary | null) ?? null,
  });

  const slug = slugifyTitle(session.title);
  const asciiFilename = `session-${session.number}.md`;
  const utf8Filename = slug
    ? `session-${session.number}-${slug}.md`
    : asciiFilename;
  const disposition =
    `attachment; filename="${asciiFilename}"; ` +
    `filename*=UTF-8''${encodeURIComponent(utf8Filename)}`;

  return new NextResponse(markdown, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': disposition,
    },
  });
}
