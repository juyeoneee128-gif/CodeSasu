import { describe, it, expect } from 'vitest';
import {
  chunkFeatures,
  ASSESS_CHUNK_SIZE,
  computeStatusFromCounts,
} from '../assess-features';

/**
 * chunkFeatures는 assess-features의 LLM 호출과 분리해 단위 검증이 가능하도록
 * 분리·export한 순수 함수. 단일 호출에서 100+ 기능을 평가하면 출력 토큰이
 * 16k를 초과해 잘리는 회귀를 막기 위해, 분할 경계 동작을 강하게 보호한다.
 */
describe('chunkFeatures', () => {
  it('정확히 chunkSize와 같으면 1개 chunk를 만든다 (경계 — 정상)', () => {
    const items = Array.from({ length: ASSESS_CHUNK_SIZE }, (_, i) => `f${i}`);
    const chunks = chunkFeatures(items, ASSESS_CHUNK_SIZE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(ASSESS_CHUNK_SIZE);
  });

  it('109개를 50개씩 나누면 [50, 50, 9] 분포 (실제 사례 — 엣지)', () => {
    const items = Array.from({ length: 109 }, (_, i) => `f${i}`);
    const chunks = chunkFeatures(items, 50);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 9]);
    // 합산 시 누락·중복 없어야 함
    const flat = chunks.flat();
    expect(flat).toHaveLength(109);
    expect(new Set(flat).size).toBe(109);
    // 순서가 보존되어 feature_id 매칭 시 누락 방지
    expect(flat[0]).toBe('f0');
    expect(flat[108]).toBe('f108');
  });

  it('빈 배열은 빈 chunks를 반환 (엣지)', () => {
    expect(chunkFeatures([], 50)).toEqual([]);
  });

  it('chunkSize=0 또는 음수는 에러 (방어 — 에러)', () => {
    expect(() => chunkFeatures(['a'], 0)).toThrow('positive');
    expect(() => chunkFeatures(['a'], -1)).toThrow('positive');
  });

  it('chunkSize보다 작은 입력은 1개 chunk로 모두 포함 (작은 입력 — 엣지)', () => {
    const chunks = chunkFeatures(['a', 'b', 'c'], 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(['a', 'b', 'c']);
  });
});

/**
 * status는 LLM 라벨 대신 코드가 length 비교로 산출하여 비결정성을 차단.
 * 같은 expected/implemented_items면 항상 같은 status가 나와야 구현율 변동이 사라진다.
 */
describe('computeStatusFromCounts', () => {
  it('impl === exp이면 implemented (정상)', () => {
    expect(computeStatusFromCounts(4, 4)).toBe('implemented');
    expect(computeStatusFromCounts(1, 1)).toBe('implemented');
  });

  it('0 < impl < exp이면 partial (정상)', () => {
    expect(computeStatusFromCounts(3, 5)).toBe('partial');
    expect(computeStatusFromCounts(1, 10)).toBe('partial');
  });

  it('impl === 0 또는 exp === 0이면 unimplemented (경계)', () => {
    expect(computeStatusFromCounts(0, 5)).toBe('unimplemented');
    expect(computeStatusFromCounts(0, 0)).toBe('unimplemented');
    // exp === 0이지만 impl > 0인 비정상 케이스도 unimplemented로 안전하게 처리
    expect(computeStatusFromCounts(3, 0)).toBe('unimplemented');
  });

  it('impl > exp 비정상 케이스에서도 implemented로 흡수 (에러 방어)', () => {
    // 호출 측에서 사전 필터링하면 발생하지 않지만, 방어선으로 implemented 처리.
    expect(computeStatusFromCounts(6, 5)).toBe('implemented');
  });
});
