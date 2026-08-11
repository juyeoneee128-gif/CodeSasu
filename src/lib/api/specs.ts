import type {
  Feature,
  FeatureItem,
  FeatureStatus,
  SpecDocument,
  SpecDocType,
  SpecFeature,
} from '@/src/lib/mock-data';

interface SpecDocumentRow {
  id: string;
  project_id: string;
  name: string;
  type: SpecDocType;
  file_url: string | null;
  uploaded_at: string;
  created_at: string;
}

export interface SpecFeatureRow {
  id: string;
  project_id: string;
  document_id: string | null;
  name: string;
  source: SpecDocType;
  status: FeatureStatus;
  implemented_items: unknown;
  expected_items: unknown;
  total_items: number;
  related_files: unknown;
  prd_summary: string | null;
  created_at: string;
}

export interface SpecFeatureStats {
  total: number;
  implemented: number;
  partial: number;
  unimplemented: number;
  attention: number;
  implementation_rate: number;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '.');
}

function toSpecDocument(row: SpecDocumentRow): SpecDocument {
  return {
    id: row.id,
    name: row.name,
    uploadedAt: formatDate(row.uploaded_at),
    type: row.type,
  };
}

/**
 * 단일 entry를 항목명(string)으로 정규화. string은 그대로, {name} 객체는 name만 추출.
 * 잘못된 형식은 null.
 */
function entryToName(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (
    entry &&
    typeof entry === 'object' &&
    'name' in entry &&
    typeof (entry as { name: unknown }).name === 'string'
  ) {
    return (entry as { name: string }).name;
  }
  return null;
}

function extractStringNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => entryToName(e))
    .filter((x): x is string => x !== null);
}

/**
 * expected_items + implemented_items를 결합해 UI용 FeatureItem 배열을 만든다.
 *
 * - expectedRaw가 있으면 expected를 기준으로 모든 항목을 표시하고,
 *   implementedRaw에 포함된 이름만 checked=true.
 * - expectedRaw가 비어있는 legacy 데이터는 implementedRaw만 표시 (전부 checked=true).
 *
 * 첫 번째 인자에 객체 배열({name, checked, line?})이 그대로 들어오는 mock 흐름도 지원.
 */
export function normalizeImplementedItems(
  implementedRaw: unknown,
  expectedRaw?: unknown
): FeatureItem[] {
  const expected = extractStringNames(expectedRaw);

  // expected_items가 비어있으면 legacy fallback — implemented만 표시 (모두 checked).
  if (expected.length === 0) {
    if (!Array.isArray(implementedRaw)) return [];
    return implementedRaw
      .map((entry): FeatureItem | null => {
        if (typeof entry === 'string') return { name: entry, checked: true };
        if (
          entry &&
          typeof entry === 'object' &&
          'name' in entry &&
          typeof (entry as { name: unknown }).name === 'string'
        ) {
          const obj = entry as { name: string; line?: number; checked?: boolean };
          return {
            name: obj.name,
            ...(typeof obj.line === 'number' ? { line: obj.line } : {}),
            checked: obj.checked === true,
          };
        }
        return null;
      })
      .filter((x): x is FeatureItem => x !== null);
  }

  // expected 기준 — 모든 항목 표시, implemented에 포함된 이름만 checked=true.
  const implementedNames = new Set(extractStringNames(implementedRaw));
  return expected.map((name) => ({ name, checked: implementedNames.has(name) }));
}

function normalizeRelatedFiles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

/**
 * spec_features 행들을 name 기준으로 병합 → 프론트 SpecFeature[] 반환.
 * 동일 기능이 여러 문서에 나오면 sources 배열로 합침. status/detail은 첫 행 기준.
 */
function groupSpecFeatures(rows: SpecFeatureRow[]): SpecFeature[] {
  const map = new Map<string, SpecFeature>();
  for (const row of rows) {
    const key = row.name.trim();
    if (map.has(key)) {
      const existing = map.get(key)!;
      if (!existing.sources.includes(row.source)) {
        existing.sources.push(row.source);
      }
    } else {
      map.set(key, {
        id: row.id,
        name: row.name,
        sources: [row.source],
        status: row.status,
      });
    }
  }
  return [...map.values()];
}

/**
 * spec_features 행들을 병합 → 현황 탭용 Feature[] 반환.
 * DB에 없는 필드(techStack, lastSession, issueCount)는 placeholder.
 */
export function groupStatusFeatures(rows: SpecFeatureRow[]): Feature[] {
  const map = new Map<string, Feature>();
  for (const row of rows) {
    const key = row.name.trim();
    if (map.has(key)) continue;
    const items = normalizeImplementedItems(row.implemented_items, row.expected_items);
    // totalItems는 expected_items.length 우선이되, implemented_items.length가 더 크면
    // (LLM이 expected 밖 항목을 추가한 legacy 데이터) 보정 — "6/5" 모순 방지.
    const expectedLen = Array.isArray(row.expected_items) ? row.expected_items.length : 0;
    const implementedLen = Array.isArray(row.implemented_items)
      ? row.implemented_items.length
      : 0;
    const total = Math.max(expectedLen, implementedLen, row.total_items);
    map.set(key, {
      id: row.id,
      name: row.name,
      status: row.status,
      implementedItems: items,
      totalItems: total,
      issueCount: 0,
      lastSession: '-',
      techStack: '',
      relatedFiles: normalizeRelatedFiles(row.related_files),
      prdSummary: row.prd_summary ?? undefined,
    });
  }

  // 현황 탭 UX: 작업이 남은 것 우선 → 완료는 마지막.
  // 같은 status 내에서는 한국어 가나다순으로 안정 정렬.
  const STATUS_ORDER: Record<FeatureStatus, number> = {
    partial: 0,
    attention: 1,
    unimplemented: 2,
    implemented: 3,
  };
  return [...map.values()].sort((a, b) => {
    const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (so !== 0) return so;
    return a.name.localeCompare(b.name, 'ko');
  });
}

// ─── 문서 ───

export async function fetchSpecDocuments(projectId: string): Promise<SpecDocument[]> {
  const res = await fetch(`/api/projects/${projectId}/specs/documents`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '문서 목록을 불러올 수 없습니다');
  }
  const data: { documents: SpecDocumentRow[] } = await res.json();
  return data.documents.map(toSpecDocument);
}

export async function createSpecDocument(
  projectId: string,
  payload: { name: string; type: SpecDocType; content: string }
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/specs/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '문서 업로드에 실패했습니다');
  }
}

export async function deleteSpecDocument(
  projectId: string,
  docId: string
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/specs/documents/${docId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '문서 삭제에 실패했습니다');
  }
}

// ─── 기능 ───

export async function fetchSpecFeatures(
  projectId: string
): Promise<{ features: SpecFeature[]; stats: SpecFeatureStats }> {
  const res = await fetch(`/api/projects/${projectId}/specs/features`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '기능 목록을 불러올 수 없습니다');
  }
  const data: { features: SpecFeatureRow[]; stats: SpecFeatureStats } = await res.json();
  return {
    features: groupSpecFeatures(data.features),
    stats: data.stats,
  };
}

export async function fetchStatusFeatures(
  projectId: string
): Promise<{ features: Feature[]; stats: SpecFeatureStats }> {
  const res = await fetch(`/api/projects/${projectId}/specs/features`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '기능 목록을 불러올 수 없습니다');
  }
  const data: { features: SpecFeatureRow[]; stats: SpecFeatureStats } = await res.json();
  return {
    features: groupStatusFeatures(data.features),
    stats: data.stats,
  };
}

// ─── PRD 대조 재실행 ───

export async function assessFeatures(projectId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/specs/features/assess`, {
    method: 'POST',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '구현 현황 재분석에 실패했습니다');
  }
}
