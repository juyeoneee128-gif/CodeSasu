import { describe, it, expect } from 'vitest';
import {
  EXTRACT_FEATURES_TOOL,
  ASSESS_FEATURES_TOOL,
  REVERSE_IA_TOOL,
  EXTRACT_FEATURES_SYSTEM,
  ASSESS_FEATURES_SYSTEM,
  REVERSE_IA_SYSTEM,
  buildExtractFeaturesMessage,
  buildAssessMessage,
  buildReverseIAMessage,
  formatSignaturesSection,
  extractFeatureKeywords,
  matchSourcesByKeywords,
  buildAssessWithSourceMessage,
} from '../prompts';

describe('도구 스키마', () => {
  it('EXTRACT_FEATURES_TOOL에 features 필드가 정의되어 있다', () => {
    expect(EXTRACT_FEATURES_TOOL.name).toBe('report_extracted_features');
    const schema = EXTRACT_FEATURES_TOOL.input_schema as Record<string, unknown>;
    expect(schema.required).toContain('features');
  });

  it('EXTRACT_FEATURES_TOOL은 document_type을 enum + required로 정의한다', () => {
    const schema = EXTRACT_FEATURES_TOOL.input_schema as {
      properties: { document_type: { type: string; enum: string[] } };
      required: string[];
    };
    expect(schema.required).toContain('document_type');
    expect(schema.required).toContain('features');
    expect(schema.properties.document_type.type).toBe('string');
    expect(schema.properties.document_type.enum).toEqual(['prd', 'spec', 'other']);
  });

  it('ASSESS_FEATURES_TOOL에 assessments 필드가 정의되어 있다', () => {
    expect(ASSESS_FEATURES_TOOL.name).toBe('report_assessment');
    const schema = ASSESS_FEATURES_TOOL.input_schema as Record<string, unknown>;
    expect(schema.required).toContain('assessments');
  });

  it('REVERSE_IA_TOOL에 features 필드가 정의되어 있다', () => {
    expect(REVERSE_IA_TOOL.name).toBe('report_reverse_features');
    const schema = REVERSE_IA_TOOL.input_schema as Record<string, unknown>;
    expect(schema.required).toContain('features');
  });

  it('EXTRACT_FEATURES_TOOL.items가 expected_items를 required로 강제한다 (회귀 보호)', () => {
    // 신규 expected_items 필드가 누락되면 LLM이 채우지 않아 backfill이 끝없이 반복된다.
    const schema = EXTRACT_FEATURES_TOOL.input_schema as {
      properties: {
        features: {
          items: {
            properties: { expected_items: { type: string; items: { type: string } } };
            required: string[];
          };
        };
      };
    };
    const itemSchema = schema.properties.features.items;
    expect(itemSchema.properties.expected_items.type).toBe('array');
    expect(itemSchema.properties.expected_items.items.type).toBe('string');
    expect(itemSchema.required).toContain('expected_items');
  });
});

describe('시스템 프롬프트', () => {
  it('기능 추출 프롬프트에 핵심 지시가 포함되어 있다', () => {
    expect(EXTRACT_FEATURES_SYSTEM).toContain('기획서');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('기능을 추출');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('UI/디자인');
  });

  it('기능 추출 프롬프트에 1단계 분류 + 2단계 추출 가이드가 포함된다', () => {
    expect(EXTRACT_FEATURES_SYSTEM).toContain('1단계: 문서 분류');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('2단계: 기능 추출');
    // 3개 분류 라벨 + 정의 키워드
    expect(EXTRACT_FEATURES_SYSTEM).toContain('"prd"');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('"spec"');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('"other"');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('컴포넌트 목록');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('회의록');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('핸드오프');
    // other이면 빈 배열 강제
    expect(EXTRACT_FEATURES_SYSTEM).toContain('"other"이면 features를 반드시 빈 배열');
  });

  it('판정 프롬프트에 판정 기준이 포함되어 있다', () => {
    expect(ASSESS_FEATURES_SYSTEM).toContain('implemented');
    expect(ASSESS_FEATURES_SYSTEM).toContain('partial');
    expect(ASSESS_FEATURES_SYSTEM).toContain('unimplemented');
    expect(ASSESS_FEATURES_SYSTEM).toContain('attention');
  });

  it('판정 프롬프트의 implemented 정의가 implemented_items 작성을 명시한다 (정상)', () => {
    // implemented 상태에서 빈 배열을 반환하는 회귀를 막기 위한 키워드 검증.
    expect(ASSESS_FEATURES_SYSTEM).toContain('implemented_items');
    expect(ASSESS_FEATURES_SYSTEM).toMatch(/implemented[\s\S]*소스코드[\s\S]*세부/);
  });

  it('판정 프롬프트가 implemented/partial에서 빈 배열을 금지한다 (경계)', () => {
    expect(ASSESS_FEATURES_SYSTEM).toContain('빈 배열');
    expect(ASSESS_FEATURES_SYSTEM).toMatch(/implemented[\s\S]*partial[\s\S]*빈 배열[\s\S]*허용하지 않음/);
  });

  it('판정 프롬프트에 implemented_items 작성 예시가 포함되어 있다 (회귀 보호)', () => {
    // 예시 텍스트는 형식 학습용 — 정확 매칭은 피하고 핵심 키워드만 검증.
    expect(ASSESS_FEATURES_SYSTEM).toContain('예시');
    expect(ASSESS_FEATURES_SYSTEM).toContain('사용자 인증');
  });

  it('판정 프롬프트가 expected_items 활용 + 정확한 이름 매칭을 강제한다 (회귀 보호)', () => {
    // implemented_items의 항목명이 expected_items와 정확히 일치해야 UI 체크박스가 동작.
    expect(ASSESS_FEATURES_SYSTEM).toContain('expected_items');
    expect(ASSESS_FEATURES_SYSTEM).toMatch(/expected_items[\s\S]*정확한 이름/);
    // status 판단 기준이 길이 비교로 명시되어 있는지
    expect(ASSESS_FEATURES_SYSTEM).toMatch(/implemented_items\.length[\s\S]*expected_items\.length/);
  });

  it('기능 추출 프롬프트가 expected_items 작성 규칙을 명시한다 (정상)', () => {
    expect(EXTRACT_FEATURES_SYSTEM).toContain('expected_items 작성 규칙');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('1줄 1항목');
    // 빈 배열 금지 명시 — extract 시점에 누락되면 backfill이 무의미해짐
    expect(EXTRACT_FEATURES_SYSTEM).toContain('비어있으면 안 된다');
  });

  it('기능 추출 프롬프트가 expected_items 결정성 규칙을 명시한다 (회귀 보호)', () => {
    // 같은 docs에서 추출해도 LLM이 다른 항목을 생성하던 회귀를 방지.
    // 원문 기반, 추론 금지, 중복 금지 키워드 검증.
    expect(EXTRACT_FEATURES_SYSTEM).toContain('원문 기반');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('추론 금지');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('중복 금지');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('기획서 원문');
  });

  it('기능 추출 프롬프트가 "other" 문서 휴리스틱 키워드를 포함한다 (회귀 보호)', () => {
    // 테스트 결과/컴포넌트 목록/프레임 목록/회의록이 PRD로 오분류되던 회귀 방지.
    expect(EXTRACT_FEATURES_SYSTEM).toContain('Storybook');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('Pencil');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('test-results');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('프레임목록');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('회의록');
    expect(EXTRACT_FEATURES_SYSTEM).toContain('인수인계');
  });

  it('판정 프롬프트가 핵심 로직 존재 시 implemented 인정 규칙을 포함한다 (구현율 안정화)', () => {
    // 핵심 로직이 있어도 미구현으로 판정되던 과소 추정 회귀 방지.
    expect(ASSESS_FEATURES_SYSTEM).toContain('핵심 함수가 정의');
    expect(ASSESS_FEATURES_SYSTEM).toContain('완벽하지 않아도');
    expect(ASSESS_FEATURES_SYSTEM).toContain('TODO');
    expect(ASSESS_FEATURES_SYSTEM).toContain('placeholder');
  });

  it('판정 프롬프트가 expected_items 외 항목 추가 금지 규칙을 포함한다 (정확 매칭)', () => {
    // expected_items 부분집합 강제 — UI Set 비교 일관성.
    expect(ASSESS_FEATURES_SYSTEM).toContain('expected_items에 없는 이름');
    expect(ASSESS_FEATURES_SYSTEM).toContain('부분집합');
  });

  it('Reverse IA 프롬프트에 역추출 지시가 포함되어 있다', () => {
    expect(REVERSE_IA_SYSTEM).toContain('세션 로그');
    expect(REVERSE_IA_SYSTEM).toContain('기능 추출');
    expect(REVERSE_IA_SYSTEM).toContain('related_files');
  });
});

describe('메시지 빌더', () => {
  it('기능 추출 메시지를 올바르게 조립한다', () => {
    const msg = buildExtractFeaturesMessage('## 1. 로그인\n- 이메일 로그인', 'FRD');
    expect(msg).toContain('FRD');
    expect(msg).toContain('로그인');
    expect(msg).toContain('이메일');
  });

  it('판정 메시지를 올바르게 조립한다', () => {
    const msg = buildAssessMessage({
      features: [
        { id: 'f1', name: '로그인', total_items: 3, prd_summary: '이메일 로그인 기능' },
      ],
      sessions: [
        { title: '로그인 구현', summary: '로그인 완료', changed_files: ['src/auth/login.ts'] },
      ],
    });
    expect(msg).toContain('[f1] 로그인');
    expect(msg).toContain('src/auth/login.ts');
  });

  it('expected_items가 있으면 메시지에 항목 목록이 들여쓰기로 노출된다 (정상)', () => {
    const msg = buildAssessMessage({
      features: [
        {
          id: 'f1',
          name: '로그인',
          total_items: 2,
          prd_summary: '이메일/소셜 로그인',
          expected_items: ['이메일 로그인', '소셜 로그인 (Google)'],
        },
      ],
      sessions: [],
    });
    expect(msg).toContain('expected_items:');
    expect(msg).toContain('- 이메일 로그인');
    expect(msg).toContain('- 소셜 로그인 (Google)');
    // expected_items가 있으면 "(세부 N개)" 형식은 사용하지 않음 (불필요)
    expect(msg).not.toContain('(세부 2개)');
  });

  it('expected_items가 빈 배열이면 기존 "(세부 N개)" 형식을 유지한다 (legacy 호환 — 엣지)', () => {
    const msg = buildAssessMessage({
      features: [
        { id: 'f1', name: '로그인', total_items: 3, prd_summary: '요약', expected_items: [] },
      ],
      sessions: [],
    });
    expect(msg).toContain('(세부 3개)');
    expect(msg).not.toContain('expected_items:');
  });

  it('Reverse IA 메시지를 올바르게 조립한다', () => {
    const msg = buildReverseIAMessage({
      sessions: [
        {
          title: '초기 설정',
          summary: '프로젝트 초기화',
          prompts: ['Next.js 프로젝트 초기화해줘'],
          changed_files: ['package.json', 'tsconfig.json'],
        },
      ],
    });
    expect(msg).toContain('세션 1: 초기 설정');
    expect(msg).toContain('Next.js 프로젝트 초기화해줘');
    expect(msg).toContain('package.json');
  });

  it('프롬프트를 최대 5개까지만 포함한다', () => {
    const prompts = Array.from({ length: 10 }, (_, i) => `프롬프트 ${i}`);
    const msg = buildReverseIAMessage({
      sessions: [{ title: 't', summary: null, prompts, changed_files: [] }],
    });
    expect(msg).toContain('프롬프트 4');
    expect(msg).not.toContain('프롬프트 5');
  });
});

describe('buildAssessMessage — file_signatures 통합', () => {
  function feature(id = 'f1', name = '로그인') {
    return { id, name, total_items: 3, prd_summary: '이메일 로그인' };
  }

  it('시그니처 없으면 시그니처 섹션을 포함하지 않는다 (기존 동작 보존)', () => {
    const msg = buildAssessMessage({
      features: [feature()],
      sessions: [{ title: 's', summary: null, changed_files: [] }],
    });
    expect(msg).not.toContain('## 파일 시그니처');
  });

  it('시그니처가 있으면 메시지에 포함된다', () => {
    const msg = buildAssessMessage({
      features: [feature()],
      sessions: [],
      file_signatures: [
        {
          file_path: 'src/auth/login.ts',
          functions: ['handleLogin', 'validateEmail'],
          imports: ['next/server'],
          exports: ['handleLogin'],
          patterns: ['supabase.auth.signInWithPassword'],
          line_count: 120,
        },
      ],
    });
    expect(msg).toContain('## 파일 시그니처');
    expect(msg).toContain('src/auth/login.ts (line 120)');
    expect(msg).toContain('fns: handleLogin, validateEmail');
    expect(msg).toContain('imports: next/server');
    expect(msg).toContain('patterns: supabase.auth.signInWithPassword');
  });

  it('빈 항목(예: imports)은 출력되지 않는다', () => {
    const msg = buildAssessMessage({
      features: [feature()],
      sessions: [],
      file_signatures: [
        {
          file_path: 'a.ts',
          functions: ['foo'],
          imports: [],
          exports: [],
          patterns: [],
          line_count: 10,
        },
      ],
    });
    expect(msg).toContain('fns: foo');
    expect(msg).not.toContain('imports:');
    expect(msg).not.toContain('patterns:');
  });
});

describe('formatSignaturesSection — 토큰 한도 처리', () => {
  it('빈 배열은 빈 문자열', () => {
    expect(formatSignaturesSection([])).toBe('');
  });

  it('line_count desc 정렬 후 작은 파일이 먼저 잘린다', () => {
    // 큰 시그니처 여러 개 만들어서 한도 초과 유도
    const many = Array.from({ length: 200 }, (_, i) => ({
      file_path: `src/f${i}.ts`,
      functions: ['fn1', 'fn2', 'fn3', 'fn4', 'fn5'],
      imports: ['mod1', 'mod2'],
      exports: ['e1'],
      patterns: ['supabase.auth.x', 'fetch'],
      line_count: i + 1, // i 작을수록 작은 파일
    }));

    const out = formatSignaturesSection(many);
    // 가장 큰 파일은 포함됨
    expect(out).toContain('src/f199.ts');
    // 한도로 잘렸다는 footer 있음
    expect(out).toContain('생략됨');
  });

  it('한도 안에 들어가면 모두 포함', () => {
    const small = [
      {
        file_path: 'a.ts',
        functions: ['f'],
        imports: [],
        exports: [],
        patterns: [],
        line_count: 5,
      },
    ];
    const out = formatSignaturesSection(small);
    expect(out).toContain('a.ts');
    expect(out).not.toContain('생략됨');
  });
});

describe('ASSESS_FEATURES_SYSTEM — 시그니처 강화', () => {
  it('시그니처 활용 + fallback 키워드 포함', () => {
    expect(ASSESS_FEATURES_SYSTEM).toContain('파일 시그니처');
    expect(ASSESS_FEATURES_SYSTEM).toContain('Fallback');
    expect(ASSESS_FEATURES_SYSTEM).toContain('합집합 머지');
    expect(ASSESS_FEATURES_SYSTEM).toContain('패턴 부재가 더 강한 신호');
    // status 정의 보존
    expect(ASSESS_FEATURES_SYSTEM).toContain('implemented');
    expect(ASSESS_FEATURES_SYSTEM).toContain('partial');
    expect(ASSESS_FEATURES_SYSTEM).toContain('unimplemented');
    expect(ASSESS_FEATURES_SYSTEM).toContain('attention');
  });
});

describe('소스코드 기반 판정 (full_scan)', () => {
  describe('extractFeatureKeywords', () => {
    it('한국어 기능명에서 매핑 사전을 통해 영문 키워드를 추출한다', () => {
      const k = extractFeatureKeywords('소셜 로그인');
      expect(k).toContain('login');
      expect(k).toContain('signin');
    });

    it('영문 기능명은 토큰 자체를 키워드로 사용한다', () => {
      const k = extractFeatureKeywords('OAuth Callback');
      expect(k).toContain('oauth');
      expect(k).toContain('callback');
    });

    it('매핑 사전에 없고 영문도 아닐 때 fallback으로 정규화 이름을 쓴다', () => {
      const k = extractFeatureKeywords('zzz-기능');
      // 'zzz'는 영문 토큰으로 추출되거나 fallback으로 'zzz'
      expect(k.length).toBeGreaterThan(0);
    });
  });

  describe('matchSourcesByKeywords', () => {
    const sources = [
      { path: 'src/auth/login.ts', content: 'export function login() {}', line_count: 10 },
      { path: 'src/billing/stripe.ts', content: 'stripe.charges.create()', line_count: 50 },
      { path: 'src/utils/x.ts', content: 'noop', line_count: 5 },
    ];

    it('path에 키워드가 등장하면 매칭한다', () => {
      const matched = matchSourcesByKeywords(['login'], sources);
      expect(matched.length).toBe(1);
      expect(matched[0].path).toBe('src/auth/login.ts');
    });

    it('content에 키워드가 등장해도 매칭한다', () => {
      const matched = matchSourcesByKeywords(['stripe'], sources);
      expect(matched.map((m) => m.path)).toContain('src/billing/stripe.ts');
    });

    it('line_count 작은 순으로 정렬되어 반환된다', () => {
      const matched = matchSourcesByKeywords(['noop', 'login', 'stripe'], sources, 10);
      expect(matched[0].line_count).toBeLessThanOrEqual(matched[matched.length - 1].line_count);
    });

    it('빈 키워드는 빈 배열을 반환한다', () => {
      expect(matchSourcesByKeywords([], sources)).toEqual([]);
    });
  });

  describe('buildAssessWithSourceMessage', () => {
    it('기능 ↔ 파일 매칭 표와 소스 섹션을 포함한다', () => {
      const msg = buildAssessWithSourceMessage({
        features: [{ id: 'f1', name: '소셜 로그인', total_items: 2, prd_summary: 'OAuth' }],
        sessions: [{ title: '인증 작업', summary: null, changed_files: ['src/auth/login.ts'] }],
        source_files: [
          { path: 'src/auth/login.ts', content: 'export function login() { return true; }', line_count: 1 },
        ],
      });
      expect(msg).toContain('## 기능 목록');
      expect(msg).toContain('## 기능 ↔ 파일 매칭');
      expect(msg).toContain('## 관련 소스 파일');
      expect(msg).toContain('src/auth/login.ts');
      expect(msg).toContain('export function login()');
    });

    it('매칭 파일 없으면 안내 메시지를 표시한다', () => {
      const msg = buildAssessWithSourceMessage({
        features: [{ id: 'f1', name: '결제', total_items: 1, prd_summary: null }],
        sessions: [],
        source_files: [
          { path: 'src/foo/bar.ts', content: 'noop', line_count: 1 },
        ],
      });
      expect(msg).toContain('매칭된 소스 파일 없음');
    });
  });
});
