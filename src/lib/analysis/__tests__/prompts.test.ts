import { describe, it, expect } from 'vitest';
import {
  buildStaticAnalysisMessage,
  buildSessionComparisonMessage,
  buildGuidelineMessage,
  buildStaticAnalysisSystem,
  buildSessionComparisonSystem,
  ANALYSIS_RESULT_TOOL,
  GUIDELINE_RESULT_TOOL,
  GUIDELINE_GENERATION_SYSTEM,
  BOOT_SCAN_SYSTEM,
} from '../prompts';

describe('프롬프트 템플릿', () => {
  it('정적 분석 메시지를 올바르게 조립한다', () => {
    const msg = buildStaticAnalysisMessage({
      projectName: 'CodeSasu',
      sessionTitle: '로그인 에러 처리 추가',
      filesChanged: ['src/auth/login.ts', 'src/auth/error.ts'],
      diffs: '--- src/auth/login.ts ---\n+ try {',
    });

    expect(msg).toContain('CodeSasu');
    expect(msg).toContain('로그인 에러 처리 추가');
    expect(msg).toContain('src/auth/login.ts');
    expect(msg).toContain('+ try {');
  });

  it('세션 비교 메시지를 올바르게 조립한다', () => {
    const msg = buildSessionComparisonMessage({
      prevSessionTitle: '이전 세션',
      prevFilesChanged: ['a.ts'],
      prevSummary: '이전 요약',
      currentSessionTitle: '현재 세션',
      currentFilesChanged: ['a.ts', 'b.ts'],
      currentSummary: '현재 요약',
      currentDiffs: '--- a.ts ---\n- old\n+ new',
    });

    expect(msg).toContain('이전 세션');
    expect(msg).toContain('현재 세션');
    expect(msg).toContain('--- a.ts ---');
  });

  it('가이드라인 메시지를 올바르게 조립한다', () => {
    const msg = buildGuidelineMessage({
      issueTitle: 'API 키 하드코딩',
      issueFact: 'API 키가 노출되었습니다.',
      issueDetail: '보안 위험입니다.',
      issueFile: 'src/config.ts',
      issueBasis: 'OWASP A02',
    });

    expect(msg).toContain('API 키 하드코딩');
    expect(msg).toContain('src/config.ts');
    expect(msg).toContain('OWASP A02');
  });

  it('contextSources가 없으면 컨텍스트 섹션을 추가하지 않는다 (incremental 호환)', () => {
    const msg = buildStaticAnalysisMessage({
      projectName: 'P',
      sessionTitle: 'S',
      filesChanged: ['a.ts'],
      diffs: '--- a.ts ---\n+ foo()',
    });
    expect(msg).not.toContain('## 관련 소스 파일');
  });

  it('contextSources가 있으면 소스 컨텍스트 섹션을 첨부한다 (full_scan)', () => {
    const msg = buildStaticAnalysisMessage({
      projectName: 'P',
      sessionTitle: 'S',
      filesChanged: ['a.ts'],
      diffs: '--- a.ts ---\n+ foo()',
      contextSources: [
        { path: 'src/parent.ts', content: 'import { foo } from "./a";\nfoo();', line_count: 2 },
      ],
    });
    expect(msg).toContain('## 관련 소스 파일');
    expect(msg).toContain('src/parent.ts');
    expect(msg).toContain('partial-context 오탐');
  });
});

describe('도구 스키마', () => {
  it('ANALYSIS_RESULT_TOOL에 필수 필드가 정의되어 있다', () => {
    expect(ANALYSIS_RESULT_TOOL.name).toBe('report_analysis_results');
    const schema = ANALYSIS_RESULT_TOOL.input_schema as Record<string, unknown>;
    expect(schema.required).toContain('issues');
  });

  it('ANALYSIS_RESULT_TOOL의 issue 항목에 confidence/start_line/end_line이 required로 포함된다', () => {
    const schema = ANALYSIS_RESULT_TOOL.input_schema as {
      properties: { issues: { items: { required: string[]; properties: Record<string, { type: string }> } } };
    };
    const itemRequired = schema.properties.issues.items.required;
    const itemProps = schema.properties.issues.items.properties;

    expect(itemRequired).toContain('confidence');
    expect(itemRequired).toContain('start_line');
    expect(itemRequired).toContain('end_line');
    expect(itemProps.confidence.type).toBe('number');
    expect(itemProps.start_line.type).toBe('integer');
    expect(itemProps.end_line.type).toBe('integer');
  });

  it('ANALYSIS_RESULT_TOOL에 file_signatures 필드와 항목 required 6개가 정의되어 있다', () => {
    const schema = ANALYSIS_RESULT_TOOL.input_schema as {
      properties: {
        file_signatures: {
          type: string;
          items: { required: string[]; properties: Record<string, { type: string }> };
        };
      };
      required: string[];
    };
    // file_signatures는 선택 필드 — required에 포함되면 안 됨 (issues만 required)
    expect(schema.required).not.toContain('file_signatures');
    // 하지만 항목 자체는 정의되어 있어야 함
    expect(schema.properties.file_signatures.type).toBe('array');
    const itemRequired = schema.properties.file_signatures.items.required;
    expect(itemRequired).toEqual([
      'file_path',
      'functions',
      'imports',
      'exports',
      'patterns',
      'line_count',
    ]);
    expect(schema.properties.file_signatures.items.properties.line_count.type).toBe('integer');
  });

  it('GUIDELINE_RESULT_TOOL에 필수 필드가 정의되어 있다', () => {
    expect(GUIDELINE_RESULT_TOOL.name).toBe('report_guideline');
    const schema = GUIDELINE_RESULT_TOOL.input_schema as Record<string, unknown>;
    expect(schema.required).toContain('title');
    expect(schema.required).toContain('rule');
  });
});

describe('buildStaticAnalysisSystem — 6섹션 구조', () => {
  it('6개 섹션 헤더를 모두 포함한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('# ① 역할 정의');
    expect(prompt).toContain('# ② 입력 포맷');
    expect(prompt).toContain('# ③ 판단 기준');
    expect(prompt).toContain('# ④ 작성 가이드');
    expect(prompt).toContain('# ⑤ 출력 스키마');
    expect(prompt).toContain('# ⑥ Example output');
  });

  it('diff 포맷 설명에 라인 prefix 의미가 포함된다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('`+`');
    expect(prompt).toContain('`-`');
    expect(prompt).toContain('컨텍스트');
  });

  it('partial-context 경고가 포함된다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('전체 코드베이스가 아니라');
    expect(prompt).toContain('외부에서 정의된 함수');
    expect(prompt).toContain('import');
  });

  it('Negative list가 포함된다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('docstring');
    expect(prompt).toContain('타입 힌트');
    expect(prompt).toContain('Prettier');
    expect(prompt).toContain('사용되지 않는 import');
    expect(prompt).toContain('패키지 버전');
    expect(prompt).toContain('console.log');
  });

  it('신뢰도 가이드가 포함된다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('확실한');
    expect(prompt).toContain('confidence');
    expect(prompt).toContain('불확실');
  });

  it('Example output 블록에 신규 필드가 포함된다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('"confidence":');
    expect(prompt).toContain('"start_line":');
    expect(prompt).toContain('"end_line":');
  });
});

describe('buildStaticAnalysisSystem — 모드 분기', () => {
  it('인자 없이 호출하면 full 모드와 동일한 출력을 반환한다', () => {
    expect(buildStaticAnalysisSystem()).toBe(buildStaticAnalysisSystem('full'));
  });

  it('full 모드는 [보안]/[안정성]/[품질] 3 카테고리 헤더를 모두 포함한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('### [보안]');
    expect(prompt).toContain('### [안정성]');
    expect(prompt).toContain('### [품질]');
    // 안정성/품질 대표 항목
    expect(prompt).toContain('핵심 비즈니스 로직');
    expect(prompt).toContain('미사용 export');
    expect(prompt).toContain('중복 API 엔드포인트');
    expect(prompt).toContain('순환 의존성');
  });

  it('full 모드는 critical 5/warning 10/info 5 상한을 명시한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('critical: 최대 5건');
    expect(prompt).toContain('warning: 최대 10건');
    expect(prompt).toContain('info: 최대 5건');
  });

  it('problems_only 모드는 "확실한 문제만 보고" 문구를 포함한다', () => {
    const prompt = buildStaticAnalysisSystem('problems_only');
    expect(prompt).toContain('확실한 보안/기능 문제만');
    expect(prompt).toContain('개선 제안');
  });

  it('problems_only 모드는 critical 3/warning 5/info 0 상한을 명시한다', () => {
    const prompt = buildStaticAnalysisSystem('problems_only');
    expect(prompt).toContain('critical: 최대 3건');
    expect(prompt).toContain('warning: 최대 5건');
    expect(prompt).toContain('info: 최대 0건');
  });

  it('problems_only 모드는 SEC-1/SEC-2/SEC-3 + .env gitignore + 핵심 안정성 5개만 포함', () => {
    const prompt = buildStaticAnalysisSystem('problems_only');
    // 포함되는 5 카테고리 — SEC 코드 또는 안정성 태그로 식별
    expect(prompt).toContain('**SEC-1. 하드코딩된 시크릿** (critical)');
    expect(prompt).toContain('**SEC-2. 인증/인가 부재** (critical)');
    expect(prompt).toContain('**SEC-3. SQL/NoSQL 인젝션** (critical)');
    expect(prompt).toContain('**.env 파일이 .gitignore에 누락** (critical)');
    expect(prompt).toContain('**[안정성] 핵심 비즈니스 로직 에러 처리 부재** (warning)');
    // problems_only에는 SEC-4~6 / 품질 카테고리가 카테고리 선언으로 등장하지 않음
    expect(prompt).not.toContain('**SEC-4.');
    expect(prompt).not.toContain('**SEC-5.');
    expect(prompt).not.toContain('**SEC-6.');
    expect(prompt).not.toContain('### [품질] —');
    expect(prompt).not.toContain('**중복 API 엔드포인트**');
    expect(prompt).not.toContain('**과도한 파일 크기**');
    expect(prompt).not.toContain('**순환 의존성**');
    expect(prompt).not.toContain('**미사용 export**');
  });

  it('problems_only 모드는 추가 negative list 항목을 포함한다', () => {
    const prompt = buildStaticAnalysisSystem('problems_only');
    expect(prompt).toContain('성능 개선 제안');
    expect(prompt).toContain('best practice');
    expect(prompt).toContain('리팩토링 제안');
  });

  it('full ≠ problems_only — 두 모드는 서로 다른 프롬프트를 생성한다', () => {
    expect(buildStaticAnalysisSystem('full')).not.toBe(
      buildStaticAnalysisSystem('problems_only')
    );
  });
});

describe('buildStaticAnalysisSystem — SEC-1~6 보안 체크리스트', () => {
  it('full 모드에 SEC-1 ~ SEC-6 코드와 CWE 번호가 모두 등장한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    // SEC 코드 6개
    expect(prompt).toContain('SEC-1');
    expect(prompt).toContain('SEC-2');
    expect(prompt).toContain('SEC-3');
    expect(prompt).toContain('SEC-4');
    expect(prompt).toContain('SEC-5');
    expect(prompt).toContain('SEC-6');
    // 각 SEC의 CWE 번호 매핑
    expect(prompt).toContain('CWE-798'); // SEC-1
    expect(prompt).toContain('CWE-306'); // SEC-2
    expect(prompt).toContain('CWE-862'); // SEC-2
    expect(prompt).toContain('CWE-89'); // SEC-3
    expect(prompt).toContain('CWE-79'); // SEC-4
    expect(prompt).toContain('CWE-200'); // SEC-5
    expect(prompt).toContain('CWE-942'); // SEC-6
  });

  it('SEC-3는 Supabase/Prisma 파라미터 바인딩 제외 단서를 포함한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('Supabase');
    expect(prompt).toContain('Prisma');
    expect(prompt).toContain('파라미터 바인딩');
  });

  it('SEC-1은 .env.example placeholder 제외 단서를 포함한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('.env.example');
    expect(prompt).toContain('placeholder');
    expect(prompt).toContain('YOUR_KEY_HERE');
  });

  it('SEC-6 CORS는 info 레벨로 단순화되어 있다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toMatch(/SEC-6\.[\s\S]*CWE-942[\s\S]*\*\*info\*\*/);
  });
});

describe('buildStaticAnalysisSystem — Negative list 확장', () => {
  it('보안 false positive 그룹을 포함한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('### [보안] false positive 방지');
    expect(prompt).toContain('NEXT_PUBLIC_');
    expect(prompt).toContain('.env.example');
    expect(prompt).toContain('__tests__/');
    expect(prompt).toContain('.gitignore에 포함된 파일');
  });

  it('안정성 false positive 그룹을 포함한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('### [안정성] false positive 방지');
    expect(prompt).toContain('error.tsx');
    expect(prompt).toContain('Sentry');
    expect(prompt).toContain('타입 가드');
    expect(prompt).toContain('optional chaining');
  });

  it('품질 false positive 그룹을 포함한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('### [품질] false positive 방지');
    expect(prompt).toContain('re-export');
    expect(prompt).toContain('동적 import');
    expect(prompt).toContain('page.tsx');
  });
});

describe('buildStaticAnalysisSystem — basis 카테고리 + 구간 태그', () => {
  it('④ 작성 가이드 basis 절에 [카테고리] [구간] 형식 + 카테고리 태그 3종이 등장한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('[카테고리] [구간]');
    expect(prompt).toContain('[보안]');
    expect(prompt).toContain('[안정성]');
    expect(prompt).toContain('[품질]');
  });

  it('④ 작성 가이드 basis 절에 6개 구간 태그 규칙이 모두 정의된다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('[API]');
    expect(prompt).toContain('[FE]');
    expect(prompt).toContain('[DB]');
    expect(prompt).toContain('[LIB]');
    expect(prompt).toContain('[CONFIG]');
    expect(prompt).toContain('[AGENT]');
    // 각 구간의 경로 매핑 단서
    expect(prompt).toContain('app/api/');
    expect(prompt).toContain('src/components/');
    expect(prompt).toContain('src/lib/');
    expect(prompt).toContain('supabase/');
    expect(prompt).toContain('agent/');
  });

  it('⑥ Example output의 basis 값이 [카테고리] [구간] 형식으로 시작한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    // critical 예시 — [보안] [LIB] 태그 (src/lib/anthropic.ts)
    expect(prompt).toContain('"basis": "[보안] [LIB] SEC-1: 하드코딩된 API 키 (CWE-798, OWASP A07)"');
    // warning 예시 — [안정성] [API] 태그 (app/api/.../route.ts)
    expect(prompt).toContain('"basis": "[안정성] [API] 외부 API 호출에 에러 처리 부재 (CWE-755)"');
  });

  it('problems_only Example output의 basis도 [카테고리] [구간] 형식으로 시작한다', () => {
    const prompt = buildStaticAnalysisSystem('problems_only');
    expect(prompt).toContain('"basis": "[보안] [LIB] SEC-1: 하드코딩된 API 키 (CWE-798, OWASP A07)"');
  });
});

describe('buildStaticAnalysisSystem — fix_command 4줄 구조', () => {
  it('④ 작성 가이드 fix_command 절에 4행 구조 + 키워드가 모두 등장한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('4줄 구조');
    expect(prompt).toContain('[현재 상태]');
    expect(prompt).toContain('[문제]');
    expect(prompt).toContain('[되는 것]');
    expect(prompt).toContain('[수정 방법]');
    // 4행은 "~해줘" 체로 끝나야 한다는 지시
    expect(prompt).toContain('"~해줘" 체');
  });

  it('④ fix_command 좋은 예 블록에 4행 키워드가 순서대로 등장한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toMatch(
      /\[현재 상태\][\s\S]*\[문제\][\s\S]*\[되는 것\][\s\S]*\[수정 방법\][\s\S]*해줘/
    );
  });

  it('⑥ full 모드 Example output의 fix_command 값에 4행 키워드가 모두 등장한다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    // JSON-escaped \n으로 4행이 한 문자열에 들어감
    expect(prompt).toContain('"fix_command": "[현재 상태]');
    expect(prompt).toContain('\\n[문제]');
    expect(prompt).toContain('\\n[되는 것]');
    expect(prompt).toContain('\\n[수정 방법]');
    // 4행은 "~해줘"로 끝남
    expect(prompt).toMatch(/\[수정 방법\][^"]*해줘"/);
  });

  it('⑥ problems_only Example output의 fix_command도 4행 구조를 따른다', () => {
    const prompt = buildStaticAnalysisSystem('problems_only');
    expect(prompt).toContain('"fix_command": "[현재 상태]');
    expect(prompt).toContain('\\n[수정 방법]');
    expect(prompt).toMatch(/\[수정 방법\][^"]*해줘"/);
  });
});

describe('buildSessionComparisonSystem — 보안 변경 감지', () => {
  it('full 모드 ③에 보안 변경 감지 블록이 등장한다', () => {
    const prompt = buildSessionComparisonSystem('full');
    expect(prompt).toContain('## 보안 변경 감지');
    expect(prompt).toContain('인증 미들웨어');
    expect(prompt).toMatch(/인증 미들웨어[\s\S]*C 티어/);
    expect(prompt).toMatch(/하드코딩[\s\S]*C 티어/);
    expect(prompt).toMatch(/CORS[\s\S]*\*[\s\S]*B 티어/);
    expect(prompt).toContain('[보안 회귀]');
  });

  it('problems_only 모드에는 보안 변경 감지 블록이 등장하지 않는다 (간소화 유지)', () => {
    const prompt = buildSessionComparisonSystem('problems_only');
    expect(prompt).not.toContain('## 보안 변경 감지');
    expect(prompt).not.toContain('[보안 회귀]');
  });
});

describe('buildSessionComparisonSystem — 모드 분기', () => {
  it('인자 없이 호출하면 full 모드와 동일하다', () => {
    expect(buildSessionComparisonSystem()).toBe(
      buildSessionComparisonSystem('full')
    );
  });

  it('full 모드는 6섹션 구조와 6개 카테고리를 갖는다', () => {
    const prompt = buildSessionComparisonSystem('full');
    expect(prompt).toContain('# ① 역할 정의');
    expect(prompt).toContain('# ② 입력 포맷');
    expect(prompt).toContain('# ③ 판단 기준');
    expect(prompt).toContain('# ④ 작성 가이드');
    expect(prompt).toContain('# ⑤ 출력 스키마');
    expect(prompt).toContain('# ⑥ Example output');
    // 6개 카테고리 선언 (기존 4 + 신규 2)
    expect(prompt).toContain('**기능 삭제**');
    expect(prompt).toContain('**동작 변경**');
    expect(prompt).toContain('**설정 변경**');
    expect(prompt).toContain('**의존성 제거**');
    expect(prompt).toContain('**API 계약 변경**');
    expect(prompt).toContain('**스키마 변경**');
  });

  it('full 모드는 critical 5/warning 5/info 3 상한을 명시한다', () => {
    const prompt = buildSessionComparisonSystem('full');
    expect(prompt).toContain('critical: 최대 5건');
    expect(prompt).toContain('warning: 최대 5건');
    expect(prompt).toContain('info: 최대 3건');
  });

  it('problems_only 모드는 기능 삭제 + 스키마 변경만 카테고리 선언으로 포함', () => {
    const prompt = buildSessionComparisonSystem('problems_only');
    expect(prompt).toContain('**기능 삭제**');
    expect(prompt).toContain('**스키마 변경**');
    // 카테고리 선언으로 등장하지 않아야 하는 항목
    expect(prompt).not.toContain('**동작 변경**');
    expect(prompt).not.toContain('**설정 변경**');
    expect(prompt).not.toContain('**의존성 제거**');
    expect(prompt).not.toContain('**API 계약 변경**');
  });

  it('problems_only 모드는 critical 3/warning 2/info 0 상한을 명시한다', () => {
    const prompt = buildSessionComparisonSystem('problems_only');
    expect(prompt).toContain('critical: 최대 3건');
    expect(prompt).toContain('warning: 최대 2건');
    expect(prompt).toContain('info: 최대 0건');
  });

  it('partial-context 경고와 신뢰도 가이드가 양쪽 모드에 포함된다', () => {
    for (const mode of ['full', 'problems_only'] as const) {
      const prompt = buildSessionComparisonSystem(mode);
      expect(prompt).toContain('전체 코드베이스');
      expect(prompt).toContain('confidence');
      expect(prompt).toContain('리팩토링');
    }
  });
});

describe('buildSessionComparisonSystem — A/B/C 판정 구조', () => {
  it('full 모드는 A/B/C 3티어 판정 트리를 명시한다', () => {
    const prompt = buildSessionComparisonSystem('full');
    expect(prompt).toContain('A → B → C');
    expect(prompt).toContain('### A. 명확한 의도적 변경');
    expect(prompt).toContain('### B. 의심스러운 변경');
    expect(prompt).toContain('### C. 확실한 사고');
  });

  it('A 티어는 "보고하지 마세요" 지침을 포함한다', () => {
    const prompt = buildSessionComparisonSystem('full');
    expect(prompt).toMatch(/A[\s\S]*명확한 의도적 변경[\s\S]*보고하지 마세요/);
    expect(prompt).toContain('이름·위치만 바뀐 리팩토링');
    expect(prompt).toContain('파일 이동(rename)');
  });

  it('B 티어는 warning + confidence 0.6~0.85를 매핑한다', () => {
    const prompt = buildSessionComparisonSystem('full');
    expect(prompt).toMatch(/B[\s\S]*의심스러운[\s\S]*warning[\s\S]*0\.6~0\.85/);
    expect(prompt).toContain('대체 구현이 diff에 보이지 않음');
    expect(prompt).toContain('패키지를 사용하는 코드가 diff에 잔존');
  });

  it('C 티어는 critical + confidence 0.9+를 매핑한다', () => {
    const prompt = buildSessionComparisonSystem('full');
    expect(prompt).toMatch(/C[\s\S]*확실한 사고[\s\S]*critical[\s\S]*0\.9\+/);
    expect(prompt).toContain('핵심 파일');
    expect(prompt).toContain('마이그레이션 파일 없음');
  });

  it('problems_only 모드는 C 티어 위주 가이드를 명시한다', () => {
    const prompt = buildSessionComparisonSystem('problems_only');
    expect(prompt).toContain('C 티어');
    expect(prompt).toMatch(/B 티어.*무시/);
    // problems_only에는 full의 A→B→C 평가 트리가 들어가지 않음 (간소화 버전 사용)
    expect(prompt).not.toContain('A → B → C');
  });
});

describe('buildSessionComparisonSystem — Example output', () => {
  it('full 모드 ⑥은 critical + warning 두 예시를 포함한다', () => {
    const prompt = buildSessionComparisonSystem('full');
    // critical 예시 — 결제 API route 삭제
    expect(prompt).toContain('"결제 API route 삭제"');
    expect(prompt).toContain('app/api/checkout/route.ts');
    expect(prompt).toContain('"level": "critical"');
    // warning 예시 — Stripe 의존성 제거 + 사용 코드 잔존
    expect(prompt).toContain('"Stripe 의존성 제거 + 사용 코드 잔존"');
    expect(prompt).toContain('src/hooks/useCheckout.ts');
    expect(prompt).toContain('"level": "warning"');
  });

  it('problems_only 모드 ⑥은 critical 예시 1개만 포함한다', () => {
    const prompt = buildSessionComparisonSystem('problems_only');
    expect(prompt).toContain('"결제 API route 삭제"');
    expect(prompt).toContain('"level": "critical"');
    // warning 예시는 problems_only 예시에 없어야 함
    expect(prompt).not.toContain('"Stripe 의존성 제거 + 사용 코드 잔존"');
  });

  it('Example output에 신규 필드(confidence/start_line/end_line)가 포함된다', () => {
    const prompt = buildSessionComparisonSystem('full');
    expect(prompt).toContain('"confidence":');
    expect(prompt).toContain('"start_line":');
    expect(prompt).toContain('"end_line":');
  });
});

describe('buildStaticAnalysisSystem — 3차 고도화', () => {
  it('Partial-context 강화 규칙: "안 보인다 ≠ 없다" 핵심 원칙과 5개 규칙 키워드를 모두 포함', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('Partial-context 판단 규칙 (강화)');
    expect(prompt).toContain('안 보인다 ≠ 없다');
    // 5개 규칙 키워드
    expect(prompt).toContain('import가 diff에 있지만 사용처가 안 보인다');
    expect(prompt).toContain('함수가 정의됐지만 호출이 안 보인다');
    expect(prompt).toContain('환경변수가 참조됐지만 .env');
    expect(prompt).toContain('try-catch가 diff에 안 보인다');
    expect(prompt).toContain('인증 미들웨어가 diff에 안 보인다');
    // 라우트 핸들러 예외 단서
    expect(prompt).toContain('app/api/*/route.ts');
    expect(prompt).toContain('middleware.ts');
    // confidence 0.5 이하 + detail 미확인 문구 명령
    expect(prompt).toContain('confidence를 0.5 이하');
    expect(prompt).toContain('전체 파일을 확인하지 못해 판단이 제한적입니다');
  });

  it('full 모드만 SEC-1~3 좋은/나쁜 감지 예시를 포함한다', () => {
    const fullPrompt = buildStaticAnalysisSystem('full');
    const problemsOnlyPrompt = buildStaticAnalysisSystem('problems_only');

    // full에 포함되는 키워드
    expect(fullPrompt).toContain('## 좋은 감지 vs 나쁜 감지 예시');
    expect(fullPrompt).toContain('SEC-1 하드코딩된 비밀');
    expect(fullPrompt).toContain('SEC-2 인증 부재');
    expect(fullPrompt).toContain('SEC-3 입력 미검증');
    // SEC-1 좋은/나쁜 키워드
    expect(fullPrompt).toContain('sk-ant-api03-');
    expect(fullPrompt).toContain('https://api.example.com');
    expect(fullPrompt).toContain('URL은 비밀이 아니다');
    // SEC-2 좋은/나쁜 키워드
    expect(fullPrompt).toContain('app/api/users/route.ts');
    expect(fullPrompt).toContain('health check는 인증 불필요');
    // SEC-3 좋은/나쁜 키워드
    expect(fullPrompt).toContain('req.body.email');
    expect(fullPrompt).toContain('parseInt');
    expect(fullPrompt).toContain('이미 검증한 것');
    // 안정성 — 에러 처리 / 기능 삭제
    expect(fullPrompt).toContain('### 안정성 — 에러 처리');
    expect(fullPrompt).toContain('### 안정성 — 기능 삭제');
    expect(fullPrompt).toContain('확신 없으면 보고하지 마라');
    expect(fullPrompt).toContain('삭제가 아니라 개선일 수 있음');

    // problems_only에는 등장하지 않음
    expect(problemsOnlyPrompt).not.toContain('## 좋은 감지 vs 나쁜 감지 예시');
    expect(problemsOnlyPrompt).not.toContain('SEC-1 하드코딩된 비밀');
  });

  it('Negative list 강화 — ESLint 위임 + 품질 보고 가능 항목 키워드 포함', () => {
    const prompt = buildStaticAnalysisSystem('full');
    // 추가된 negative 키워드
    expect(prompt).toContain('ESLint가 이미 잡는 규칙');
    expect(prompt).toContain('import만 있고 사용처가 diff에 안 보이는 경우');
    expect(prompt).toContain('export된 함수가 현재 diff에서 호출되지 않는 경우');
    expect(prompt).toContain('파일명/변수명 컨벤션');
    // "보고해도 되는 품질 이슈" 블록
    expect(prompt).toContain('## 보고해도 되는 품질 이슈');
    expect(prompt).toContain('DRY 위반');
    expect(prompt).toContain('100줄 이상');
    expect(prompt).toContain('4단계 이상 if/for');
    expect(prompt).toContain('매직 넘버');
  });

  it('problems_only 모드에는 "보고해도 되는 품질 이슈" 블록이 등장하지 않는다', () => {
    const prompt = buildStaticAnalysisSystem('problems_only');
    expect(prompt).not.toContain('## 보고해도 되는 품질 이슈');
    expect(prompt).not.toContain('DRY 위반');
  });

  it('이슈 그룹핑 규칙이 ④ 작성 가이드로 이동했다 — ③에는 없고 ④에 있다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    const fourthSectionStart = prompt.indexOf('# ④ 작성 가이드');
    const fifthSectionStart = prompt.indexOf('# ⑤ 출력 스키마');
    const thirdSection = prompt.slice(0, fourthSectionStart);
    const fourthSection = prompt.slice(fourthSectionStart, fifthSectionStart);

    // ③에는 그룹핑 헤더가 없어야 함
    expect(thirdSection).not.toContain('## 이슈 그룹핑');
    // ④에는 강화된 그룹핑 헤더가 있어야 함
    expect(fourthSection).toContain('## 이슈 그룹핑 규칙 (강화)');
    expect(fourthSection).toContain('통합 대상');
    expect(fourthSection).toContain('통합하지 않을 대상');
    expect(fourthSection).toContain('심각도가 다른');
    // 통합 대상 구체 키워드
    expect(fourthSection).toContain('3개 API 라우트에 에러 처리 누락');
    expect(fourthSection).toContain('2개 API 엔드포인트에 인증 미적용');
  });

  it('⑥ full Example output 3번째 이슈에 partial-context 미확인 사례가 포함된다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('"관리자 라우트 인증 미확인"');
    expect(prompt).toContain('app/api/admin/users/route.ts');
    expect(prompt).toContain('"confidence": 0.6');
    // detail에 미확인 문구
    expect(prompt).toMatch(/"detail":[\s\S]*?전체 파일을 확인하지 못해 판단이 제한적입니다/);
    // basis에 SEC-2 + middleware.ts 미확인 표기
    expect(prompt).toContain(
      '"basis": "[보안] [API] SEC-2: 인증/권한 검증 미확인 — middleware.ts 미확인 (CWE-306, OWASP A01)"'
    );
  });
});

describe('buildStaticAnalysisSystem — file_signatures 가이드', () => {
  it('full 모드에 시그니처 추출 가이드와 항목 정의가 포함된다', () => {
    const prompt = buildStaticAnalysisSystem('full');
    expect(prompt).toContain('## 파일 시그니처 (file_signatures)');
    expect(prompt).toContain('합집합 머지');
    // 항목 키워드
    expect(prompt).toContain('functions');
    expect(prompt).toContain('imports');
    expect(prompt).toContain('exports');
    expect(prompt).toContain('patterns');
    expect(prompt).toContain('line_count');
    // 추출 규칙 키워드
    expect(prompt).toContain('새 파일');
    expect(prompt).toContain('수정 파일');
    expect(prompt).toContain('JavaScript/TypeScript');
  });

  it('problems_only 모드는 시그니처 가이드를 포함하지 않는다 (자동 분석 비용 절감)', () => {
    const prompt = buildStaticAnalysisSystem('problems_only');
    expect(prompt).not.toContain('## 파일 시그니처 (file_signatures)');
    expect(prompt).not.toContain('합집합 머지');
  });
});

describe('GUIDELINE_GENERATION_SYSTEM', () => {
  it('가이드라인 프롬프트에 작성 가이드가 포함된다', () => {
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('명령형 문체');
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('하지 마라');
  });

  it('좋은 예 / 나쁜 예 블록이 포함된다', () => {
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('좋은 예');
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('나쁜 예');
    // 좋은 예 — 구체적 파일/경로 + 금지 행위 명시
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('@stripe/stripe-js');
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('ENABLE ROW LEVEL SECURITY');
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('NEXT_PUBLIC_');
    // 나쁜 예 — 모호함 사례
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('보안에 주의한다');
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('기준 불명확');
  });

  it('규칙 작성 원칙 4개 항목이 포함된다', () => {
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('규칙 작성 원칙');
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('보호 대상 파일/경로');
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('금지 행위를 구체적으로');
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('허용 예외');
    expect(GUIDELINE_GENERATION_SYSTEM).toContain('이유를 한 줄');
  });
});

describe('BOOT_SCAN_SYSTEM — 부팅 스캔 전용 감사 프롬프트', () => {
  it('운영 코드 감사 톤의 핵심 키워드를 포함한다 (코드 변경 리뷰 ≠ 전체 감사)', () => {
    // "신규 추가니까 정상" 사고를 명시적으로 차단하는 키워드들 — LLM이 0건 보고하던 회귀를 방지.
    expect(BOOT_SCAN_SYSTEM).toContain('운영 중인');
    expect(BOOT_SCAN_SYSTEM).toContain('감사');
    expect(BOOT_SCAN_SYSTEM).toContain('코드 변경 리뷰가 아닙니다');
    expect(BOOT_SCAN_SYSTEM).toContain('방금 추가된 코드');
  });

  it('보안 6개 카테고리 (SEC-1~6) + RLS 누락을 모두 명시한다', () => {
    expect(BOOT_SCAN_SYSTEM).toContain('SEC-1');
    expect(BOOT_SCAN_SYSTEM).toContain('SEC-2');
    expect(BOOT_SCAN_SYSTEM).toContain('SEC-3');
    expect(BOOT_SCAN_SYSTEM).toContain('SEC-4');
    expect(BOOT_SCAN_SYSTEM).toContain('SEC-5');
    expect(BOOT_SCAN_SYSTEM).toContain('SEC-6');
    expect(BOOT_SCAN_SYSTEM).toContain('RLS');
  });

  it('ANALYSIS_RESULT_TOOL의 필수 필드 출력 지시를 포함한다 (도구 호출 일관성)', () => {
    // 도구 호출 시 누락되면 안 되는 필드들 — 부팅 스캔에서도 동일하게 강제.
    expect(BOOT_SCAN_SYSTEM).toContain('report_analysis_results');
    expect(BOOT_SCAN_SYSTEM).toContain('confidence');
    expect(BOOT_SCAN_SYSTEM).toContain('start_line');
    expect(BOOT_SCAN_SYSTEM).toContain('file_signatures');
  });

  it('buildStaticAnalysisSystem(full)과 다른 별도 프롬프트다 (회귀 보호)', () => {
    // 두 프롬프트가 의도치 않게 같아지면 부팅 스캔 효과가 사라지므로 명시적으로 검증.
    expect(BOOT_SCAN_SYSTEM).not.toBe(buildStaticAnalysisSystem('full'));
    expect(BOOT_SCAN_SYSTEM).not.toBe(buildStaticAnalysisSystem('problems_only'));
  });

  it('서버 사이드 false positive Negative list 6개 패턴을 포함한다 (오탐 감소)', () => {
    // createAdminClient, process.env.SERVICE_ROLE, Authorization Bearer 등이 정상 패턴이라는 명시.
    // 이 키워드가 없으면 부팅 스캔이 서버 사이드 정상 코드를 보안 위험으로 오탐한다.
    expect(BOOT_SCAN_SYSTEM).toContain('보고하지 말아야 할 항목');
    expect(BOOT_SCAN_SYSTEM).toContain('createAdminClient');
    expect(BOOT_SCAN_SYSTEM).toContain('process.env');
    expect(BOOT_SCAN_SYSTEM).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(BOOT_SCAN_SYSTEM).toContain('app/api/');
    expect(BOOT_SCAN_SYSTEM).toContain('Authorization');
    expect(BOOT_SCAN_SYSTEM).toContain('Bearer');
    expect(BOOT_SCAN_SYSTEM).toContain('RLS');
    // 일반 false positive 방지도 함께 명시
    expect(BOOT_SCAN_SYSTEM).toContain('.env.example');
    expect(BOOT_SCAN_SYSTEM).toContain('테스트 파일');
  });
});

describe('ANALYSIS_RESULT_TOOL — required 회귀 보호 (CLAUDE.md CRITICAL 규칙)', () => {
  // CRITICAL: CLAUDE.md에 ANALYSIS_RESULT_TOOL required 배열 변경 금지 명시.
  // 이 테스트가 깨지면 prompts.ts의 도구 스키마가 변경됐다는 뜻 → 의도된 것인지 강제 검토.
  it('최상위 required는 ["issues"] 그대로', () => {
    const schema = ANALYSIS_RESULT_TOOL.input_schema as { required: string[] };
    expect(schema.required).toEqual(['issues']);
  });

  it('issue 항목 required는 10개 필드 그대로', () => {
    const schema = ANALYSIS_RESULT_TOOL.input_schema as {
      properties: { issues: { items: { required: string[] } } };
    };
    const itemRequired = schema.properties.issues.items.required;
    expect(itemRequired).toEqual(
      expect.arrayContaining([
        'title',
        'level',
        'fact',
        'detail',
        'fix_command',
        'file',
        'basis',
        'confidence',
        'start_line',
        'end_line',
      ])
    );
    expect(itemRequired).toHaveLength(10);
  });
});
