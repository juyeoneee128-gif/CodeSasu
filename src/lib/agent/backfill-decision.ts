/**
 * source-snapshot 라우트의 backfill 분기 결정 로직.
 *
 * 다음 두 케이스 모두에서 docs 재추출이 필요하므로 backfill을 발동해야 한다:
 *
 *   1) legacyFeatureCount > 0
 *      expected_items가 비어있는 features가 있음. 마이그레이션 018 이전에 추출된
 *      legacy 데이터 — 새 형식으로 다시 채워야 함.
 *
 *   2) existingFeatureCount === 0
 *      spec_features 자체가 비어있음. 첫 부팅 스캔 또는 사용자가 수동 삭제한 경우.
 *      이 분기를 빠뜨리면 spec_documents.content_hash가 그대로 남아있을 때
 *      syncAgentDocs가 모든 doc을 unchanged로 판정 → extract 0회 → "No features to assess".
 *
 * 두 케이스 모두 발동 시 호출 측은 spec_documents.content_hash를 null로 리셋하여
 * syncAgentDocs가 강제로 changed 분기를 타도록 만들어야 한다.
 */
export function shouldBackfillFeatures(
  existingFeatureCount: number | null | undefined,
  legacyFeatureCount: number
): boolean {
  if (legacyFeatureCount > 0) return true;
  if ((existingFeatureCount ?? 0) === 0) return true;
  return false;
}
