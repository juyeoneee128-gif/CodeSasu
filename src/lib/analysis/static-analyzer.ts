import { callClaude, estimateTokens } from './claude-client';
import { ANALYSIS_MODELS } from './models';
import {
  ANALYSIS_RESULT_TOOL,
  BOOT_SCAN_SYSTEM,
  buildStaticAnalysisSystem,
  buildStaticAnalysisMessage,
} from './prompts';
import type { AnalysisMode } from './prompts';
import { parseAnalysisResponse, applyLevelLimits, getLevelLimits } from './parse-response';
import type { DetectedIssue, AnalysisResult } from './parse-response';
import {
  buildEslintContextSection,
  convertEslintToIssues,
} from './eslint-results';
import type { EslintIssueRaw } from '../agent/validate-payload';
import { applyMaskingToDiffs } from '../security/mask-sensitive';

export interface StaticAnalysisOptions {
  /** true면 Haiku로 호출 (small diff). 기본 false → Sonnet. */
  useLightModel?: boolean;
  /** BYOK 키. */
  apiKey?: string;
  /**
   * true면 BOOT_SCAN_SYSTEM 사용 (부팅 스캔 전용 — 운영 코드 감사 톤).
   * source_files가 신규 파일 diff로 변환된 입력에 대해 LLM이
   * "방금 추가된 정상 코드"가 아니라 "운영 중인 코드"로 인식하도록 유도.
   */
  auditMode?: boolean;
  /**
   * split 경로에서 MAX_API_CALLS 대신 사용할 상한.
   * 부팅 스캔에서는 분석 대상 파일 수가 많아 기본 5로는 대부분이 미처리로 잘림.
   * 부팅 스캔 호출부에서 15 정도로 상향해 상위 우선순위 파일 50~80개를 커버한다.
   * 코딩 세션 분석에서는 지정하지 말 것 (자동 분석 비용 폭주 방지).
   */
  maxApiCallsOverride?: number;
}

/**
 * 토큰 예산 구조 — Anthropic Sonnet의 큰 컨텍스트 윈도우 환경에 맞춤.
 *
 * - DIFF_SOFT_LIMIT 이하: 단일 호출 (압축 없음)
 * - DIFF_SOFT_LIMIT ~ DIFF_HARD_LIMIT: 단일 호출 유지 + "Large diff" 정보 경고
 * - DIFF_HARD_LIMIT 초과: 청크 분할 진입 (우선순위 정렬 → CHUNK_TARGET 단위)
 *
 * MAX_INPUT은 sanity ceiling — 초과 시에도 청크 분할로 처리되므로
 * 강제 차단하지 않고 내부 분기에 의존.
 *
 * CONTEXT_LINES_*는 현재 git diff default(3 라인)와 일치 — 직접 조작은
 * 별도 단계(컨텍스트 trim)로 이연. 의도/기준 문서화 목적의 상수.
 */
const TOKEN_BUDGET = {
  MAX_INPUT: 32_000,
  DIFF_SOFT_LIMIT: 10_000,
  DIFF_HARD_LIMIT: 20_000,
  CHUNK_TARGET: 10_000,
  OUTPUT_BUFFER_FULL: 8_192,
  OUTPUT_BUFFER_PROBLEMS_ONLY: 4_096,
  CONTEXT_LINES_BEFORE: 3,
  CONTEXT_LINES_AFTER: 3,
} as const;

const MAX_API_CALLS = 5; // 분할 시 최대 호출 횟수 — 자동 분석 비용 폭주 방지

function getOutputBudget(mode: AnalysisMode): number {
  return mode === 'problems_only'
    ? TOKEN_BUDGET.OUTPUT_BUFFER_PROBLEMS_ONLY
    : TOKEN_BUDGET.OUTPUT_BUFFER_FULL;
}

interface DiffItem {
  file_path: string;
  diff_content: string;
}

interface StaticAnalysisInput {
  projectName: string;
  sessionTitle: string;
  filesChanged: string[];
  diffs: DiffItem[];
  /**
   * 에이전트가 로컬 실행한 ESLint 결과 (선택). 있으면 LLM 컨텍스트로 첨부 +
   * 일부 룰은 직접 이슈로 변환. 없으면 기존 LLM 단독 분석과 동일.
   */
  eslintResults?: EslintIssueRaw[];
  /**
   * full_scan 모드에서만 전달되는 컨텍스트 소스 파일.
   * diff에 보이지 않는 사용처를 LLM이 확인할 수 있도록 첨부.
   * 토큰 한도는 prompts.ts에서 관리.
   */
  contextSources?: { path: string; content: string; line_count: number }[];
}

/**
 * 정적 분석을 수행합니다.
 * diff 크기에 따라 단일 호출 또는 분할 호출합니다.
 *
 * options.useLightModel=true면 Haiku로, 아니면 Sonnet.
 * options.apiKey 있으면 유저 BYOK 키로 호출.
 */
export async function analyzeStatic(
  input: StaticAnalysisInput,
  mode: AnalysisMode = 'full',
  options: StaticAnalysisOptions = {}
): Promise<AnalysisResult> {
  // 보안: LLM 전송 직전 민감 데이터 마스킹.
  // DB 저장(ephemeral_data)에는 원본이 유지됨 — 분석 재실행은 동일 입력에 마스킹 재적용.
  const { diffs: maskedDiffs, maskCount } = applyMaskingToDiffs(input.diffs);
  const maskingWarnings: string[] =
    maskCount > 0
      ? [`Security: masked ${maskCount} sensitive value(s) before LLM call`]
      : [];
  const maskedInput: StaticAnalysisInput = { ...input, diffs: maskedDiffs };

  // ESLint 처리물(LLM 컨텍스트 + 직접 변환 이슈)을 한 번만 빌드.
  // diff가 비어있어도 ESLint 결과만 있으면 그것만으로 결과 반환.
  // ESLint 결과는 파일 경로 + 룰 메시지만 포함 (원본 코드 없음) → 마스킹 불필요.
  const eslintRaw = maskedInput.eslintResults ?? [];
  const eslintContext = buildEslintContextSection(eslintRaw);
  const eslintIssues = convertEslintToIssues(eslintRaw);

  if (maskedInput.diffs.length === 0) {
    if (eslintIssues.length === 0) {
      return { issues: [], tokenUsage: { input: 0, output: 0 }, warnings: ['No diffs to analyze'] };
    }
    const { issues: limited, truncationWarnings } = applyLevelLimits(
      eslintIssues,
      getLevelLimits(mode)
    );
    return {
      issues: limited,
      tokenUsage: { input: 0, output: 0 },
      warnings: [
        `ESLint integration: ${eslintRaw.length} raw findings, ${eslintIssues.length} auto-converted (no diffs for LLM analysis)`,
        ...truncationWarnings,
      ],
    };
  }

  // diff를 하나의 문자열로 합쳐서 크기 확인 (마스킹된 입력 기준)
  const combinedDiff = formatDiffs(maskedInput.diffs);
  const estimatedTokenCount = estimateTokens(combinedDiff);

  // SOFT 이하 → 단일 호출
  // SOFT < x <= HARD → 단일 호출 + 큰 diff 정보 경고
  // HARD 초과 → 청크 분할
  let llmResult: AnalysisResult;
  if (estimatedTokenCount <= TOKEN_BUDGET.DIFF_HARD_LIMIT) {
    llmResult = await callStaticAnalysis(maskedInput, combinedDiff, mode, eslintContext, options);
    if (estimatedTokenCount > TOKEN_BUDGET.DIFF_SOFT_LIMIT) {
      llmResult.warnings.unshift(
        `Large diff: ~${estimatedTokenCount} tokens (soft limit ${TOKEN_BUDGET.DIFF_SOFT_LIMIT}); single-call analysis may have reduced quality`
      );
    }
  } else {
    llmResult = await callStaticAnalysisSplit(maskedInput, mode, eslintContext, options);
  }

  // LLM이 ESLint 출처를 다시 보고한 경우 드롭 (basis가 ESLint:로 시작)
  const llmFiltered = llmResult.issues.filter(
    (i) => !i.basis.toLowerCase().startsWith('eslint:')
  );

  // ESLint 변환 이슈 + 필터된 LLM 이슈 합치기 → dedupe → 레벨 상한
  const combined = [...eslintIssues, ...llmFiltered];
  const deduplicated = deduplicateIssues(combined);
  const { issues: finalIssues, truncationWarnings } = applyLevelLimits(
    deduplicated,
    getLevelLimits(mode)
  );

  const finalWarnings = [...maskingWarnings, ...llmResult.warnings, ...truncationWarnings];
  if (eslintRaw.length > 0) {
    finalWarnings.unshift(
      `ESLint integration: ${eslintRaw.length} raw findings, ${eslintIssues.length} auto-converted to issues`
    );
  }

  return {
    issues: finalIssues,
    tokenUsage: llmResult.tokenUsage,
    warnings: finalWarnings,
    ...(llmResult.unprocessed_files ? { unprocessed_files: llmResult.unprocessed_files } : {}),
    ...(llmResult.file_signatures && llmResult.file_signatures.length > 0
      ? { file_signatures: llmResult.file_signatures }
      : {}),
  };
}

/**
 * 단일 Claude API 호출로 정적 분석
 */
async function callStaticAnalysis(
  input: StaticAnalysisInput,
  diffsText: string,
  mode: AnalysisMode,
  eslintContext: string,
  options: StaticAnalysisOptions
): Promise<AnalysisResult> {
  let userMessage = buildStaticAnalysisMessage({
    projectName: input.projectName,
    sessionTitle: input.sessionTitle,
    filesChanged: input.filesChanged,
    diffs: diffsText,
    contextSources: input.contextSources,
  });
  if (eslintContext) {
    userMessage = `${userMessage}\n\n${eslintContext}`;
  }

  const model = options.useLightModel
    ? ANALYSIS_MODELS.RUN_ANALYSIS_LIGHT
    : ANALYSIS_MODELS.RUN_ANALYSIS_FULL;

  // auditMode가 켜져 있으면 부팅 스캔용 시스템 프롬프트 사용 (mode 인자는 무시 — 항상 full 수준 감사).
  const systemPrompt = options.auditMode
    ? BOOT_SCAN_SYSTEM
    : buildStaticAnalysisSystem(mode);

  const result = await callClaude({
    systemPrompt,
    userMessage,
    tools: [ANALYSIS_RESULT_TOOL],
    maxTokens: getOutputBudget(mode),
    model,
    apiKey: options.apiKey,
  });

  return parseAnalysisResponse(result, mode);
}

/**
 * diff가 큰 경우 파일별로 분할하여 여러 번 호출
 */
async function callStaticAnalysisSplit(
  input: StaticAnalysisInput,
  mode: AnalysisMode,
  eslintContext: string,
  options: StaticAnalysisOptions
): Promise<AnalysisResult> {
  // 경로 기반 우선순위로 정렬 (보안/API 라우트 등 중요 파일을 먼저 분석)
  const sorted = [...input.diffs].sort((a, b) => {
    const aScore = getFilePriority(a.file_path);
    const bScore = getFilePriority(b.file_path);
    return bScore - aScore;
  });

  // 청크 분할 + 단일 파일이 HARD 초과한 경우 분리
  const { chunks, oversizedFiles } = chunkDiffs(sorted);

  const allIssues: DetectedIssue[] = [];
  const allSignatures: import('../specs/save-signatures').FileSignature[] = [];
  const allWarnings: string[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let callCount = 0;
  const skippedChunks: DiffItem[][] = [];

  // 부팅 스캔에서는 maxApiCallsOverride로 상한을 늘릴 수 있음.
  // 코딩 세션(override 미지정)에서는 기존 MAX_API_CALLS 유지 — 자동 분석 비용 폭주 방지.
  const maxCalls = options.maxApiCallsOverride ?? MAX_API_CALLS;

  for (const chunk of chunks) {
    if (callCount >= maxCalls) {
      skippedChunks.push(chunk);
      continue;
    }

    const chunkDiffText = formatDiffs(chunk);
    const chunkFiles = chunk.map((d) => d.file_path);

    const result = await callStaticAnalysis(
      {
        ...input,
        filesChanged: chunkFiles,
      },
      chunkDiffText,
      mode,
      eslintContext,
      options
    );

    allIssues.push(...result.issues);
    allWarnings.push(...result.warnings);
    if (result.file_signatures) {
      allSignatures.push(...result.file_signatures);
    }
    totalInput += result.tokenUsage.input;
    totalOutput += result.tokenUsage.output;
    callCount++;
  }

  const unprocessedFiles: string[] = [];

  // 미처리 파일: API 호출 한도 초과로 잘린 청크들 (우선순위 정렬 기준 끝쪽)
  if (skippedChunks.length > 0) {
    const skippedFiles = skippedChunks.flatMap((c) => c.map((d) => d.file_path));
    unprocessedFiles.push(...skippedFiles);
    allWarnings.push(formatUnprocessedFilesWarning(skippedFiles, 'token-budget'));
    allWarnings.push(
      `Reached max API calls (${maxCalls}), ${skippedChunks.length} chunk(s) skipped`
    );
  }

  // 단일 파일이 너무 큰 경우 — 분석 미수행, fallback warning만
  if (oversizedFiles.length > 0) {
    const oversizedNames = oversizedFiles.map((d) => d.file_path);
    unprocessedFiles.push(...oversizedNames);
    allWarnings.push(formatUnprocessedFilesWarning(oversizedNames, 'oversized'));
  }

  // 중복 제거: 같은 file + 같은 title (confidence 높은 쪽 유지)
  const deduplicated = deduplicateIssues(allIssues);

  // 분할 호출 결과 합산 후 다시 한 번 레벨별 상한 적용
  // (각 청크별로 이미 상한이 걸려있어도 합치면 다시 초과할 수 있음)
  const { issues: limited, truncationWarnings } = applyLevelLimits(
    deduplicated,
    getLevelLimits(mode)
  );
  allWarnings.push(...truncationWarnings);

  return {
    issues: limited,
    tokenUsage: { input: totalInput, output: totalOutput },
    warnings: allWarnings,
    ...(unprocessedFiles.length > 0 ? { unprocessed_files: unprocessedFiles } : {}),
    ...(allSignatures.length > 0 ? { file_signatures: allSignatures } : {}),
  };
}

// ─── 헬퍼 ───

function formatDiffs(diffs: DiffItem[]): string {
  return diffs
    .map((d) => `--- ${d.file_path} ---\n${d.diff_content}`)
    .join('\n\n');
}

// Test에서 직접 검증하기 위해 export. 외부 사용처 없음.
export { TOKEN_BUDGET, MAX_API_CALLS, getFilePriority, chunkDiffs, formatUnprocessedFilesWarning };

/**
 * 파일 경로 기반 분석 우선순위. 청크 분할 시 점수가 높은 파일을 먼저 분석.
 * 토큰 예산 초과로 일부 파일이 잘릴 때, 가장 중요한 파일이 보존되도록.
 */
function getFilePriority(filePath: string): number {
  // 1순위: API route — 인증/데이터 노출 직결
  if (/^app\/api\//.test(filePath)) return 6;
  // 2순위: 인증/보안/미들웨어
  if (/(?:^|\/)(auth|middleware|proxy)(?:\.|\/|-)/.test(filePath)) return 5;
  // 3순위: 비즈니스 로직
  if (/^src\/lib\//.test(filePath)) return 4;
  // 4순위: 컴포넌트
  if (/^src\/components\//.test(filePath)) return 3;
  // 5순위: 설정 파일
  if (
    /(?:^|\/)(package\.json|tsconfig\.json|next\.config\.[jt]s|vercel\.json|\.gitignore|\.env)/
      .test(filePath)
  ) return 2;
  // 6순위: 그 외
  return 1;
}

/**
 * diff를 청크 단위로 분할합니다.
 * 단일 파일이 DIFF_HARD_LIMIT를 초과하면 청크에 넣지 않고 oversizedFiles로 분리합니다.
 * (잘린 diff는 모델이 hunk 헤더 일관성을 잃고 헛 이슈를 만들 위험)
 */
function chunkDiffs(diffs: DiffItem[]): {
  chunks: DiffItem[][];
  oversizedFiles: DiffItem[];
} {
  const chunks: DiffItem[][] = [];
  const oversizedFiles: DiffItem[] = [];
  let current: DiffItem[] = [];
  let currentTokens = 0;

  for (const diff of diffs) {
    const tokens = estimateTokens(diff.diff_content);

    // 단일 파일이 HARD 초과 → oversized 분리, 분석 안 함
    if (tokens > TOKEN_BUDGET.DIFF_HARD_LIMIT) {
      oversizedFiles.push(diff);
      continue;
    }

    if (currentTokens + tokens > TOKEN_BUDGET.CHUNK_TARGET && current.length > 0) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(diff);
    currentTokens += tokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return { chunks, oversizedFiles };
}

/**
 * 미처리 파일 목록을 사용자 가독 메시지로 포맷합니다.
 * 처음 5개 파일까지 본문에 표시, 그 이상은 "...(외 N개)"로 축약.
 */
function formatUnprocessedFilesWarning(
  files: string[],
  reason: 'token-budget' | 'oversized'
): string {
  const HEAD_LIMIT = 5;
  const head = files.slice(0, HEAD_LIMIT).join(', ');
  const rest = files.length > HEAD_LIMIT ? `, ...(외 ${files.length - HEAD_LIMIT}개)` : '';
  const reasonText =
    reason === 'oversized'
      ? `single file exceeds hard limit (${TOKEN_BUDGET.DIFF_HARD_LIMIT} tokens)`
      : `token budget exceeded`;
  return `Unanalyzed files (${reasonText}, ${files.length} files): ${head}${rest}`;
}

function deduplicateIssues(issues: DetectedIssue[]): DetectedIssue[] {
  // 같은 (file, title) 키에서 confidence가 더 높은 이슈를 유지
  const byKey = new Map<string, DetectedIssue>();

  for (const issue of issues) {
    const key = `${issue.file}::${issue.title}`;
    const existing = byKey.get(key);
    if (!existing || issue.confidence > existing.confidence) {
      byKey.set(key, issue);
    }
  }

  return Array.from(byKey.values());
}
