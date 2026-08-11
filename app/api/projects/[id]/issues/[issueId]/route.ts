import { NextResponse } from 'next/server';
import { createClient } from '@/src/lib/supabase/server';
import { generateGuidelineFromIssue } from '@/src/lib/analysis/generate-guideline';

type Params = { params: Promise<{ id: string; issueId: string }> };

// ─── 공통: 프로젝트 소유권 + 이슈 존재 확인 ───

async function verifyIssueAccess(projectId: string, issueId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return { error: '인증이 필요합니다', status: 401 } as const;

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single();

  if (!project) return { error: '프로젝트를 찾을 수 없습니다', status: 404 } as const;

  const { data: issue } = await supabase
    .from('issues')
    .select('*')
    .eq('id', issueId)
    .eq('project_id', projectId)
    .single();

  if (!issue) return { error: '이슈를 찾을 수 없습니다', status: 404 } as const;

  return { supabase, user, issue } as const;
}

// GET /api/projects/[id]/issues/[issueId] — 이슈 상세
export async function GET(_request: Request, { params }: Params) {
  const { id: projectId, issueId } = await params;
  const result = await verifyIssueAccess(projectId, issueId);

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result.issue);
}

// PATCH /api/projects/[id]/issues/[issueId] — 상태 전이
export async function PATCH(request: Request, { params }: Params) {
  const { id: projectId, issueId } = await params;
  const result = await verifyIssueAccess(projectId, issueId);

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const { supabase, issue } = result;
  const body = await request.json();
  const { status: newStatus } = body;

  // 상태 전이 규칙 검증
  const validTransitions: Record<string, string[]> = {
    unconfirmed: ['confirmed'],
    confirmed: ['resolved'],
    resolved: [], // resolved에서는 사용자가 수동 전이 불가 (재감지만 Tier 3이 수행)
    auto_resolved: ['confirmed', 'unconfirmed'], // "확인" 또는 "아직 안 고쳐졌어" 되돌리기
  };

  if (!newStatus || !validTransitions[issue.status]?.includes(newStatus)) {
    return NextResponse.json(
      {
        error: `"${issue.status}" → "${newStatus}" 전이는 허용되지 않습니다`,
        allowed: validTransitions[issue.status],
      },
      { status: 400 }
    );
  }

  // 상태 업데이트
  const updates: Record<string, unknown> = { status: newStatus };

  if (newStatus === 'confirmed') {
    updates.confirmed_at = new Date().toISOString();
  } else if (newStatus === 'resolved') {
    updates.resolved_at = new Date().toISOString();
  }

  const { data: updated, error: updateError } = await supabase
    .from('issues')
    .update(updates as any)
    .eq('id', issueId)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // "확인 완료" 시 보호 규칙 자동 생성
  let guidelineSuggestion = null;

  if (newStatus === 'confirmed') {
    try {
      const guidelineResult = await generateGuidelineFromIssue(issueId);
      if (!guidelineResult.error) {
        guidelineSuggestion = {
          guideline_id: guidelineResult.guideline_id,
          title: guidelineResult.title,
          rule: guidelineResult.rule,
        };
      }
    } catch (err) {
      console.error('[issues PATCH] Guideline generation failed:', (err as Error).message);
    }
  }

  return NextResponse.json({
    success: true,
    issue: updated,
    guideline_suggestion: guidelineSuggestion,
  });
}

// DELETE /api/projects/[id]/issues/[issueId] — 이슈 삭제
export async function DELETE(_request: Request, { params }: Params) {
  const { id: projectId, issueId } = await params;
  const result = await verifyIssueAccess(projectId, issueId);

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const { error } = await result.supabase
    .from('issues')
    .delete()
    .eq('id', issueId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
