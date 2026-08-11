import { createClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import type { DiffEntry, FileTreeEntry, EslintIssueRaw, SourceFile } from './validate-payload';

type EphemeralDataType = Database['public']['Tables']['ephemeral_data']['Row']['data_type'];

function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * diff 데이터를 ephemeral_data에 저장합니다.
 */
export async function saveEphemeralDiffs(
  sessionId: string,
  diffs: DiffEntry[]
): Promise<void> {
  if (diffs.length === 0) return;

  const supabase = createAdminClient();

  const rows = diffs.map((diff) => ({
    session_id: sessionId,
    data_type: 'diff' as EphemeralDataType,
    content: diff as unknown as Database['public']['Tables']['ephemeral_data']['Insert']['content'],
  }));

  const { error } = await supabase.from('ephemeral_data').insert(rows);

  if (error) {
    throw new Error(`Failed to save ephemeral diffs: ${error.message}`);
  }
}

/**
 * ESLint 결과를 ephemeral_data에 저장합니다.
 * 결과 전체를 단일 row의 content(JSONB)에 array로 저장 — 분석 시 한번에 로드.
 */
export async function saveEphemeralEslint(
  sessionId: string,
  results: EslintIssueRaw[]
): Promise<void> {
  if (results.length === 0) return;

  const supabase = createAdminClient();

  const { error } = await supabase.from('ephemeral_data').insert({
    session_id: sessionId,
    data_type: 'eslint' as EphemeralDataType,
    content: results as unknown as Database['public']['Tables']['ephemeral_data']['Insert']['content'],
  });

  if (error) {
    throw new Error(`Failed to save ephemeral eslint results: ${error.message}`);
  }
}

/**
 * file_tree 데이터를 ephemeral_data에 저장합니다.
 */
export async function saveEphemeralFileTree(
  sessionId: string,
  fileTree: FileTreeEntry[]
): Promise<void> {
  if (fileTree.length === 0) return;

  const supabase = createAdminClient();

  const { error } = await supabase.from('ephemeral_data').insert({
    session_id: sessionId,
    data_type: 'file_tree' as EphemeralDataType,
    content: fileTree as unknown as Database['public']['Tables']['ephemeral_data']['Insert']['content'],
  });

  if (error) {
    throw new Error(`Failed to save ephemeral file tree: ${error.message}`);
  }
}

/**
 * 전체 스캔(full_scan) 시 수신한 소스 파일을 ephemeral_data에 저장합니다.
 * 파일당 1 row. 분석 완료 후 즉시 삭제 — DB 영구 저장 안 함.
 */
export async function saveEphemeralSourceFiles(
  sessionId: string,
  sourceFiles: SourceFile[]
): Promise<void> {
  if (sourceFiles.length === 0) return;

  const supabase = createAdminClient();

  const rows = sourceFiles.map((file) => ({
    session_id: sessionId,
    data_type: 'source_file' as EphemeralDataType,
    content: file as unknown as Database['public']['Tables']['ephemeral_data']['Insert']['content'],
  }));

  const { error } = await supabase.from('ephemeral_data').insert(rows);

  if (error) {
    throw new Error(`Failed to save ephemeral source files: ${error.message}`);
  }
}

/**
 * 세션에 저장된 소스 파일을 조회합니다. (full_scan 분석/assess 경로용)
 */
export async function getEphemeralSourceFiles(sessionId: string): Promise<SourceFile[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('ephemeral_data')
    .select('content')
    .eq('session_id', sessionId)
    .eq('data_type', 'source_file');

  if (error) {
    throw new Error(`Failed to get ephemeral source files: ${error.message}`);
  }

  const files: SourceFile[] = [];
  for (const row of data ?? []) {
    const c = row.content as Record<string, unknown> | null;
    if (
      c &&
      typeof c.path === 'string' &&
      typeof c.content === 'string' &&
      typeof c.line_count === 'number'
    ) {
      files.push({ path: c.path, content: c.content, line_count: c.line_count });
    }
  }
  return files;
}

/**
 * 세션의 ephemeral 데이터를 조회합니다. (Tier 3 분석 엔진용)
 */
export async function getEphemeral(sessionId: string) {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('ephemeral_data')
    .select('*')
    .eq('session_id', sessionId);

  if (error) {
    throw new Error(`Failed to get ephemeral data: ${error.message}`);
  }

  return data ?? [];
}

/**
 * 세션의 ephemeral 데이터를 삭제합니다. (분석 완료 후 호출)
 */
export async function deleteEphemeral(sessionId: string): Promise<number> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('ephemeral_data')
    .delete()
    .eq('session_id', sessionId)
    .select('id');

  if (error) {
    throw new Error(`Failed to delete ephemeral data: ${error.message}`);
  }

  return data?.length ?? 0;
}

/**
 * 만료된 ephemeral 데이터를 일괄 삭제합니다. (Cron + 기회적 삭제)
 */
export async function cleanupExpiredEphemeral(): Promise<{ deleted: number }> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('ephemeral_data')
    .delete()
    .lt('expires_at', new Date().toISOString())
    .select('id');

  if (error) {
    console.error('[ephemeral cleanup] Error:', error.message);
    return { deleted: 0 };
  }

  const deleted = data?.length ?? 0;
  if (deleted > 0) {
    console.log(`[ephemeral cleanup] Deleted ${deleted} expired rows at ${new Date().toISOString()}`);
  }

  return { deleted };
}
