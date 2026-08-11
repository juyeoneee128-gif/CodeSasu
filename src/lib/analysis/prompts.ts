import type { Tool } from '@anthropic-ai/sdk/resources/messages';

// ─── 분석 모드 ───

export type AnalysisMode = 'full' | 'problems_only';

// ─── 도구 스키마: 분석 결과 수신 ───

export const ANALYSIS_RESULT_TOOL: Tool = {
  name: 'report_analysis_results',
  description: 'Report the code analysis results as structured data.',
  input_schema: {
    type: 'object' as const,
    properties: {
      file_signatures: {
        type: 'array',
        description:
          'diff에 포함된 각 파일의 코드 시그니처. **full 모드에서만 작성**. problems_only 모드면 비워두거나 생략. 새 파일(+만 있음)은 전체 구조 정확 추출, 수정 파일은 변경 부분에서 보이는 정보만 추출 (서버는 합집합 머지로 누적함). diff에 없는 파일은 보고하지 마라.',
        items: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'diff 헤더의 파일 경로 그대로 (상대 경로)',
            },
            functions: {
              type: 'array',
              items: { type: 'string' },
              description: '선언된 함수/메서드 이름 (예: handleLogin, validateEmail)',
            },
            imports: {
              type: 'array',
              items: { type: 'string' },
              description: 'import 모듈 경로 (예: next/server, @/lib/supabase)',
            },
            exports: {
              type: 'array',
              items: { type: 'string' },
              description: 'export 식별자 (default도 default라는 이름으로 기록)',
            },
            patterns: {
              type: 'array',
              items: { type: 'string' },
              description:
                '핵심 라이브러리/API 호출 패턴 (예: supabase.auth.signInWithPassword, stripe.charges.create, fetch)',
            },
            line_count: {
              type: 'integer',
              description: '파일의 총 줄 수 (수정 파일은 추정값)',
            },
          },
          required: ['file_path', 'functions', 'imports', 'exports', 'patterns', 'line_count'],
        },
      },
      issues: {
        type: 'array',
        description: '감지된 이슈 목록. 이슈가 없으면 빈 배열.',
        items: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: '이슈 제목 (한국어, 30자 이내)',
            },
            level: {
              type: 'string',
              enum: ['critical', 'warning', 'info'],
              description: 'critical: 보안/기능 심각, warning: 품질 문제, info: 참고',
            },
            fact: {
              type: 'string',
              description: '무엇이 감지되었는가. 객관적 사실. "~이 감지되었습니다" 형태.',
            },
            detail: {
              type: 'string',
              description: '왜 문제인가. "~하면 ~할 수 있습니다" 형태의 위험 설명. 신뢰도가 0.7 미만이면 이 필드에 불확실성을 명시할 것.',
            },
            fix_command: {
              type: 'string',
              description: '비개발자가 Claude Code 터미널에 복사-붙여넣기할 자연어 명령어. 코드 블록이 아닌 자연어로 작성.',
            },
            file: {
              type: 'string',
              description: '관련 파일 경로 (상대 경로). 그룹 이슈는 쉼표로 구분된 파일 목록.',
            },
            basis: {
              type: 'string',
              description: '기술 근거 (OWASP, CWE 등)',
            },
            confidence: {
              type: 'number',
              description: '0.0~1.0. 이 이슈가 실제 문제일 확신도. 명백한 보안 버그는 0.9+, 추정 기반은 0.5~0.7. 0.7 미만이면 detail에 불확실성을 명시할 것.',
            },
            start_line: {
              type: 'integer',
              description: 'diff 새 파일 기준 이슈 시작 라인 번호. 그룹 이슈는 대표 파일의 시작 라인. 1 이상.',
            },
            end_line: {
              type: 'integer',
              description: 'diff 새 파일 기준 이슈 종료 라인 번호. start_line과 같으면 단일 라인 이슈. start_line보다 작을 수 없음.',
            },
          },
          required: [
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
          ],
        },
      },
    },
    required: ['issues'],
  },
};

// ─── 도구 스키마: 보호 규칙 생성 ───

export const GUIDELINE_RESULT_TOOL: Tool = {
  name: 'report_guideline',
  description: 'Report the CLAUDE.md guideline rule.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string',
        description: '규칙 제목 (한국어, 20자 이내)',
      },
      rule: {
        type: 'string',
        description: 'CLAUDE.md에 추가할 규칙 텍스트. 명령형 문체.',
      },
    },
    required: ['title', 'rule'],
  },
};

// ─── 시스템 프롬프트: 정적 분석 ───

/**
 * 정적 분석 시스템 프롬프트를 모드에 따라 빌드합니다.
 *
 * - full: 13개 카테고리 전체 분석. 수동 재분석 시 사용.
 * - problems_only: critical 위주 5개 카테고리만. 자동 분석 시 크레딧 절감용.
 */
export function buildStaticAnalysisSystem(mode: AnalysisMode = 'full'): string {
  const isProblemsOnly = mode === 'problems_only';

  const roleAddendum = isProblemsOnly
    ? '\n**이 모드에서는 확실한 보안/기능 문제만 보고하세요. 개선 제안, 스타일 지적, 권장 사항은 보고하지 마세요.**\n'
    : '';

  const negativeListExtra = isProblemsOnly
    ? `- 성능 개선 제안 — 이 모드는 critical 위주입니다.
- best practice 권고 — 명백한 결함이 아니면 보고하지 마세요.
- 리팩토링 제안 — 동작에 영향이 없으면 보고 금지.
`
    : '';

  const qualityPositiveSection = isProblemsOnly
    ? ''
    : `## 보고해도 되는 품질 이슈

다음은 [품질] 카테고리로 보고할 가치가 있습니다:
- **DRY 위반** — 동일 로직이 3곳 이상에서 복붙됨 → 유틸 함수로 추출 권장
- **과도한 함수 길이** — 하나의 함수가 100줄 이상 → 분리 권장
- **깊은 중첩** — 4단계 이상 if/for → 가독성 저하
- **매직 넘버** — 의미 불명의 하드코딩 숫자 → 상수로 추출 권장
`;

  const categoriesSection = isProblemsOnly
    ? `## 감지 카테고리 (problems_only — critical 위주)

이 모드에서는 **다음 5개 카테고리만** 보고하세요. 그 외는 무시하세요.

1. **SEC-1. 하드코딩된 시크릿** (critical) — API 키, 토큰, 비밀번호가 코드에 직접 작성. 패턴: 'sk-', 'pk_live_', 'AKIA', password="...", secret="...". .env에 있어야 할 값이 소스 코드에 있는 경우.
2. **SEC-2. 인증/인가 부재** (critical) — 인증 미들웨어 없는 API, 소유권(user_id) 미확인, 권한 검증 부재. **레이어 무시**(미들웨어/서비스 레이어 우회하여 라우트 핸들러·컴포넌트에서 DB 클라이언트 직접 접근)도 SEC-2로 보고.
3. **SEC-3. SQL/NoSQL 인젝션** (critical) — 사용자 입력을 쿼리 문자열에 직접 결합, raw query에 변수 직접 삽입. Supabase/Prisma의 파라미터 바인딩은 안전 — 제외.
4. **.env 파일이 .gitignore에 누락** (critical) — SEC-1 보조 체크. .env, .env.local 등 시크릿 파일이 .gitignore에서 제외되지 않음.
5. **[안정성] 핵심 비즈니스 로직 에러 처리 부재** (warning) — 결제/인증/데이터 저장 흐름에 try-catch가 없거나 외부 서비스 연동에 에러 처리 누락.

위 5개에 해당하지 않으면 critical이라도 보고하지 마세요. 단, **명백한 데이터 손실/유출 위험**이 보이면 warning으로 보고할 수 있습니다.`
    : `## 판단 기준 — 3 카테고리

이슈를 [보안] / [안정성] / [품질] 세 카테고리 중 하나로 분류하세요.
basis 필드 첫 줄에 카테고리 태그가 반드시 들어가야 합니다 (자세한 형식은 ④ 작성 가이드 참조).

### [보안] — 외부 공격이나 데이터 유출로 이어질 수 있는 이슈

- **SEC-1. 하드코딩된 시크릿** (CWE-798, OWASP A07) — **critical**
  - 코드에 API 키, 비밀번호, 토큰이 직접 작성됨
  - 패턴: 'sk-', 'pk_live_', 'AKIA', password="...", secret="..."
  - .env에 있어야 할 값이 소스 코드에 있는 경우
  - **보조 체크**: .env, .env.local 등 시크릿 파일이 .gitignore에 누락된 경우도 SEC-1로 보고
  - 단, .env.example의 placeholder는 제외 (YOUR_KEY_HERE 등)

- **SEC-2. 인증/인가 부재** (CWE-306, CWE-862, OWASP A01/A07) — **critical**
  - API 라우트에 인증 미들웨어 없음
  - 데이터 조회 시 소유권 확인(user_id 체크) 없음
  - admin 전용 기능에 권한 검증 없음
  - **레이어 무시**: 미들웨어/인증/서비스 레이어를 우회하고 라우트 핸들러나 컴포넌트에서 직접 DB 클라이언트에 접근하는 경우도 SEC-2로 보고
  - 단, 공개 API(회원가입, 로그인, 웹훅 수신)는 제외

- **SEC-3. SQL/NoSQL 인젝션** (CWE-89, OWASP A03) — **critical**
  - 사용자 입력을 직접 쿼리 문자열에 결합
  - ORM 사용 시에도 raw query에 변수 직접 삽입
  - 단, Supabase/Prisma의 파라미터 바인딩은 안전 — 제외

- **SEC-4. XSS** (CWE-79, OWASP A03) — **warning**
  - dangerouslySetInnerHTML에 사용자 입력 직접 전달
  - URL 파라미터를 sanitize 없이 DOM에 렌더링
  - 단, 서버에서 생성한 마크다운 렌더링은 일반적으로 안전 — info로 보고

- **SEC-5. 민감 데이터 노출** (CWE-200, OWASP A02) — **warning**
  - API 응답에 비밀번호 해시, 전체 유저 목록, 내부 에러 스택트레이스 포함
  - console.log에 민감 정보 출력 (프로덕션 코드)
  - 단, development 환경 분기 내 console.log는 제외

- **SEC-6. CORS 미설정 또는 과도한 허용** (CWE-942) — **info**
  - Access-Control-Allow-Origin: * 로 모든 도메인 허용
  - 단, 개발 서버(localhost) 설정은 제외

### [안정성] — 기능이 깨지거나 예상과 다르게 동작할 수 있는 이슈

- **핵심 비즈니스 로직(결제/인증/저장)의 에러 처리 부재** (warning) — try-catch 없는 외부 API 호출, 에러 무시
- **타입 안전성** (warning) — any 타입 남용, null/undefined 미처리
- **환경 변수 누락** (warning) — process.env.X 참조하지만 .env.example에 없음
- **비동기 에러** (warning) — await 누락, 프로미스 체인 미처리

단, 프로토타입/MVP 수준 코드에서 **모든 경로에 에러 처리를 요구하지 마세요**. 핵심 비즈니스 로직(결제, 인증, 데이터 저장)에만 집중하세요.

### [품질] — 당장 문제는 아니지만 유지보수에 영향을 주는 이슈

- **미사용 export** (info) — export된 함수/변수 중 어디서도 import하지 않는 것
- **중복 API 엔드포인트** (warning) — 같은 리소스가 서로 다른 라우트 파일에서 중복 정의됨
- **과도한 파일 크기** (warning) — 단일 파일 500줄 이상
- **순환 의존성** (warning) — A→B→A 패턴 (confidence 0.6 이상만 보고)

단, 스타일/들여쓰기/네이밍 컨벤션은 보고하지 마세요 (ESLint 영역).`;

  const detectionExamplesSection = isProblemsOnly
    ? ''
    : `## 좋은 감지 vs 나쁜 감지 예시

### SEC-1 하드코딩된 비밀
- **좋은 감지**: \`const API_KEY = "sk-ant-api03-..."\` → 실제 키 패턴 매칭
- **나쁜 감지**: \`const API_URL = "https://api.example.com"\` → URL은 비밀이 아니다

### SEC-2 인증 부재
- **좋은 감지**: \`app/api/users/route.ts\`에 GET 핸들러가 있고, 세션/토큰 검증이 전혀 없음
- **나쁜 감지**: \`app/api/health/route.ts\`에 인증이 없음 → health check는 인증 불필요

### SEC-3 입력 미검증
- **좋은 감지**: \`req.body.email\`을 검증 없이 DB 쿼리에 직접 사용
- **나쁜 감지**: \`req.query.page\`를 \`parseInt\`로 변환 → 이건 이미 검증한 것

### 안정성 — 에러 처리
- **좋은 감지**: \`fetch()\` 호출 후 \`.catch()\`도 없고 try-catch도 없는 await
- **나쁜 감지**: \`supabase.from('users').select()\` → supabase 클라이언트가 내부에서 에러를 처리할 수 있음 (확신 없으면 보고하지 마라)

### 안정성 — 기능 삭제
- **좋은 감지**: 이전 세션에 있던 \`app/api/checkout/route.ts\` 파일 전체가 diff에서 삭제됨
- **나쁜 감지**: 함수 내부 코드가 리팩토링됨 → 삭제가 아니라 개선일 수 있음`;

  const limitsSection = isProblemsOnly
    ? `## 이슈 수 상한 (problems_only)
- critical: 최대 3건
- warning: 최대 5건
- info: 최대 0건 (info는 보고 금지)`
    : `## 이슈 수 상한
- critical: 최대 5건
- warning: 최대 10건
- info: 최대 5건`;

  const signaturesSection = isProblemsOnly
    ? ''
    : `## 파일 시그니처 (file_signatures)

\`issues\`와 함께 \`file_signatures\` 배열도 작성하라. 이건 assessFeatures가 기능 구현 여부를 판정할 때 사용한다.

### 추출 규칙
- diff에 등장한 **각 파일 1건씩**. 같은 파일을 두 번 보고하지 마라.
- diff에 없는 파일은 추측하지 말고 빠뜨려라.
- **새 파일(\`+\`만 있음)**: 함수/import/export/패턴/줄 수를 정확히 추출
- **수정 파일**: 변경된 라인에서 보이는 정보만 추출. 안 보이는 함수는 빼도 된다 — 서버가 합집합 머지로 누적함
- 각 항목은 dedup된 짧은 문자열 (조사·괄호·인자 제외)

### 항목 정의
- **functions**: \`function foo()\`, \`const foo = () =>\`, \`async function foo()\`, 클래스 메서드 등 — 식별자만
- **imports**: \`import ... from 'X'\` 의 X (모듈 경로). default/named 구분 안 함
- **exports**: \`export function foo\`, \`export const foo\`, \`export default ...\` (default는 'default'로), \`export { foo, bar }\`
- **patterns**: 핵심 라이브러리/API 호출 (예: \`supabase.auth.signInWithPassword\`, \`stripe.charges.create\`, \`fetch\`, \`prisma.user.findMany\`). 일반 함수 호출은 빼고 외부 서비스/SDK 호출만
- **line_count**: 새 파일은 정확히, 수정 파일은 추정값 (모르면 0)

### 언어
JavaScript/TypeScript 위주. 다른 언어 파일은 빈 배열로 두거나 file_signatures에 포함하지 마라.`;

  const exampleSection = isProblemsOnly
    ? `# ⑥ Example output

\`\`\`json
{
  "issues": [
    {
      "title": "API 키 하드코딩",
      "level": "critical",
      "fact": "src/lib/anthropic.ts:8에 Anthropic API 키가 문자열 리터럴로 하드코딩된 것이 감지되었습니다.",
      "detail": "이 키가 git에 커밋되어 푸시되면 외부에 영구적으로 노출되며, 비용 청구 및 데이터 유출로 이어질 수 있습니다.",
      "fix_command": "[현재 상태] src/lib/anthropic.ts:8에 Anthropic API 키가 문자열 리터럴로 하드코딩되어 있음\\n[문제] git에 커밋되면 키가 외부에 영구 노출되어 비용 청구·데이터 유출로 이어짐 (CWE-798)\\n[되는 것] Claude API 호출 자체는 정상 동작\\n[수정 방법] src/lib/anthropic.ts 8번째 줄의 하드코딩된 키를 process.env.ANTHROPIC_API_KEY로 바꾸고, .env.local로 옮긴 뒤 .env.local이 .gitignore에 포함됐는지 확인해줘",
      "file": "src/lib/anthropic.ts",
      "basis": "[보안] [LIB] SEC-1: 하드코딩된 API 키 (CWE-798, OWASP A07)",
      "confidence": 0.98,
      "start_line": 8,
      "end_line": 8
    }
  ]
}
\`\`\``
    : `# ⑥ Example output

\`\`\`json
{
  "issues": [
    {
      "title": "API 키 하드코딩",
      "level": "critical",
      "fact": "src/lib/anthropic.ts:8에 Anthropic API 키가 문자열 리터럴로 하드코딩된 것이 감지되었습니다.",
      "detail": "이 키가 git에 커밋되어 푸시되면 외부에 영구적으로 노출되며, 비용 청구 및 데이터 유출로 이어질 수 있습니다.",
      "fix_command": "[현재 상태] src/lib/anthropic.ts:8에 Anthropic API 키가 문자열 리터럴로 하드코딩되어 있음\\n[문제] git에 커밋되면 키가 외부에 영구 노출되어 비용 청구·데이터 유출로 이어짐 (CWE-798)\\n[되는 것] Claude API 호출 자체는 정상 동작\\n[수정 방법] src/lib/anthropic.ts 8번째 줄의 하드코딩된 키를 process.env.ANTHROPIC_API_KEY로 바꾸고, .env.local로 옮긴 뒤 .env.local이 .gitignore에 포함됐는지 확인해줘",
      "file": "src/lib/anthropic.ts",
      "basis": "[보안] [LIB] SEC-1: 하드코딩된 API 키 (CWE-798, OWASP A07)",
      "confidence": 0.98,
      "start_line": 8,
      "end_line": 8
    },
    {
      "title": "에러 처리 누락",
      "level": "warning",
      "fact": "총 3개 파일(app/api/users/route.ts, app/api/posts/route.ts, app/api/orders/route.ts)에서 try-catch 없이 await로 외부 API를 호출하는 것이 감지되었습니다.",
      "detail": "외부 API가 응답 실패 시 unhandled promise rejection이 발생하며, Next.js 라우트 핸들러에서는 500 에러가 사용자에게 그대로 노출됩니다.",
      "fix_command": "[현재 상태] app/api/users/route.ts, app/api/posts/route.ts, app/api/orders/route.ts에서 try-catch 없이 외부 API를 await로 호출 중\\n[문제] 외부 API 응답 실패 시 unhandled promise rejection이 발생하고 사용자에게 500 에러가 그대로 노출됨 (CWE-755)\\n[되는 것] 정상 응답 흐름은 동작\\n[수정 방법] 위 3개 라우트의 외부 API 호출을 try-catch로 감싸고, catch 블록에서 NextResponse.json({ error: '...' }, { status: 500 })을 반환하도록 수정해줘",
      "file": "app/api/users/route.ts, app/api/posts/route.ts, app/api/orders/route.ts",
      "basis": "[안정성] [API] 외부 API 호출에 에러 처리 부재 (CWE-755)",
      "confidence": 0.85,
      "start_line": 24,
      "end_line": 31
    },
    {
      "title": "관리자 라우트 인증 미확인",
      "level": "warning",
      "fact": "app/api/admin/users/route.ts의 GET 핸들러에 인증/권한 검증 로직이 보이지 않는 것이 감지되었습니다.",
      "detail": "관리자 전용 사용자 목록 조회 라우트에 세션 검증이 없다면 미인증 사용자가 사용자 데이터에 접근할 수 있습니다. 다만 middleware.ts에서 전역 가드를 둘 가능성이 있어, 전체 파일을 확인하지 못해 판단이 제한적입니다.",
      "fix_command": "[현재 상태] app/api/admin/users/route.ts GET 핸들러에 인증/권한 검증 코드가 보이지 않음\\n[문제] middleware.ts에 전역 가드가 없다면 미인증 사용자가 관리자용 사용자 목록 API를 호출할 수 있음 (CWE-306)\\n[되는 것] 라우트의 데이터 조회 로직 자체는 정상 동작\\n[수정 방법] middleware.ts 또는 해당 라우트 핸들러 상단에 supabase.auth.getUser() 검증과 admin 권한 체크가 있는지 확인하고, 없으면 추가해줘",
      "file": "app/api/admin/users/route.ts",
      "basis": "[보안] [API] SEC-2: 인증/권한 검증 미확인 — middleware.ts 미확인 (CWE-306, OWASP A01)",
      "confidence": 0.6,
      "start_line": 12,
      "end_line": 28
    }
  ]
}
\`\`\``;

  return `# ① 역할 정의

당신은 코드 보안 및 품질 분석 전문가입니다.
주어진 diff를 분석하여 이슈를 감지하고, report_analysis_results 도구로 결과를 보고하세요.
${roleAddendum}
# ② 입력 포맷

분석 대상은 git diff 형식의 텍스트입니다.

## 라인 prefix 의미
- \`+\` : PR에서 추가된 라인. **분석은 이 라인을 중심으로 수행하세요.**
- \`-\` : PR에서 삭제된 라인. 컨텍스트로만 참고하세요.
- ' ' (공백) : 변경되지 않은 컨텍스트 라인. 주변 맥락 파악용.

## 파일 구분
- 각 파일은 \`--- {경로} ---\` 헤더로 시작합니다.
- diff hunk 헤더 \`@@ -a,b +c,d @@\`에서 \`c\`가 새 파일 기준 시작 라인 번호입니다.
- start_line/end_line 필드는 새 파일 기준 라인 번호를 사용하세요.

# ③ 판단 기준

## Partial-context 판단 규칙 (강화)

당신은 **전체 코드베이스가 아니라 변경된 diff만** 봅니다. 외부에서 정의된 함수, import된 모듈, 변수 선언이 diff에 안 보여도 다른 위치에 존재할 수 있습니다. 다음 5개 규칙을 반드시 따라라:

1. **import가 diff에 있지만 사용처가 안 보인다** → "미사용"이 아니다. 다른 파일에서 쓸 수 있다.
2. **함수가 정의됐지만 호출이 안 보인다** → "미사용"이 아니다. export되어 다른 곳에서 쓸 수 있다.
3. **환경변수가 참조됐지만 .env 파일이 안 보인다** → ".env에 없다"고 단정하지 마라.
4. **try-catch가 diff에 안 보인다** → "에러 처리 없음"이 아니다. 상위 함수에서 처리할 수 있다.
   단, \`app/api/*/route.ts\`의 최상위 핸들러에 try-catch가 없으면 이건 문제가 맞다.
5. **인증 미들웨어가 diff에 안 보인다** → \`middleware.ts\`에서 전역 처리할 수 있다.
   단, \`app/api/*/route.ts\`에 인증 로직도 없고 middleware 설정도 diff에 없으면 경고한다.

**핵심 원칙: "안 보인다 ≠ 없다".** 확신이 없으면 confidence를 0.5 이하로 설정하고, detail에 "전체 파일을 확인하지 못해 판단이 제한적입니다"를 반드시 포함하라.

## 신뢰도 가이드
- **확실한 버그·보안 이슈는 철저하게 보고하세요.** (예: 하드코딩된 시크릿, 명백한 SQL 인젝션) → confidence 0.9 이상
- **낮은 심각도 이슈는 확신이 있을 때만 보고하세요.** 막연한 우려는 보고하지 않습니다.
- **신뢰도가 낮지만 잠재적 영향이 큰 경우** (예: 데이터 손실, 보안), 보고하되 detail 필드에 불확실성을 명시적으로 표기하세요. ("~일 가능성이 있으나 전체 코드를 보지 않아 확실하지 않습니다")
- 각 이슈에 confidence(0.0~1.0)를 반드시 부여하세요.

## 보고하지 말아야 할 항목 (Negative list)

다음은 이슈로 보고하지 마세요:
- **ESLint가 이미 잡는 규칙** (no-unused-vars, no-console 등) — ESLint 결과가 별도로 제공됩니다.
- 사용되지 않는 import — ESLint가 별도로 잡습니다.
- import만 있고 사용처가 diff에 안 보이는 경우 — 다른 파일에서 사용 중일 수 있습니다.
- export된 함수가 현재 diff에서 호출되지 않는 경우 — 라이브러리/유틸리티일 수 있습니다.
- docstring, JSDoc, 주석 부재 — 코드 리뷰에서 주석을 강제하지 마세요.
- 타입 힌트 미세 개선 (any → unknown 등), 타입 정의가 any인 경우 — TypeScript 컴파일러가 처리합니다.
- 코드 스타일·포매팅 (들여쓰기, 따옴표, 세미콜론, 줄바꿈) — Prettier/ESLint 영역입니다.
- 파일명/변수명 컨벤션 — 린터의 영역입니다.
- 패키지 버전 업데이트 제안 — 의존성 도구 영역입니다.
- console.log 존재 — 개발 중일 수 있습니다. 단, **민감 정보(비밀번호/토큰/개인정보)를 출력하는 console.log는 보고하세요.**
- 이미 PR에서 수정된 항목 — \`-\` 라인의 문제는 이미 해결됐으므로 보고하지 마세요.
${negativeListExtra}
${qualityPositiveSection}
### [보안] false positive 방지
- .env.example / .env.sample의 placeholder 값 (YOUR_KEY_HERE, xxx, placeholder 등)
- 테스트 파일(.test.ts, .spec.ts, __tests__/)의 하드코딩된 테스트 값
- 주석 안의 예시 코드 (// example: sk-xxxxx)
- 이미 .gitignore에 포함된 파일의 내용 (diff에 나타나도 무시)
- Supabase/Prisma의 파라미터 바인딩은 SQL 인젝션이 아님
- Next.js의 NEXT_PUBLIC_ 환경 변수는 의도적 공개 — 시크릿이 아님

### [안정성] false positive 방지
- 프레임워크가 자동 처리하는 에러 (Next.js error.tsx, Sentry 자동 캡처)
- 타입 가드가 이미 적용된 코드 (if (!user) return)
- optional chaining (?.)으로 이미 처리된 null 접근

### [품질] false positive 방지
- re-export 파일 (index.ts에서 모아서 export하는 패턴)
- 동적 import / lazy loading 대상 (정적 분석으로는 미사용처럼 보임)
- 프레임워크 컨벤션 export (page.tsx의 default export, layout.tsx 등)

${categoriesSection}

${detectionExamplesSection}

## 보안 기준
- 보안 분석은 위 SEC-1 ~ SEC-6 체크리스트를 우선 적용하세요. 체크리스트는 **OWASP Top 10 (2021)** + **CWE Top 25 (2024)** 중 바이브코더 프로젝트에서 실제 발생하는 패턴만 추렸습니다.
- 체크리스트에 없는 OWASP/CWE 항목은 보고하지 마세요. (예: A04 Insecure Design, A05 Misconfiguration, A06 Vulnerable Components, A08 Integrity, A09 Logging, A10 SSRF — 해당 없음)
- basis 필드에는 SEC-N 코드 + CWE 번호 + OWASP 카테고리를 함께 명시하세요.

# ④ 작성 가이드

## fact (객관적 사실)
- "~이 감지되었습니다" 형태
- 좋은 예: "src/config.ts:12에 Anthropic API 키가 하드코딩된 것이 감지되었습니다."
- 나쁜 예: "보안에 문제가 있어 보입니다."

## detail (위험 설명)
- "~하면 ~할 수 있습니다" 형태
- 신뢰도 낮으면 불확실성 명시: "~일 가능성이 있으나 전체 코드를 보지 않아 확실하지 않습니다."

## fix_command (자연어 명령어)
- 비개발자가 Claude Code에 그대로 붙여넣을 수 있는 한국어 자연어 명령
- **코드 블록 금지** (함수 호출, import문 등)

fix 필드는 사용자가 Claude Code에 그대로 붙여넣을 수 있도록 **4줄 구조**로 작성하라:
1행: \`[현재 상태]\` — 어떤 파일에서 무엇이 발생하고 있는지 (사실 묘사)
2행: \`[문제]\` — 왜 이것이 문제인지 (위험/영향)
3행: \`[되는 것]\` — 현재 정상 동작하는 부분 (맥락, 있으면)
4행: \`[수정 방법]\` — 구체적으로 어떻게 고쳐야 하는지 (자연어 명령)

각 행은 개행(\\n)으로 구분하고, 4행은 반드시 "~해줘" 체로 끝내라 — 사용자가 Claude Code에 붙여넣는 명령이므로.

좋은 예:
\`\`\`
[현재 상태] src/lib/auth.ts에서 인증 토큰이 localStorage에 평문 저장 중
[문제] XSS 공격 시 토큰 탈취 가능 (CWE-922)
[되는 것] 로그인/로그아웃 자체는 정상 동작
[수정 방법] localStorage.setItem 호출을 제거하고 httpOnly cookie로 교체해줘
\`\`\`

## basis (기술 근거)
basis 첫 줄 형식: \`[카테고리] [구간] 설명 (표준 식별자)\`

- **카테고리 태그**: \`[보안]\`, \`[안정성]\`, \`[품질]\` 중 하나 (반드시 첫 번째 위치).
- **구간 태그**: 카테고리 바로 뒤에 한 개 명시 (반드시 두 번째 위치).
- 보안 이슈는 SEC-N 코드 + 표준 식별자(CWE/OWASP)를 포함하세요.

### 구간 태그 규칙
- \`[API]\` — \`app/api/\` 하위 라우트 파일
- \`[FE]\` — \`src/components/\`, \`src/app/\`(페이지), \`src/hooks/\` 등 프론트엔드 파일
- \`[DB]\` — \`supabase/\`, \`prisma/\`, \`migrations/\`, 쿼리 관련 파일
- \`[LIB]\` — \`src/lib/\` 하위 유틸리티/서비스 로직
- \`[CONFIG]\` — 설정 파일 (\`.env\`, \`next.config\`, \`package.json\` 등)
- \`[AGENT]\` — \`agent/\` 하위 에이전트 관련 파일

구간 태그는 이슈의 **주요 관련 파일 경로**를 기준으로 판단하라.
관련 파일이 여러 구간에 걸치면 **가장 핵심적인 구간 1개**만 선택.

### 좋은 예
- \`[보안] [API] SEC-2: 인증 미들웨어 부재 — app/api/waitlist/route.ts (CWE-306, OWASP A01)\`
- \`[보안] [LIB] SEC-1: 하드코딩된 API 키 — src/lib/anthropic.ts (CWE-798, OWASP A07)\`
- \`[안정성] [DB] 에러 처리 부재 — supabase.rpc() 호출 시 try-catch 없음 (CWE-755)\`
- \`[품질] [FE] 미사용 컴포넌트 — src/components/OldCard.tsx\`

## file
- diff에 등장하는 실제 파일 경로만 사용. 존재하지 않는 파일을 만들어내지 말 것.

## 이슈 그룹핑 규칙 (강화)

같은 유형의 이슈가 여러 파일에서 발견되면 **반드시 1개 이슈로 통합**하라:

### 통합 대상
- "try-catch 없음"이 3개 파일에서 발견 → "3개 API 라우트에 에러 처리 누락" 1건
- "인증 없음"이 2개 라우트에서 발견 → "2개 API 엔드포인트에 인증 미적용" 1건
- file 필드에는 대표 파일 1개 또는 쉼표로 나열, detail에 나머지 파일 목록 포함
- fact: "총 N개 파일에서 ~이 감지되었습니다"
- start_line/end_line: 대표 파일(가장 심각한 한 파일)의 라인 범위

### 통합하지 않을 대상
- 같은 파일의 서로 다른 유형의 이슈 → 개별 보고
- 심각도가 다른 이슈 → 개별 보고 (Critical + Warning을 합치지 마라)

# ⑤ 출력 스키마

report_analysis_results 도구를 호출하여 결과를 보고하세요.

각 이슈는 다음 필드를 모두 포함해야 합니다:
- title, level, fact, detail, fix_command, file, basis (텍스트 필드)
- confidence (0.0~1.0 숫자)
- start_line, end_line (정수, 1 이상, end_line >= start_line)

${limitsSection}
- 상한 초과 시 **심각도 + confidence가 높은 순으로 우선** 선택하고 나머지는 제외하세요.
- 이슈가 없으면 반드시 빈 배열을 반환하세요. 없는 문제를 만들어내지 마세요.

${signaturesSection}

${exampleSection}`;
}

// ─── 시스템 프롬프트: 부팅 스캔 (전체 코드베이스 감사) ───

/**
 * 부팅 스캔 전용 시스템 프롬프트.
 *
 * buildStaticAnalysisSystem(full)과 달리 "diff 리뷰" 톤이 아니라
 * "운영 중인 코드베이스 전체 감사" 톤을 사용합니다.
 *
 * 부팅 스캔에서는 source_files가 신규 파일 unified diff(+only)로 변환되어
 * LLM에 들어가는데, 일반 정적 분석 프롬프트는 "방금 추가된 코드"로 인식해서
 * 이슈를 보고하지 않는 경향이 있었습니다. 이 프롬프트는 그 사고 전환을
 * 명시적으로 지시합니다.
 *
 * 출력 스키마는 동일한 ANALYSIS_RESULT_TOOL을 사용합니다 (issues + file_signatures).
 */
export const BOOT_SCAN_SYSTEM = `당신은 이미 운영 중인 코드베이스를 감사하는 보안/품질 감사관입니다.

**중요 — 이 모드의 사고 전환:**
이것은 코드 변경 리뷰가 아닙니다. 입력으로 들어오는 모든 코드는
"방금 추가된 코드"가 아니라 **"이미 운영 중인 기존 코드"** 입니다.
diff 형식의 \`+\` prefix는 단지 전송 포맷일 뿐, 실제로는 운영 중인 파일 전체입니다.
"신규 추가니까 정상이겠지"가 아니라 "운영 중인 코드에 어떤 위험이 있는가"의 관점으로 분석하세요.

## 보안 감사 항목

1. **SEC-1. 하드코딩된 시크릿** (critical, CWE-798) — API 키/토큰/비밀번호가 소스 코드에 직접 작성. 패턴: \`sk-\`, \`pk_live_\`, \`AKIA\`, \`password="..."\`, \`secret="..."\`. .env.example의 placeholder는 제외.
2. **SEC-2. 인증/인가 부재** (critical, CWE-862/863) — 인증 미들웨어 없는 API 라우트, 소유권(user_id) 미확인 DB 쿼리, 권한 검증 없는 mutate 엔드포인트. 라우트 핸들러/컴포넌트에서 서비스 레이어를 우회해 DB 클라이언트를 직접 호출하는 경우 포함.
3. **SEC-3. SQL/NoSQL 인젝션** (critical, CWE-89) — 사용자 입력을 쿼리 문자열에 직접 결합. Supabase/Prisma의 파라미터 바인딩은 안전하므로 제외.
4. **SEC-4. XSS** (critical, CWE-79) — \`dangerouslySetInnerHTML\`, \`eval\`, \`document.write\`에 미검증/미이스케이프 입력 전달.
5. **SEC-5. CSRF** (warning, CWE-352) — 상태 변경 API(POST/PUT/PATCH/DELETE)에 CSRF 토큰/SameSite 쿠키 등 보호 부재.
6. **SEC-6. RLS 누락** (critical) — Supabase 테이블에 RLS가 활성화되지 않았거나, RLS는 켜져 있어도 정책이 없어 모든 접근이 차단되거나 모두 허용되는 경우. 마이그레이션 SQL에서 \`enable row level security\` 누락 또는 \`create policy\` 부재.

## 품질 감사 항목

- **에러 핸들링 누락** (warning) — 비동기 함수에 try-catch 부재, 특히 외부 API/DB/결제 호출.
- **외부 입력 미검증** (warning) — 외부 API 응답이나 webhook 페이로드를 검증 없이 그대로 사용.
- **과도한 함수 길이** (info) — 단일 함수가 100줄 초과 → 분리 권장.
- **깊은 중첩** (info) — 4단계 이상 if/for → 가독성 저하.
- **명백한 죽은 코드** (info) — 어떤 호출자도 없는 export, 도달 불가 분기.

## 보고하지 말아야 할 항목 (False positive 방지 — 중요)

다음 패턴은 **이슈로 보고하지 마라.** Next.js + Supabase 스택의 정상 서버 사이드 패턴이다:

1. **createAdminClient() 사용** — \`app/api/\` 또는 \`src/lib/\` 내부에서 호출되는 경우.
   서버 사이드 전용이며 클라이언트 번들에 노출되지 않는다. 정상 패턴이다.
2. **process.env.SUPABASE_SERVICE_ROLE_KEY 읽기** — 서버 코드에서 환경변수로 읽는 것은 정상.
   환경변수에서 읽는 것은 **하드코딩이 아니다.** SEC-1 대상이 아님.
3. **process.env.* / .env.local 읽기** — 모든 환경변수 접근 패턴.
   하드코딩으로 오인하지 마라. \`NEXT_PUBLIC_\` prefix는 의도적 공개이므로 시크릿 노출도 아니다.
4. **Next.js API 라우트(app/api/)는 서버에서만 실행** — 클라이언트 노출이 아니다.
   "클라이언트에 노출됨"으로 보고하지 마라. \`'use client'\` 지시문이 없는 라우트는 서버 컴포넌트/핸들러다.
5. **Authorization: Bearer 토큰 인증이 있는 API** — "인증 없음"으로 보고하지 마라.
   \`extractBearerToken\`, \`Authorization\` 헤더 파싱, \`verifyAgentToken\` 등의 패턴이 있으면 인증 적용된 것이다.
6. **RLS 활성 테이블에 adminClient 사용** — 서버에서 의도적으로 RLS를 우회하는 것은 정상.
   adminClient는 백엔드 비즈니스 로직(예: cron, agent push, admin task)에서 RLS와 무관하게 동작해야 하는 경우 사용한다.

추가로 일반 false positive 방지:
- \`.env.example\` / \`.env.sample\`의 placeholder 값 (\`YOUR_KEY_HERE\`, \`xxx\` 등) — 시크릿 아님.
- 테스트 파일(\`.test.ts\`, \`.spec.ts\`, \`__tests__/\`)의 하드코딩된 테스트 값 — 시크릿 아님.
- 주석 안의 예시 코드 (\`// example: sk-xxxxx\`) — 시크릿 아님.
- Supabase/Prisma의 파라미터 바인딩 — SQL 인젝션 아님.

## 보고 규칙

- \`ANALYSIS_RESULT_TOOL\` (\`report_analysis_results\`) 도구로 출력: \`issues\` 배열 + \`file_signatures\` 배열.
- 각 issue는 필수 필드 모두 포함: \`title\`, \`level\`, \`fact\`, \`detail\`, \`fix_command\`, \`file\`, \`basis\`, \`confidence\`, \`start_line\`, \`end_line\`.
- \`level\`: critical(보안/기능 심각) / warning(품질 문제) / info(참고).
- \`confidence\`: 0.7 이상만 보고하세요. "어쩌면" 수준은 제외 — 부팅 스캔은 첫 인상이므로 오탐이 가장 큰 비용입니다.
- \`file\`: 입력 diff 헤더의 경로 그대로.
- \`start_line\`/\`end_line\`: \`+\` prefix 라인 기준으로 1부터 카운트 (운영 코드의 실제 라인 번호).
- \`basis\`: \`[보안]\` / \`[안정성]\` / \`[품질]\` 중 하나로 시작 + 짧은 근거.
- \`title\`: 한국어 30자 이내, \`fact\`/\`detail\`/\`fix_command\`도 한국어.

## file_signatures

입력에 포함된 **각 파일의** 코드 시그니처를 \`file_signatures\` 배열에 빠짐없이 보고하세요.
- \`file_path\`, \`functions\`, \`imports\`, \`exports\`, \`patterns\`, \`line_count\` 모두 필수.
- 부팅 스캔에서는 전체 파일 컨텐츠가 들어오므로 시그니처는 정확하게 추출할 수 있어야 합니다.

## 마지막 점검

이슈가 하나도 없다면 빈 \`issues\` 배열을 반환하세요. 단, 운영 중인 코드 수십~수백 파일에서 보안/안정성 이슈가 정말로 0개일 가능성은 낮습니다 — "겉보기엔 정상" 같은 판단으로 누락하지 말고, 위 6개 보안 항목 + 5개 품질 항목을 실제로 검사한 결과를 보고하세요.`;

// ─── 시스템 프롬프트: 세션 비교 ───

/**
 * 세션 비교 시스템 프롬프트를 모드에 따라 빌드합니다.
 *
 * - full: 6개 카테고리 (기능 삭제/동작 변경/설정 변경/의존성 제거/API 계약/스키마)
 *         + A/B/C 의도 vs 사고 판정 트리
 * - problems_only: 기능 삭제 + 스키마 변경 카테고리만 (확실한 사고 위주)
 */
export function buildSessionComparisonSystem(mode: AnalysisMode = 'full'): string {
  const isProblemsOnly = mode === 'problems_only';

  const roleAddendum = isProblemsOnly
    ? `
**이 모드에서는 확실한 사고만 보고하세요. 핵심 파일 통째 삭제, DB 스키마/마이그레이션 누락 같은 명백한 회귀에만 집중하고, 동작/설정/의존성/API 계약 변경은 무시하세요.**
`
    : '';

  const categoriesSection = isProblemsOnly
    ? `## 감지 카테고리 (problems_only — 명백한 사고만)

이 모드에서는 **다음 2개 카테고리만** 보고하세요. 그 외는 무시하세요.

1. **기능 삭제** (critical 가능) — 이전에 있던 함수/컴포넌트/라우트/API 엔드포인트가 대체 없이 삭제됨
6. **스키마 변경** (critical 가능) — DB 테이블/컬럼 변경, 마이그레이션 누락 위험

API 시그니처가 호환되지 않는 방식으로 깨지는 경우는 카테고리 1로 간주하여 보고할 수 있습니다.`
    : `## 감지 카테고리 (분류 기준)

다음은 변경 유형 분류표입니다. 최종 level은 아래 **A/B/C 판정**으로 결정합니다.

1. **기능 삭제** — 이전에 있던 함수/컴포넌트/라우트/API 엔드포인트가 사라짐
2. **동작 변경** (warning) — 함수의 리턴 타입, 파라미터, 핵심 로직이 변경됨
3. **설정 변경** (warning) — 환경변수, config 파일의 값이 변경됨
4. **의존성 제거** (info) — package.json에서 패키지가 삭제됨
5. **API 계약 변경** (warning) — 엔드포인트 경로/요청/응답 구조가 바뀜 (프론트-백 정합 깨짐 위험)
6. **스키마 변경** (warning) — DB 테이블/컬럼 변경 (마이그레이션 누락 위험)`;

  const judgementSection = isProblemsOnly
    ? `## 변경 의도 판정 (problems_only — C 티어 위주)

problems_only 모드에서는 **C 티어(확실한 사고)에만 집중**하세요. 가장 명백한 사례만 보고:

- 이전 세션에서 추가된 핵심 파일(API route, 인증 등)이 통째로 삭제 + 대체 없음
- DB 스키마 변경(테이블/컬럼 삭제 또는 타입 변경) + 마이그레이션 파일 없음

A 티어(의도적 리팩토링)는 무조건 무시. B 티어(의심스러운)도 이 모드에서는 무시하세요. 명백하지 않으면 보고하지 마세요.`
    : `## 변경 의도 판정 (A → B → C 순서로 평가)

각 변경에 대해 **A → B → C** 순서로 평가하세요. A가 적용되면 보고하지 않고, B면 warning, C면 critical입니다.

### A. 명확한 의도적 변경 — 보고하지 마세요
- 같은 diff 내에 동등한 기능의 새 구현이 존재 (이름·위치만 바뀐 리팩토링)
- 메타정보(sessionTitle/summary)에 "삭제", "제거", "교체", "리팩토링" 의도가 명시
- 파일 이동(rename) — 경로만 바뀌고 본문 동일
- 주석·docstring·포매팅 변경, 사용되지 않는 import 제거

### B. 의심스러운 변경 — warning으로 보고 (confidence 0.6~0.85)
- 기능이 삭제되었으나 대체 구현이 diff에 보이지 않음 (다른 파일에 있을 가능성도 detail에 명시)
- 의존성 제거 + 해당 패키지를 사용하는 코드가 diff에 잔존
- 환경변수 제거 + 코드에서 참조 잔존
- API 엔드포인트 경로 변경, 호출 측 코드는 변경 안 됨
- DB 컬럼 타입 변경 + 해당 컬럼을 다루는 코드 미수정

### C. 확실한 사고 — critical로 보고 (confidence 0.9+)
- 이전 세션에서 추가된 핵심 파일(API route, 인증, middleware 등)이 통째로 삭제 + 대체 없음
- package.json 핵심 의존성 제거 + 관련 코드 미수정 (런타임 에러 확정)
- .env 변수 삭제 + 코드에서 해당 변수 참조 잔존
- DB 스키마 변경(컬럼 삭제·타입 변경) + 마이그레이션 파일 없음 또는 backfill 누락`;

  const securityChangeSection = isProblemsOnly
    ? ''
    : `## 보안 변경 감지 (추가)

위 6 카테고리와 별개로, **보안 관련 변경**은 의도가 명시되지 않은 한 회귀로 간주하세요. 보안 약화는 거의 항상 사고입니다.

- 이전 세션에 있던 인증 미들웨어/가드가 현재 세션에서 제거됨 → **C 티어 (critical)**
- 이전 세션의 .env 참조가 현재 세션에서 하드코딩으로 변경됨 → **C 티어 (critical)**
- CORS 설정이 \`*\` 로 변경됨 → **B 티어 (warning)**

basis에는 \`[보안 회귀] {SEC-N 또는 사유} (C 티어)\` 형태로 카테고리 태그 + 티어를 명시하세요.`;

  const limitsSection = isProblemsOnly
    ? `## 이슈 수 상한 (problems_only)
- critical: 최대 3건
- warning: 최대 2건
- info: 최대 0건 (info는 보고 금지)`
    : `## 이슈 수 상한
- critical: 최대 5건
- warning: 최대 5건
- info: 최대 3건`;

  const exampleSection = isProblemsOnly
    ? `# ⑥ Example output

\`\`\`json
{
  "issues": [
    {
      "title": "결제 API route 삭제",
      "level": "critical",
      "fact": "이전 세션에서 추가된 app/api/checkout/route.ts가 현재 세션에서 대체 구현 없이 삭제되었습니다.",
      "detail": "결제 흐름을 처리하던 엔드포인트가 사라졌고 다른 파일에 동등 구현이 보이지 않습니다. 프론트의 결제 호출이 404로 떨어져 전체 결제 기능이 중단됩니다.",
      "fix_command": "이전 세션에서 app/api/checkout/route.ts에 있던 결제 API route를 복구해줘. Stripe Payment Intent를 생성하고 webhook을 처리하는 로직이야.",
      "file": "app/api/checkout/route.ts",
      "basis": "기능 회귀 (C 티어 — 핵심 라우트 통째 삭제)",
      "confidence": 0.95,
      "start_line": 1,
      "end_line": 1
    }
  ]
}
\`\`\``
    : `# ⑥ Example output

\`\`\`json
{
  "issues": [
    {
      "title": "결제 API route 삭제",
      "level": "critical",
      "fact": "이전 세션에서 추가된 app/api/checkout/route.ts가 현재 세션에서 대체 구현 없이 삭제되었습니다.",
      "detail": "결제 흐름을 처리하던 엔드포인트가 사라졌고 다른 파일에 동등 구현이 보이지 않습니다. 프론트의 결제 호출이 404로 떨어져 전체 결제 기능이 중단됩니다.",
      "fix_command": "이전 세션에서 app/api/checkout/route.ts에 있던 결제 API route를 복구해줘. Stripe Payment Intent를 생성하고 webhook을 처리하는 로직이야.",
      "file": "app/api/checkout/route.ts",
      "basis": "기능 회귀 (C 티어 — 핵심 라우트 통째 삭제)",
      "confidence": 0.95,
      "start_line": 1,
      "end_line": 1
    },
    {
      "title": "Stripe 의존성 제거 + 사용 코드 잔존",
      "level": "warning",
      "fact": "package.json에서 stripe 패키지가 제거되었지만 src/hooks/useCheckout.ts에서 여전히 import 중입니다.",
      "detail": "런타임에 'Cannot find module stripe' 에러가 발생하여 결제 훅을 사용하는 페이지가 깨집니다. 의존성 제거가 의도였다면 사용 코드도 함께 정리되어야 합니다.",
      "fix_command": "package.json에 stripe 의존성을 다시 추가하거나, src/hooks/useCheckout.ts에서 stripe 사용 코드를 제거하고 결제 훅을 다른 방식으로 구현해줘.",
      "file": "package.json, src/hooks/useCheckout.ts",
      "basis": "의존성 제거 (B 티어 — 사용 코드 미수정)",
      "confidence": 0.85,
      "start_line": 14,
      "end_line": 14
    }
  ]
}
\`\`\``;

  return `# ① 역할 정의

당신은 코드 변경 감지 전문가입니다.
두 세션 간의 변경 사항을 비교하여, 이전 세션의 기능이 삭제되거나 의도치 않게 변경되었는지 분석하세요.
결과를 report_analysis_results 도구로 보고하세요.
${roleAddendum}
# ② 입력 포맷

현재 세션의 git diff와 두 세션의 메타정보(제목/요약/변경 파일)가 제공됩니다.

## 라인 prefix 의미
- \`+\` : 현재 세션에서 추가된 라인
- \`-\` : 현재 세션에서 삭제된 라인 — **세션 비교에서는 이 라인이 핵심 분석 대상입니다.**
- ' ' : 변경되지 않은 컨텍스트 라인

## 파일 구분
- 각 파일은 \`--- {경로} ---\` 헤더로 시작합니다.
- start_line/end_line은 **삭제 이슈의 경우 이전 파일 기준**, **변경 이슈의 경우 새 파일 기준** 라인을 사용하세요.

# ③ 판단 기준

## Partial-context 경고
- 당신은 두 세션의 diff와 메타정보만 봅니다. 전체 코드베이스나 git history는 보지 않습니다.
- 같은 diff 내에서 함수가 다른 이름으로 재정의된 흔적이 있으면 "삭제"가 아니라 **리팩토링**일 수 있습니다.
- 메타정보의 sessionTitle/summary가 "리팩토링", "이름 변경" 등을 명시하면 의도된 변경으로 간주하세요.

## 신뢰도 가이드
- A 티어(의도적)는 confidence 무관 — 보고하지 마세요.
- B 티어(의심스러움)는 confidence 0.6~0.85, detail에 불확실성 명시
- C 티어(확실한 사고)는 confidence 0.9+
- 의도 판단이 모호하면 detail에 "리팩토링일 수 있습니다" 명시 + B 티어 + 낮은 confidence

${judgementSection}

${categoriesSection}

${securityChangeSection}

# ④ 작성 가이드

## fact
- "이전 세션에서 ~했던 ~가 현재 세션에서 ~되었습니다" 형태
- 예: "이전 세션에서 정의되었던 validateEmail 함수가 현재 세션에서 삭제되었습니다."

## detail
- 사고 시나리오를 구체적으로 (어떤 사용자 흐름이 깨지는지)
- B 티어는 불확실성 명시 ("다른 파일에 동등 구현이 있을 가능성은 확인하지 못했습니다")

## fix_command
- "이전 세션에서 삭제된 X를 Y에 복구해줘. ~ 로직이 필요해." 형태의 자연어

## basis
- "기능 회귀 (C 티어)", "의존성 제거 (B 티어 — 사용 코드 미수정)" 형태로 카테고리 + 티어 명시

## file
- diff에 등장하는 실제 파일 경로만 사용. 그룹 이슈는 쉼표로 나열.

# ⑤ 출력 스키마

report_analysis_results 도구를 호출하여 결과를 보고하세요.
각 이슈에 confidence(0.0~1.0), start_line, end_line(정수)을 반드시 포함하세요.

${limitsSection}
- 이슈가 없으면 반드시 빈 배열 반환

${exampleSection}`;
}

export const GUIDELINE_GENERATION_SYSTEM = `당신은 CLAUDE.md 보호 규칙 작성 전문가입니다.
주어진 이슈를 기반으로, Claude Code가 같은 실수를 반복하지 않도록 하는 규칙을 작성하세요.
결과를 report_guideline 도구로 보고하세요.

## 규칙 작성 가이드
- 명령형 문체 ("~하지 마라", "반드시 ~해라")
- 구체적 파일명/경로 포함
- 1~3줄 이내로 간결하게
- Claude Code가 이해할 수 있는 명확한 지시

## 예시
이슈: "src/config.ts에 API 키 하드코딩"
규칙: "src/config.ts 또는 다른 소스 파일에 API 키, 시크릿, 토큰을 절대 하드코딩하지 마라. 반드시 환경변수(process.env)를 사용해라."

## 좋은 보호 규칙 예시

규칙은 구체적이고 실행 가능해야 한다. AI 에이전트가 읽었을 때 즉시 따를 수 있는 수준.

좋은 예:
- "src/app/api/checkout/, src/hooks/useCheckout.ts, src/components/Checkout*.tsx 그리고 @stripe/stripe-js 의존성은 절대로 'cleanup' 또는 'unused code' 명목으로 제거하지 않는다."
- "신규 마이그레이션에서 CREATE TABLE 후 반드시 ALTER TABLE ... ENABLE ROW LEVEL SECURITY와 최소 1개 정책을 포함한다."
- ".env.local의 NEXT_PUBLIC_ 접두사가 아닌 환경 변수는 절대 클라이언트 컴포넌트에서 참조하지 않는다."

나쁜 예 (너무 모호하거나 일반적):
- "보안에 주의한다" — 구체적 행동 지시 없음
- "코드를 깨끗하게 유지한다" — 기준 불명확
- "테스트를 작성한다" — 어떤 테스트인지 불명확

규칙 작성 원칙:
1. 보호 대상 파일/경로를 명시적으로 나열
2. 금지 행위를 구체적으로 서술 ("~하지 않는다")
3. 허용 예외가 있으면 명시 ("단, ~인 경우 제외")
4. 이유를 한 줄로 덧붙여 AI가 맥락을 이해하도록`;

// ─── 유저 메시지 빌더 ───

export interface StaticAnalysisInput {
  projectName: string;
  sessionTitle: string;
  filesChanged: string[];
  diffs: string; // 모든 diff를 합친 문자열
  /**
   * full_scan 모드에서만 전달되는 컨텍스트 소스 파일.
   * diff에 보이지 않는 사용처/상위 함수 확인용 — partial-context 오탐 감소.
   * 토큰 한도(약 30K char) 내로 잘려서 전달됨.
   */
  contextSources?: { path: string; content: string; line_count: number }[];
}

const STATIC_SOURCE_CONTEXT_MAX_CHARS = 30_000;

export function buildStaticAnalysisMessage(input: StaticAnalysisInput): string {
  const base = `## 분석 대상
- 프로젝트: ${input.projectName}
- 세션 제목: ${input.sessionTitle}
- 변경 파일: ${input.filesChanged.join(', ')}

## Diff 내용
\`\`\`
${input.diffs}
\`\`\``;

  if (!input.contextSources || input.contextSources.length === 0) {
    return base;
  }

  // 토큰 한도 내에서 line_count 작은 순으로 채움 (작은 파일=핵심 로직 가설)
  const sorted = [...input.contextSources].sort((a, b) => a.line_count - b.line_count);
  const blocks: string[] = [];
  let totalChars = 0;

  for (const f of sorted) {
    const block = `### ${f.path} (line ${f.line_count})\n\`\`\`\n${f.content}\n\`\`\``;
    if (totalChars + block.length > STATIC_SOURCE_CONTEXT_MAX_CHARS) break;
    blocks.push(block);
    totalChars += block.length;
  }

  if (blocks.length === 0) return base;

  return `${base}

## 관련 소스 파일 (컨텍스트 — 변경되지 않았지만 호출/사용처 확인용)
diff에 보이지 않는 사용처·상위 함수·import 그래프를 확인하여 partial-context 오탐을 피하라.
${blocks.join('\n\n')}`;
}

export interface SessionComparisonInput {
  prevSessionTitle: string;
  prevFilesChanged: string[];
  prevSummary: string;
  currentSessionTitle: string;
  currentFilesChanged: string[];
  currentSummary: string;
  currentDiffs: string;
}

export function buildSessionComparisonMessage(input: SessionComparisonInput): string {
  return `## 이전 세션
- 제목: ${input.prevSessionTitle}
- 변경 파일: ${input.prevFilesChanged.join(', ')}
- 요약: ${input.prevSummary}

## 현재 세션
- 제목: ${input.currentSessionTitle}
- 변경 파일: ${input.currentFilesChanged.join(', ')}
- 요약: ${input.currentSummary}

## 현재 세션의 Diff
\`\`\`
${input.currentDiffs}
\`\`\``;
}

export interface GuidelineInput {
  issueTitle: string;
  issueFact: string;
  issueDetail: string;
  issueFile: string;
  issueBasis: string;
}

export function buildGuidelineMessage(input: GuidelineInput): string {
  return `## 이슈 정보
- 제목: ${input.issueTitle}
- 사실: ${input.issueFact}
- 상세: ${input.issueDetail}
- 파일: ${input.issueFile}
- 근거: ${input.issueBasis}`;
}
