import type { ClaudeCallResult } from './claude-client';
import type { AnalysisMode } from './prompts';
import type { FileSignature } from '../specs/save-signatures';

// ─── 분석 결과 타입 ───

export interface DetectedIssue {
  title: string;
  level: 'critical' | 'warning' | 'info';
  fact: string;
  detail: string;
  fix_command: string;
  file: string;
  basis: string;
  confidence: number;
  start_line: number;
  end_line: number;
}

export interface AnalysisResult {
  issues: DetectedIssue[];
  tokenUsage: { input: number; output: number };
  warnings: string[];
  /**
   * 토큰 예산 초과 등으로 분석되지 않은 파일 경로 목록.
   * static-analyzer의 청크 분할 분기에서만 채워짐. 단일 호출 시 undefined.
   */
  unprocessed_files?: string[];
  /**
   * full 모드에서 LLM이 추출한 파일 시그니처. problems_only 모드면 비어있음.
   * 잘못된 형식의 항목은 drop되고 warnings에 기록됨.
   */
  file_signatures?: FileSignature[];
}

// ─── 보호 규칙 결과 타입 ───

export interface GeneratedGuideline {
  title: string;
  rule: string;
}

// ─── 분석 응답 파싱 ───

const VALID_LEVELS = new Set(['critical', 'warning', 'info']);
const REQUIRED_TEXT_FIELDS = ['title', 'level', 'fact', 'detail', 'fix_command', 'file', 'basis'] as const;

export type LevelLimits = Record<DetectedIssue['level'], number>;

export const LEVEL_LIMITS_FULL: LevelLimits = {
  critical: 5,
  warning: 10,
  info: 5,
};

export const LEVEL_LIMITS_PROBLEMS_ONLY: LevelLimits = {
  critical: 3,
  warning: 5,
  info: 0,
};

/**
 * 모드별 레벨 상한을 반환합니다.
 */
export function getLevelLimits(mode: AnalysisMode): LevelLimits {
  return mode === 'problems_only' ? LEVEL_LIMITS_PROBLEMS_ONLY : LEVEL_LIMITS_FULL;
}

/**
 * Claude API 응답에서 DetectedIssue 배열을 추출하고, 레벨별 상한을 적용합니다.
 */
export function parseAnalysisResponse(
  result: ClaudeCallResult,
  mode: AnalysisMode = 'full'
): AnalysisResult {
  const warnings: string[] = [];
  const issues: DetectedIssue[] = [];
  const signatures: FileSignature[] = [];

  if (result.toolInputs.length === 0) {
    warnings.push('Claude did not call the analysis tool');
    return { issues: [], tokenUsage: result.tokenUsage, warnings };
  }

  for (const input of result.toolInputs) {
    const rawIssues = input.issues;

    if (!Array.isArray(rawIssues)) {
      warnings.push('issues field is not an array');
    } else {
      for (let i = 0; i < rawIssues.length; i++) {
        const raw = rawIssues[i] as Record<string, unknown>;
        const validation = validateIssue(raw, i);

        if (validation.valid) {
          issues.push(validation.issue);
        } else {
          warnings.push(validation.error);
        }
      }
    }

    // file_signatures는 선택 필드 — issues 형식이 잘못되어도 별도로 파싱
    const rawSignatures = input.file_signatures;
    if (Array.isArray(rawSignatures)) {
      for (let i = 0; i < rawSignatures.length; i++) {
        const validation = validateSignature(rawSignatures[i] as Record<string, unknown>, i);
        if (validation.valid) {
          signatures.push(validation.signature);
        } else {
          warnings.push(validation.error);
        }
      }
    }
  }

  const { issues: limited, truncationWarnings } = applyLevelLimits(
    issues,
    getLevelLimits(mode)
  );
  warnings.push(...truncationWarnings);

  return {
    issues: limited,
    tokenUsage: result.tokenUsage,
    warnings,
    ...(signatures.length > 0 ? { file_signatures: signatures } : {}),
  };
}

/**
 * file_signatures 항목 검증 — 필수 필드 + 타입 체크.
 * 잘못된 항목은 drop하고 warnings로 보고 (issues는 살림).
 */
function validateSignature(
  raw: Record<string, unknown>,
  index: number
): { valid: true; signature: FileSignature } | { valid: false; error: string } {
  if (!raw || typeof raw.file_path !== 'string' || raw.file_path.trim() === '') {
    return { valid: false, error: `file_signatures[${index}]: missing file_path` };
  }

  const arrField = (key: string): string[] => {
    const v = raw[key];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
  };

  const lineCount = typeof raw.line_count === 'number' && Number.isFinite(raw.line_count)
    ? Math.max(0, Math.floor(raw.line_count))
    : 0;

  return {
    valid: true,
    signature: {
      file_path: raw.file_path,
      functions: arrField('functions'),
      imports: arrField('imports'),
      exports: arrField('exports'),
      patterns: arrField('patterns'),
      line_count: lineCount,
    },
  };
}

/**
 * 개별 이슈의 필수 필드와 값을 검증합니다.
 */
function validateIssue(
  raw: Record<string, unknown>,
  index: number
): { valid: true; issue: DetectedIssue } | { valid: false; error: string } {
  // 텍스트 필드 검증
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (!raw[field] || typeof raw[field] !== 'string') {
      return {
        valid: false,
        error: `Issue[${index}]: missing or invalid field "${field}"`,
      };
    }
  }

  // level 값 검증
  if (!VALID_LEVELS.has(raw.level as string)) {
    return {
      valid: false,
      error: `Issue[${index}]: invalid level "${raw.level}"`,
    };
  }

  // confidence 검증 (0~1 사이 숫자)
  const confidence = raw.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return {
      valid: false,
      error: `Issue[${index}]: confidence must be a number between 0 and 1, got "${confidence}"`,
    };
  }

  // start_line / end_line 검증 (양의 정수, end >= start)
  const startLine = raw.start_line;
  const endLine = raw.end_line;
  if (!Number.isInteger(startLine) || (startLine as number) < 1) {
    return {
      valid: false,
      error: `Issue[${index}]: start_line must be an integer >= 1, got "${startLine}"`,
    };
  }
  if (!Number.isInteger(endLine) || (endLine as number) < 1) {
    return {
      valid: false,
      error: `Issue[${index}]: end_line must be an integer >= 1, got "${endLine}"`,
    };
  }
  if ((endLine as number) < (startLine as number)) {
    return {
      valid: false,
      error: `Issue[${index}]: end_line (${endLine}) must be >= start_line (${startLine})`,
    };
  }

  return {
    valid: true,
    issue: {
      title: raw.title as string,
      level: raw.level as DetectedIssue['level'],
      fact: raw.fact as string,
      detail: raw.detail as string,
      fix_command: raw.fix_command as string,
      file: raw.file as string,
      basis: raw.basis as string,
      confidence: confidence,
      start_line: startLine as number,
      end_line: endLine as number,
    },
  };
}

/**
 * 레벨별 상한을 적용합니다.
 * 같은 레벨 내에서는 confidence 내림차순으로 상위 N개를 유지합니다.
 */
export function applyLevelLimits(
  issues: DetectedIssue[],
  limits: LevelLimits = LEVEL_LIMITS_FULL
): { issues: DetectedIssue[]; truncationWarnings: string[] } {
  const buckets: Record<DetectedIssue['level'], DetectedIssue[]> = {
    critical: [],
    warning: [],
    info: [],
  };

  for (const issue of issues) {
    buckets[issue.level].push(issue);
  }

  const truncationWarnings: string[] = [];
  const result: DetectedIssue[] = [];

  for (const level of ['critical', 'warning', 'info'] as const) {
    const limit = limits[level];
    const bucket = buckets[level];

    if (bucket.length <= limit) {
      result.push(...bucket);
      continue;
    }

    // confidence 내림차순 정렬 후 상위 limit개 유지
    const sorted = [...bucket].sort((a, b) => b.confidence - a.confidence);
    const dropped = bucket.length - limit;
    result.push(...sorted.slice(0, limit));
    truncationWarnings.push(
      `Truncated ${dropped} ${level} issue(s) over limit (${limit})`
    );
  }

  return { issues: result, truncationWarnings };
}

/**
 * Claude API 응답에서 보호 규칙을 추출합니다.
 */
export function parseGuidelineResponse(
  result: ClaudeCallResult
): GeneratedGuideline | null {
  if (result.toolInputs.length === 0) return null;

  const input = result.toolInputs[0];
  const title = input.title;
  const rule = input.rule;

  if (typeof title !== 'string' || typeof rule !== 'string') return null;
  if (title.trim().length === 0 || rule.trim().length === 0) return null;

  return { title: title.trim(), rule: rule.trim() };
}
