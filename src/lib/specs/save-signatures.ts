import { createClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';

function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export interface FileSignature {
  file_path: string;
  functions: string[];
  imports: string[];
  exports: string[];
  patterns: string[];
  line_count: number;
}

export interface UpsertSignaturesResult {
  inserted: number;
  updated: number;
  warnings: string[];
}

const BATCH_SIZE = 50;

/**
 * 파일 시그니처를 합집합 머지로 UPSERT합니다.
 *
 * - 기존 row가 있으면: functions/imports/exports/patterns SET 합집합, line_count는 max, last_seen_at은 now
 * - 없으면 INSERT
 * - 정적 분석(LLM)과 정규식 경로 양쪽에서 호출되므로 같은 파일이 두 번 들어와도 합집합으로 머지
 *
 * 합집합 전략 이유: LLM이 diff 일부만 보고 시그니처를 partial하게 추출하면 정보 손실 위험.
 * stale 함수가 누적될 수 있으나 last_seen_at으로 cutoff cron 처리(별도 작업).
 */
export async function upsertFileSignatures(
  projectId: string,
  signatures: FileSignature[]
): Promise<UpsertSignaturesResult> {
  if (signatures.length === 0) {
    return { inserted: 0, updated: 0, warnings: [] };
  }

  const supabase = createAdminClient();
  const warnings: string[] = [];
  let inserted = 0;
  let updated = 0;

  // 같은 push 안에 같은 file_path가 여러 번 들어오면 미리 dedup·머지
  const grouped = new Map<string, FileSignature>();
  for (const sig of signatures) {
    const existing = grouped.get(sig.file_path);
    if (!existing) {
      grouped.set(sig.file_path, normalizeSignature(sig));
      continue;
    }
    grouped.set(sig.file_path, mergeSignatures(existing, normalizeSignature(sig)));
  }

  const merged = Array.from(grouped.values());

  for (let i = 0; i < merged.length; i += BATCH_SIZE) {
    const batch = merged.slice(i, i + BATCH_SIZE);
    const paths = batch.map((s) => s.file_path);

    const { data: existingRows, error: queryError } = await supabase
      .from('file_signatures')
      .select('file_path, functions, imports, exports, patterns, line_count')
      .eq('project_id', projectId)
      .in('file_path', paths);

    if (queryError) {
      warnings.push(`Failed to load existing signatures: ${queryError.message}`);
      continue;
    }

    const byPath = new Map<string, FileSignature>();
    for (const row of existingRows ?? []) {
      byPath.set(row.file_path, {
        file_path: row.file_path,
        functions: row.functions ?? [],
        imports: row.imports ?? [],
        exports: row.exports ?? [],
        patterns: row.patterns ?? [],
        line_count: row.line_count ?? 0,
      });
    }

    const nowIso = new Date().toISOString();

    for (const sig of batch) {
      const existing = byPath.get(sig.file_path);

      if (existing) {
        const mergedSig = mergeSignatures(existing, sig);
        const { error: updateError } = await supabase
          .from('file_signatures')
          .update({
            functions: mergedSig.functions,
            imports: mergedSig.imports,
            exports: mergedSig.exports,
            patterns: mergedSig.patterns,
            line_count: mergedSig.line_count,
            last_seen_at: nowIso,
          })
          .eq('project_id', projectId)
          .eq('file_path', sig.file_path);

        if (updateError) {
          warnings.push(`Failed to update ${sig.file_path}: ${updateError.message}`);
          continue;
        }
        updated++;
      } else {
        const { error: insertError } = await supabase
          .from('file_signatures')
          .insert({
            project_id: projectId,
            file_path: sig.file_path,
            functions: sig.functions,
            imports: sig.imports,
            exports: sig.exports,
            patterns: sig.patterns,
            line_count: sig.line_count,
            last_seen_at: nowIso,
          });

        if (insertError) {
          warnings.push(`Failed to insert ${sig.file_path}: ${insertError.message}`);
          continue;
        }
        inserted++;
      }
    }
  }

  return { inserted, updated, warnings };
}

function normalizeSignature(sig: FileSignature): FileSignature {
  return {
    file_path: sig.file_path,
    functions: dedup(sig.functions),
    imports: dedup(sig.imports),
    exports: dedup(sig.exports),
    patterns: dedup(sig.patterns),
    line_count: Math.max(0, Math.floor(sig.line_count ?? 0)),
  };
}

function mergeSignatures(a: FileSignature, b: FileSignature): FileSignature {
  return {
    file_path: a.file_path,
    functions: dedup([...a.functions, ...b.functions]),
    imports: dedup([...a.imports, ...b.imports]),
    exports: dedup([...a.exports, ...b.exports]),
    patterns: dedup([...a.patterns, ...b.patterns]),
    line_count: Math.max(a.line_count, b.line_count),
  };
}

function dedup(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
