import type { FileSignature } from '../specs/save-signatures';

/**
 * Read tool 결과로 들어온 파일 본문에서 시그니처를 정규식 추출합니다.
 *
 * - JS/TS(.ts/.tsx/.js/.jsx)만 처리. 그 외는 null.
 * - LLM 호출 없음 → 추가 비용 0.
 * - 합집합 머지 정책으로 정적 분석 LLM 경로와 함께 작동.
 *
 * 추출 항목:
 * - functions: function/const fn = () =>/async 등의 식별자
 * - imports: from 'X'의 X 모듈 경로
 * - exports: export function/const/default/{ named }
 * - patterns: 외부 SDK/API 호출 (supabase.*, stripe.*, fetch, prisma.*, axios.*, redis.*, openai.*, anthropic.*)
 * - line_count: 본문 줄 수
 */
const JS_TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

const LIBRARY_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'supabase', regex: /\bsupabase\.([a-zA-Z_][\w.]*)/g },
  { name: 'stripe', regex: /\bstripe\.([a-zA-Z_][\w.]*)/g },
  { name: 'prisma', regex: /\bprisma\.([a-zA-Z_][\w.]*)/g },
  { name: 'redis', regex: /\bredis\.([a-zA-Z_][\w.]*)/g },
  { name: 'openai', regex: /\bopenai\.([a-zA-Z_][\w.]*)/g },
  { name: 'anthropic', regex: /\banthropic\.([a-zA-Z_][\w.]*)/g },
  { name: 'axios', regex: /\baxios\.([a-zA-Z_][\w.]*)/g },
];

const FETCH_PATTERN = /\bfetch\s*\(/g;

export function extractSignatureFromContent(
  filePath: string,
  content: string
): FileSignature | null {
  if (!JS_TS_EXT.test(filePath)) return null;
  if (typeof content !== 'string') return null;

  const stripped = stripCommentsAndStrings(content);
  const noComments = stripCommentsOnly(content);

  return {
    file_path: filePath,
    functions: extractFunctions(stripped),
    imports: extractImports(noComments), // 문자열 보존 필요 (모듈 경로가 문자열 안에 있음)
    exports: extractExports(stripped),
    patterns: extractPatterns(stripped, content),
    line_count: content.split('\n').length,
  };
}

/**
 * 주석만 제거 — 문자열 리터럴은 보존. import 모듈 경로 추출용.
 */
function stripCommentsOnly(src: string): string {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return s;
}

/**
 * 주석과 문자열 리터럴을 제거하여 식별자 추출 정확도를 높입니다.
 * 단순 토큰 단위 처리 — 완벽한 파서가 아니므로 코너케이스가 있을 수 있지만 시그니처 휴리스틱에는 충분.
 */
function stripCommentsAndStrings(src: string): string {
  // 블록 주석 /* ... */
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // 라인 주석 // ...
  s = s.replace(/(^|[^:])\/\/.*$/gm, '$1');
  // 템플릿 리터럴 (단순 처리 — 중첩 ${} 무시)
  s = s.replace(/`[^`]*`/g, '``');
  // 일반 문자열 — 줄바꿈 보존을 위해 빈 따옴표로 대체
  s = s.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  s = s.replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  return s;
}

function extractFunctions(src: string): string[] {
  const found = new Set<string>();

  // function name() / async function name()
  const funcDecl = /(?:^|\s)(?:async\s+)?function\s+(\w+)/g;
  for (const m of src.matchAll(funcDecl)) found.add(m[1]);

  // const/let/var name = ... => / function() / async ...
  const arrowOrFnExpr = /(?:^|\s)(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g;
  for (const m of src.matchAll(arrowOrFnExpr)) found.add(m[1]);

  const fnExpr = /(?:^|\s)(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?=\s*(?:async\s+)?function\b/g;
  for (const m of src.matchAll(fnExpr)) found.add(m[1]);

  // 클래스 메서드 — 클래스 본문 안의 `name(args) {` 패턴 휴리스틱
  // (단독 사용은 노이즈가 많아서 export 또는 명시적 패턴만)
  const methodInClass = /(?:^|\n)\s+(?:async\s+)?(?:static\s+)?(\w+)\s*\([^)]*\)\s*[:{]/g;
  for (const m of src.matchAll(methodInClass)) {
    // 예약어/생성자 제외
    if (
      m[1] === 'constructor' ||
      m[1] === 'if' ||
      m[1] === 'for' ||
      m[1] === 'while' ||
      m[1] === 'switch' ||
      m[1] === 'catch' ||
      m[1] === 'return'
    ) {
      continue;
    }
    found.add(m[1]);
  }

  return Array.from(found);
}

function extractImports(src: string): string[] {
  const found = new Set<string>();
  // import ... from 'X'
  const importFrom = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(importFrom)) found.add(m[1]);
  // import 'X' (side-effect)
  const importSide = /import\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(importSide)) found.add(m[1]);
  // require('X') (CommonJS)
  const requireExpr = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of src.matchAll(requireExpr)) found.add(m[1]);
  return Array.from(found);
}

function extractExports(src: string): string[] {
  const found = new Set<string>();

  // export default
  if (/\bexport\s+default\b/.test(src)) found.add('default');

  // export function/class/const/let/var name
  const namedDecl = /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g;
  for (const m of src.matchAll(namedDecl)) found.add(m[1]);

  // export { foo, bar as baz }
  const namedList = /\bexport\s*\{([^}]+)\}/g;
  for (const m of src.matchAll(namedList)) {
    const items = m[1].split(',');
    for (const item of items) {
      const id = item.trim().split(/\s+as\s+/)[0].trim();
      if (id) found.add(id);
    }
  }

  return Array.from(found);
}

function extractPatterns(stripped: string, original: string): string[] {
  const found = new Set<string>();

  for (const lib of LIBRARY_PATTERNS) {
    for (const m of stripped.matchAll(lib.regex)) {
      // supabase.auth.signInWithPassword 형태로 1단계만 → 'supabase.auth' 같은 짧은 경로 위주
      const fullPath = m[0]; // 'supabase.auth.signInWithPassword'
      // 메서드 호출 직전까지만 (괄호 전)
      const cleaned = fullPath.replace(/\([\s\S]*$/, '').trim();
      found.add(cleaned);
    }
  }

  // fetch는 stripped에서 검사 (문자열 안 fetch URL은 제외)
  if (FETCH_PATTERN.test(stripped)) {
    found.add('fetch');
  }
  // matchAll의 lastIndex 영향을 막기 위해 reset 불필요 (test는 g 플래그면 lastIndex 사용)
  FETCH_PATTERN.lastIndex = 0;

  // original에서 'use client'/'use server' 같은 RSC 지시문도 패턴
  if (/^['"]use client['"]/.test(original.trim())) found.add('use client');
  if (/^['"]use server['"]/.test(original.trim())) found.add('use server');

  return Array.from(found);
}
