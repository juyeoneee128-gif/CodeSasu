import { describe, it, expect } from 'vitest';
import { shouldBackfillFeatures } from '../backfill-decision';

/**
 * 회귀 사례:
 *   사용자가 spec_features를 수동 삭제(existingFeatureCount=0) + first_scan_done 리셋 후
 *   부팅 스캔을 트리거했을 때, 백필 분기가 발동하지 않아 content_hash 리셋이 누락되고
 *   syncAgentDocs가 모든 doc을 unchanged로 판정 → extract 0회 → "No features to assess"로 종료.
 *
 *   원인은 분기 조건이 `legacyFeatureCount > 0`만 보고 `existingFeatureCount === 0`을
 *   별도로 검사하지 않았기 때문. 이 함수는 두 케이스를 모두 발동시켜야 한다.
 */
describe('shouldBackfillFeatures', () => {
  it('legacy features가 1개라도 있으면 발동 (정상)', () => {
    expect(shouldBackfillFeatures(109, 5)).toBe(true);
    expect(shouldBackfillFeatures(50, 1)).toBe(true);
  });

  it('existingFeatureCount=0이면 발동 — 수동 삭제 케이스 회귀 보호 (핵심)', () => {
    // 사용자가 DELETE FROM spec_features 한 직후 부팅 스캔 시나리오.
    // legacyCount도 자연스럽게 0이지만 content_hash 리셋이 필요하므로 backfill 발동 필수.
    expect(shouldBackfillFeatures(0, 0)).toBe(true);
  });

  it('existingFeatureCount=null/undefined도 0으로 취급해 발동 (방어 — 엣지)', () => {
    expect(shouldBackfillFeatures(null, 0)).toBe(true);
    expect(shouldBackfillFeatures(undefined, 0)).toBe(true);
  });

  it('features 있고 legacy 없으면 backfill 미발동 — 정상 상태 (경계)', () => {
    // 백필 완료 후 모든 후속 부팅 스캔이 여기로 빠져야 함. 멱등성의 핵심.
    expect(shouldBackfillFeatures(109, 0)).toBe(false);
    expect(shouldBackfillFeatures(1, 0)).toBe(false);
  });
});
