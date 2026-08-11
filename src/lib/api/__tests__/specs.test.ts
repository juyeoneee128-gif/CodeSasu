import { describe, it, expect } from 'vitest';
import {
  normalizeImplementedItems,
  groupStatusFeatures,
  type SpecFeatureRow,
} from '../specs';

/**
 * normalizeImplementedItems는 spec_features.implemented_items 컬럼(JSONB)을
 * UI FeatureItem 배열로 변환한다.
 *
 * 두 가지 입력 형식을 모두 수용해야 한다:
 *  1) LLM이 반환하는 실제 형식: 단순 문자열 배열 ["이메일 로그인", "세션 관리"]
 *  2) mock/옛 데이터 호환: { name, line?, checked } 객체 배열
 *
 * 1번이 빠지면 현황 탭이 "0/N"으로 표시되는 회귀가 발생하므로 강하게 보호.
 */
describe('normalizeImplementedItems', () => {
  it('string[] 입력을 모든 항목 checked=true인 FeatureItem[]로 변환한다 (LLM 형식 — 정상)', () => {
    const result = normalizeImplementedItems([
      '이메일 로그인',
      '소셜 로그인(Google)',
      '세션 관리',
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ name: '이메일 로그인', checked: true });
    expect(result[1]).toEqual({ name: '소셜 로그인(Google)', checked: true });
    expect(result[2]).toEqual({ name: '세션 관리', checked: true });
    // line 필드는 LLM이 반환하지 않으므로 누락되어야 함
    expect(result[0]).not.toHaveProperty('line');
  });

  it('{name, line?, checked} 객체 배열도 그대로 받는다 (mock 호환 — 정상)', () => {
    const result = normalizeImplementedItems([
      { name: 'Google OAuth 로그인', line: 15, checked: true },
      { name: '세션 관리', checked: false },
      { name: '로그아웃', line: 67, checked: true },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ name: 'Google OAuth 로그인', line: 15, checked: true });
    // checked: false도 보존
    expect(result[1]).toEqual({ name: '세션 관리', checked: false });
    // line 누락 시 line 필드 자체가 없어야 함
    expect(result[1]).not.toHaveProperty('line');
    expect(result[2]).toEqual({ name: '로그아웃', line: 67, checked: true });
  });

  it('expected_items가 있으면 모든 항목 표시 + implemented에 든 이름만 checked (정상)', () => {
    const expected = ['이메일 로그인', '소셜 로그인 (Google)', '세션 관리', '로그아웃'];
    const implemented = ['이메일 로그인', '세션 관리'];

    const result = normalizeImplementedItems(implemented, expected);
    expect(result).toHaveLength(4);
    expect(result).toEqual([
      { name: '이메일 로그인', checked: true },
      { name: '소셜 로그인 (Google)', checked: false },
      { name: '세션 관리', checked: true },
      { name: '로그아웃', checked: false },
    ]);
  });

  it('expected_items === implemented_items면 전부 checked (정상)', () => {
    const expected = ['항목1', '항목2'];
    const result = normalizeImplementedItems(expected, expected);
    expect(result).toEqual([
      { name: '항목1', checked: true },
      { name: '항목2', checked: true },
    ]);
  });

  it('expected_items 있지만 implemented_items 빈 배열이면 전부 unchecked (경계)', () => {
    const expected = ['항목1', '항목2', '항목3'];
    const result = normalizeImplementedItems([], expected);
    expect(result).toEqual([
      { name: '항목1', checked: false },
      { name: '항목2', checked: false },
      { name: '항목3', checked: false },
    ]);
  });

  it('expected_items 인자 누락 시 legacy fallback — implemented만 모두 checked (호환)', () => {
    // 옛 호출자가 1개 인자만 넘기는 경우. expectedRaw=undefined로 처리됨.
    const result = normalizeImplementedItems(['항목A', '항목B']);
    expect(result).toEqual([
      { name: '항목A', checked: true },
      { name: '항목B', checked: true },
    ]);
  });

  it('빈 배열·배열 아님·잘못된 항목은 빈 결과로 처리한다 (엣지/에러)', () => {
    // 빈 배열
    expect(normalizeImplementedItems([])).toEqual([]);
    // 배열 아님 — 안전하게 빈 배열
    expect(normalizeImplementedItems(null)).toEqual([]);
    expect(normalizeImplementedItems(undefined)).toEqual([]);
    expect(normalizeImplementedItems('not-array')).toEqual([]);
    expect(normalizeImplementedItems(42)).toEqual([]);
    // 잘못된 항목은 필터링되고 정상 항목만 유지
    const mixed = normalizeImplementedItems([
      '정상 문자열',
      null,
      42,
      { wrongKey: 'x' },
      { name: '정상 객체', checked: true },
    ]);
    expect(mixed).toEqual([
      { name: '정상 문자열', checked: true },
      { name: '정상 객체', checked: true },
    ]);
  });
});

/**
 * groupStatusFeatures는 현황 탭 리스트의 totalItems 보정 + 정렬 규칙을 결정.
 * 4/3, 6/5 같은 implemented > total 모순 회귀와 순서 변동 회귀를 보호.
 */
describe('groupStatusFeatures', () => {
  function row(overrides: Partial<SpecFeatureRow>): SpecFeatureRow {
    return {
      id: overrides.id ?? 'id-' + Math.random(),
      project_id: 'p1',
      document_id: 'd1',
      name: overrides.name ?? 'f',
      source: 'PRD',
      status: 'unimplemented',
      implemented_items: [],
      expected_items: [],
      total_items: 0,
      related_files: [],
      prd_summary: null,
      created_at: '2026-05-17T00:00:00Z',
      ...overrides,
    };
  }

  it('expected_items가 implemented_items보다 길면 totalItems = expected.length (정상)', () => {
    const out = groupStatusFeatures([
      row({
        name: '로그인',
        status: 'partial',
        expected_items: ['A', 'B', 'C', 'D', 'E'],
        implemented_items: ['A', 'B'],
        total_items: 5,
      }),
    ]);
    expect(out[0].totalItems).toBe(5);
    expect(out[0].implementedItems.filter((i) => i.checked).length).toBe(2);
  });

  it('implemented_items가 expected_items보다 많은 legacy 모순도 max로 보정 (회귀 보호)', () => {
    const out = groupStatusFeatures([
      row({
        name: 'X',
        status: 'implemented',
        expected_items: ['A', 'B', 'C', 'D', 'E'], // 5개
        implemented_items: ['A', 'B', 'C', 'D', 'E', 'F'], // 6개 (LLM이 expected 밖 항목 추가)
        total_items: 5,
      }),
    ]);
    // "6/5" 표시를 막기 위해 totalItems가 6으로 보정되어야 함
    expect(out[0].totalItems).toBe(6);
  });

  it('expected 빈 legacy + LLM이 total_items보다 많은 implemented도 보정 (엣지)', () => {
    const out = groupStatusFeatures([
      row({
        name: 'Y',
        status: 'implemented',
        expected_items: [],
        implemented_items: ['a', 'b', 'c', 'd'], // 4개
        total_items: 3, // legacy 카운트
      }),
    ]);
    expect(out[0].totalItems).toBe(4); // max(0, 4, 3)
  });

  it('status 우선 정렬: partial → attention → unimplemented → implemented (정상)', () => {
    const out = groupStatusFeatures([
      row({ id: '1', name: 'A', status: 'implemented' }),
      row({ id: '2', name: 'B', status: 'unimplemented' }),
      row({ id: '3', name: 'C', status: 'attention' }),
      row({ id: '4', name: 'D', status: 'partial' }),
    ]);
    expect(out.map((f) => f.status)).toEqual([
      'partial',
      'attention',
      'unimplemented',
      'implemented',
    ]);
  });

  it('같은 status 내에서는 한국어 가나다순으로 정렬 (정상)', () => {
    const out = groupStatusFeatures([
      row({ id: '1', name: '차', status: 'partial' }),
      row({ id: '2', name: '가', status: 'partial' }),
      row({ id: '3', name: '나', status: 'partial' }),
    ]);
    expect(out.map((f) => f.name)).toEqual(['가', '나', '차']);
  });

  it('status × 이름 복합 정렬 (회귀 보호)', () => {
    const out = groupStatusFeatures([
      row({ id: '1', name: '결제', status: 'implemented' }),
      row({ id: '2', name: '알림', status: 'partial' }),
      row({ id: '3', name: '로그인', status: 'implemented' }),
      row({ id: '4', name: '대시보드', status: 'partial' }),
    ]);
    // partial 먼저 (대시보드, 알림), 그 다음 implemented (결제, 로그인)
    expect(out.map((f) => f.name)).toEqual(['대시보드', '알림', '결제', '로그인']);
  });
});
