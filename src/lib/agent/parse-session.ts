import { createHash } from 'crypto';
import { extractSignatureFromContent } from './extract-signature-regex';
import type { FileSignature } from '../specs/save-signatures';

// ─── JSONL 메시지 타입 정의 ───

interface JsnolContentText {
  type: 'text';
  text: string;
}

interface JsonlContentToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface JsonlContentToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string | unknown[];
  is_error?: boolean;
}

interface JsonlContentThinking {
  type: 'thinking';
  thinking: string;
}

type JsonlContent = JsnolContentText | JsonlContentToolUse | JsonlContentToolResult | JsonlContentThinking;

interface JsonlUserMessage {
  type: 'user';
  parentUuid: string | null;
  isSidechain?: boolean;
  promptId?: string;
  uuid: string;
  timestamp: string;
  message: {
    role: 'user';
    content: JsonlContent[];
  };
  toolUseResult?: unknown;
  permissionMode?: string;
  userType?: string;
  entrypoint?: string;
  cwd?: string;
  sessionId?: string;
  version?: string;
  gitBranch?: string;
}

interface JsonlAssistantMessage {
  type: 'assistant';
  parentUuid: string;
  isSidechain?: boolean;
  uuid: string;
  timestamp: string;
  requestId?: string;
  message: {
    model?: string;
    id?: string;
    type?: string;
    role: 'assistant';
    content: JsonlContent[];
    stop_reason?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

interface JsonlQueueOperation {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue';
  timestamp: string;
  sessionId: string;
}

interface JsonlAiTitle {
  type: 'ai-title';
  sessionId: string;
  aiTitle: string;
}

interface JsonlGeneric {
  type: string;
  timestamp?: string;
  [key: string]: unknown;
}

type JsonlEntry = JsonlUserMessage | JsonlAssistantMessage | JsonlQueueOperation | JsonlAiTitle | JsonlGeneric;

// ─── 파싱 결과 타입 ───

export interface PromptEntry {
  index: number;
  content: string;     // 500자 truncate
  timestamp: string;
}

export interface ErrorEntry {
  tool_name: string;
  message: string;     // 200자 truncate
  timestamp: string;
}

export interface ParsedSession {
  // 기존 필드 (모두 보존)
  title: string;
  summary: string;
  raw_log: string;
  log_hash: string;
  files_changed: string[];      // 변경 파일 경로 배열 — DB의 changed_files jsonb에 매핑
  changed_files: number;        // 카운트 — DB의 files_changed integer에 매핑
  prompts: string[];            // 평면 string[] — DB의 prompts jsonb에 매핑
  warnings: string[];
  session_id_from_log: string | null;
  cli_version: string | null;
  entrypoint: string | null;
  model: string | null;

  // 신규 필드 (10단계: parsed_summary 컬럼으로 흘러감)
  duration_seconds: number;
  prompt_count: number;
  total_tokens: number;
  files_read: string[];
  tool_usage: Record<string, number>;
  errors: ErrorEntry[];
  prompts_meta: PromptEntry[];

  /**
   * Read tool_result에서 정규식으로 추출한 파일 시그니처 (JS/TS만).
   * push 라우트가 이 결과를 upsertFileSignatures로 합집합 머지.
   */
  file_signatures: FileSignature[];
}

// ─── 상수 ───

const TITLE_MAX_LEN = 80;
const PROMPT_TRUNCATE = 500;
const ERROR_MESSAGE_TRUNCATE = 200;
const MAX_ERRORS = 10;

// 시스템 태그 — 프롬프트 본문에서 제거
const SYSTEM_TAG_PATTERNS = [
  /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<ide_selection>[\s\S]*?<\/ide_selection>/g,
];

// 에러 키워드 (대소문자 무관, 단어 경계)
const ERROR_KEYWORD = /\b(error|failed|failure)\b/i;
// 부정문 — 같은 메시지에 있으면 false positive로 간주
const NO_ERROR_NEGATION = /\b(no|without|zero|not?)\s+(errors?|failures?|failed)/i;

function stripSystemTags(text: string): string {
  let result = text;
  for (const pattern of SYSTEM_TAG_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.trim();
}

function toRelativePath(filePath: string, cwd: string | null): string {
  if (!cwd || !filePath.startsWith(cwd)) return filePath;
  const relative = filePath.slice(cwd.length);
  return relative.startsWith('/') ? relative.slice(1) : relative;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

// ─── 메인 파싱 함수 ───

/**
 * Claude Code JSONL을 규칙 기반으로 파싱하여 구조화된 세션 요약을 만듭니다.
 * API 호출 없음 — 100% 로컬 파싱, 크레딧 0.
 *
 * 입력이 비어있거나 모든 줄이 깨진 경우에도 throw하지 않고 기본값을 반환합니다
 * (warnings에 사유 명시).
 */
export function parseSession(jsonlLog: string): ParsedSession {
  const warnings: string[] = [];

  // Step 1: 줄 분리 + JSON 파싱
  const rawLines = jsonlLog.split('\n').filter((line) => line.trim().length > 0);

  if (rawLines.length === 0) {
    return emptySession(jsonlLog, ['Empty log data']);
  }

  const entries: JsonlEntry[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    try {
      const parsed = JSON.parse(rawLines[i]) as JsonlEntry;
      if (parsed && typeof parsed === 'object' && parsed.type) {
        entries.push(parsed);
      } else {
        warnings.push(`Line ${i + 1}: invalid structure`);
      }
    } catch {
      warnings.push(`Line ${i + 1}: parse error`);
    }
  }

  if (entries.length === 0) {
    return emptySession(jsonlLog, [...warnings, 'No valid entries in log data']);
  }

  // Step 2: 메시지 분류
  const userMessages: JsonlUserMessage[] = [];
  const assistantMessages: JsonlAssistantMessage[] = [];
  let aiTitle: string | null = null;
  let sessionIdFromLog: string | null = null;

  for (const entry of entries) {
    switch (entry.type) {
      case 'user':
        userMessages.push(entry as JsonlUserMessage);
        break;
      case 'assistant':
        assistantMessages.push(entry as JsonlAssistantMessage);
        break;
      case 'ai-title':
        aiTitle = (entry as JsonlAiTitle).aiTitle;
        break;
      case 'queue-operation':
        if (!sessionIdFromLog) {
          sessionIdFromLog = (entry as JsonlQueueOperation).sessionId;
        }
        break;
    }
  }

  // Step 3: 세션 제목
  const title = aiTitle ?? extractFirstPromptTitle(userMessages) ?? 'Untitled Session';

  // Step 4: 사용자 프롬프트 수집 (평면 + 메타)
  const prompts = extractPrompts(userMessages);
  const promptsMeta = extractPromptsMeta(userMessages);

  // Step 5: 변경/조회 파일 추출
  const cwd = extractCwd(userMessages);
  const filesChanged = extractChangedFiles(assistantMessages, cwd);
  const filesRead = extractReadFiles(assistantMessages, cwd);

  // Step 6: 도구 사용 통계
  const toolsUsed = countToolUsage(assistantMessages);

  // Step 7: duration / total_tokens
  const durationSeconds = computeDurationSeconds(entries);
  const totalTokens = computeTotalTokens(assistantMessages);

  // Step 8: 에러 추출 (tool_result는 user 메시지에 들어감 — Claude Code JSONL 사양)
  const errors = extractErrors(userMessages, assistantMessages);

  // Step 8.5: Read tool_result 본문에서 시그니처 정규식 추출 (JS/TS만, 비용 0)
  const fileSignatures = extractToolResultSignatures(userMessages, assistantMessages, cwd);

  // Step 9: 한국어 요약 텍스트
  const summary = buildSummary(prompts.length, filesChanged.length, durationSeconds);

  // Step 10: 메타데이터
  const firstUser = userMessages.find((m) => m.sessionId || m.version);
  const firstAssistant = assistantMessages[0];

  // log_hash
  const logHash = createHash('sha256').update(jsonlLog).digest('hex');

  return {
    title,
    summary,
    raw_log: jsonlLog,
    log_hash: logHash,
    files_changed: filesChanged,
    changed_files: filesChanged.length,
    prompts,
    warnings,
    session_id_from_log: sessionIdFromLog ?? firstUser?.sessionId ?? null,
    cli_version: firstUser?.version ?? null,
    entrypoint: firstUser?.entrypoint ?? null,
    model: firstAssistant?.message?.model ?? null,
    // 신규
    duration_seconds: durationSeconds,
    prompt_count: prompts.length,
    total_tokens: totalTokens,
    files_read: filesRead,
    tool_usage: toolsUsed,
    errors,
    prompts_meta: promptsMeta,
    file_signatures: fileSignatures,
  };
}

/**
 * 빈 입력 또는 모든 줄이 깨진 경우 — 기본값 채운 ParsedSession 반환.
 * warnings에 사유 명시.
 */
function emptySession(rawLog: string, warnings: string[]): ParsedSession {
  console.warn('[parse-session] returning empty session:', warnings.join('; '));
  return {
    title: 'Untitled Session',
    summary: '',
    raw_log: rawLog,
    log_hash: createHash('sha256').update(rawLog).digest('hex'),
    files_changed: [],
    changed_files: 0,
    prompts: [],
    warnings,
    session_id_from_log: null,
    cli_version: null,
    entrypoint: null,
    model: null,
    duration_seconds: 0,
    prompt_count: 0,
    total_tokens: 0,
    files_read: [],
    tool_usage: {},
    errors: [],
    prompts_meta: [],
    file_signatures: [],
  };
}

// ─── 헬퍼 함수들 ───

/**
 * 첫 번째 사용자 프롬프트에서 제목 추출 (TITLE_MAX_LEN 제한)
 */
function extractFirstPromptTitle(userMessages: JsonlUserMessage[]): string | null {
  for (const msg of userMessages) {
    if (msg.toolUseResult) continue;
    const texts = extractTextFromContent(msg.message.content);
    const clean = texts.map(stripSystemTags).filter((t) => t.length > 0).join('\n');
    if (clean.length > 0) {
      return clean.length > TITLE_MAX_LEN ? clean.slice(0, TITLE_MAX_LEN) + '...' : clean;
    }
  }
  return null;
}

/**
 * 사용자 프롬프트만 추출 (tool_result 제외, 시스템 태그 제거).
 * 평면 string[] — backward compat (기존 prompts 컬럼).
 */
function extractPrompts(userMessages: JsonlUserMessage[]): string[] {
  const prompts: string[] = [];

  for (const msg of userMessages) {
    if (msg.toolUseResult) continue;
    const hasText = msg.message.content.some((c) => c.type === 'text');
    const hasOnlyToolResult = msg.message.content.every(
      (c) => c.type === 'tool_result'
    );
    if (!hasText || hasOnlyToolResult) continue;

    const texts = extractTextFromContent(msg.message.content);
    const joined = texts.map(stripSystemTags).filter((t) => t.length > 0).join('\n');
    if (joined.length > 0) {
      prompts.push(joined);
    }
  }

  return prompts;
}

/**
 * 사용자 프롬프트를 메타정보(timestamp/index/truncated content)와 함께 추출.
 * parsed_summary jsonb로 저장되어 상세 응답에서 활용.
 */
function extractPromptsMeta(userMessages: JsonlUserMessage[]): PromptEntry[] {
  const result: PromptEntry[] = [];
  let index = 0;

  for (const msg of userMessages) {
    if (msg.toolUseResult) continue;
    const hasText = msg.message.content.some((c) => c.type === 'text');
    const hasOnlyToolResult = msg.message.content.every(
      (c) => c.type === 'tool_result'
    );
    if (!hasText || hasOnlyToolResult) continue;

    const texts = extractTextFromContent(msg.message.content);
    const joined = texts.map(stripSystemTags).filter((t) => t.length > 0).join('\n');
    if (joined.length === 0) continue;

    result.push({
      index,
      content: truncate(joined, PROMPT_TRUNCATE),
      timestamp: msg.timestamp ?? '',
    });
    index += 1;
  }

  return result;
}

function extractTextFromContent(content: JsonlContent[]): string[] {
  return content
    .filter((c): c is JsnolContentText => c.type === 'text')
    .map((c) => c.text);
}

function extractCwd(userMessages: JsonlUserMessage[]): string | null {
  for (const msg of userMessages) {
    if (msg.cwd) return msg.cwd;
  }
  return null;
}

/**
 * assistant의 tool_use(Write/Edit/MultiEdit)에서 변경 파일 경로 추출.
 * input.file_path 우선, 없으면 input.path도 체크.
 */
function extractChangedFiles(
  assistantMessages: JsonlAssistantMessage[],
  cwd: string | null
): string[] {
  const files = new Set<string>();
  const writeTools = new Set(['Write', 'Edit', 'MultiEdit']);

  for (const msg of assistantMessages) {
    for (const content of msg.message.content) {
      if (content.type !== 'tool_use') continue;
      const toolContent = content as JsonlContentToolUse;
      if (!writeTools.has(toolContent.name)) continue;

      const path = filePathFromInput(toolContent.input);
      if (path) files.add(toRelativePath(path, cwd));
    }
  }

  return Array.from(files).sort();
}

/**
 * Read 도구로 조회한 파일 경로 추출.
 */
function extractReadFiles(
  assistantMessages: JsonlAssistantMessage[],
  cwd: string | null
): string[] {
  const files = new Set<string>();

  for (const msg of assistantMessages) {
    for (const content of msg.message.content) {
      if (content.type !== 'tool_use') continue;
      const toolContent = content as JsonlContentToolUse;
      if (toolContent.name !== 'Read') continue;

      const path = filePathFromInput(toolContent.input);
      if (path) files.add(toRelativePath(path, cwd));
    }
  }

  return Array.from(files).sort();
}

function filePathFromInput(input: Record<string, unknown>): string | null {
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  return null;
}

function countToolUsage(
  assistantMessages: JsonlAssistantMessage[]
): Record<string, number> {
  const tools: Record<string, number> = {};

  for (const msg of assistantMessages) {
    for (const content of msg.message.content) {
      if (content.type === 'tool_use') {
        const name = (content as JsonlContentToolUse).name;
        tools[name] = (tools[name] ?? 0) + 1;
      }
    }
  }

  return tools;
}

/**
 * 첫 ~ 마지막 timestamp 차이를 초로. 파싱 실패 시 0.
 */
function computeDurationSeconds(entries: JsonlEntry[]): number {
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const ts = (entry as { timestamp?: string }).timestamp;
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) continue;
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }

  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || maxMs < minMs) {
    return 0;
  }
  return Math.round((maxMs - minMs) / 1000);
}

/**
 * assistant.usage의 input_tokens + output_tokens 합. cache 토큰은 제외.
 */
function computeTotalTokens(assistantMessages: JsonlAssistantMessage[]): number {
  let total = 0;
  for (const msg of assistantMessages) {
    const usage = msg.message.usage;
    if (!usage) continue;
    if (typeof usage.input_tokens === 'number') total += usage.input_tokens;
    if (typeof usage.output_tokens === 'number') total += usage.output_tokens;
  }
  return total;
}

/**
 * tool_result에서 에러를 추출.
 * - is_error === true (확실한 에러)
 * - content에 error/failed/failure 키워드 매칭 + "no errors" 같은 부정문 없음
 *
 * Claude Code JSONL 사양: tool_use는 assistant 메시지에, tool_result는
 * user 메시지에 들어감. tool_use_id로 두 메시지를 짝지어 tool_name 추출.
 * 짝을 못 찾으면 'unknown'. MAX_ERRORS(10) 도달 시 truncate.
 */
function extractErrors(
  userMessages: JsonlUserMessage[],
  assistantMessages: JsonlAssistantMessage[]
): ErrorEntry[] {
  // tool_use_id → tool_name 매핑 (assistant 측에서 도구 호출 시점)
  const toolNameById = new Map<string, string>();
  for (const msg of assistantMessages) {
    for (const content of msg.message.content) {
      if (content.type !== 'tool_use') continue;
      const tc = content as JsonlContentToolUse;
      toolNameById.set(tc.id, tc.name);
    }
  }

  const errors: ErrorEntry[] = [];

  for (const msg of userMessages) {
    for (const content of msg.message.content) {
      if (content.type !== 'tool_result') continue;
      if (errors.length >= MAX_ERRORS) return errors;

      const tr = content as JsonlContentToolResult;
      const text = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);

      const isError = tr.is_error === true;
      const matchesKeyword =
        ERROR_KEYWORD.test(text) && !NO_ERROR_NEGATION.test(text);

      if (!isError && !matchesKeyword) continue;

      errors.push({
        tool_name: toolNameById.get(tr.tool_use_id) ?? 'unknown',
        message: truncate(text, ERROR_MESSAGE_TRUNCATE),
        timestamp: msg.timestamp ?? '',
      });
    }
  }

  return errors;
}

/**
 * Read tool 결과 본문에서 정규식으로 파일 시그니처를 추출합니다.
 *
 * - assistant 측 Read tool_use에서 tool_use_id ↔ file_path 매핑
 * - user 측 tool_result에서 매칭 id 찾아 본문 추출
 * - JS/TS만 추출, 그 외는 skip
 * - 같은 파일이 여러 번 Read되면 후속 결과로 합집합 머지 (서버 upsert에서도 다시 합집합)
 *
 * Write/Edit tool_result는 변경 후 본문이 들어오기도 하지만 형식이 일정하지 않아
 * Read만 처리. 정적 분석 LLM 경로가 변경 파일을 별도로 커버.
 */
function extractToolResultSignatures(
  userMessages: JsonlUserMessage[],
  assistantMessages: JsonlAssistantMessage[],
  cwd: string | null
): FileSignature[] {
  // tool_use_id → { file_path } 매핑 (Read tool만)
  const readById = new Map<string, string>();
  for (const msg of assistantMessages) {
    for (const content of msg.message.content) {
      if (content.type !== 'tool_use') continue;
      const tc = content as JsonlContentToolUse;
      if (tc.name !== 'Read') continue;
      const path = filePathFromInput(tc.input);
      if (path) {
        readById.set(tc.id, toRelativePath(path, cwd));
      }
    }
  }

  if (readById.size === 0) return [];

  const byPath = new Map<string, FileSignature>();

  for (const msg of userMessages) {
    for (const content of msg.message.content) {
      if (content.type !== 'tool_result') continue;
      const tr = content as JsonlContentToolResult;
      const filePath = readById.get(tr.tool_use_id);
      if (!filePath) continue;

      const text = toolResultToText(tr.content);
      if (!text) continue;

      // Read tool은 보통 줄 번호 prefix를 붙임 ("    12→...") — 본문만 추출
      const cleaned = stripReadLinePrefixes(text);

      const sig = extractSignatureFromContent(filePath, cleaned);
      if (!sig) continue;

      const existing = byPath.get(filePath);
      if (existing) {
        byPath.set(filePath, mergeSignatures(existing, sig));
      } else {
        byPath.set(filePath, sig);
      }
    }
  }

  return Array.from(byPath.values());
}

/**
 * tool_result.content는 string 또는 [{type:'text', text:'...'}] 형태일 수 있음.
 */
function toolResultToText(content: string | unknown[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (item && typeof item === 'object') {
      const t = (item as { type?: string; text?: string }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('\n');
}

/**
 * Claude Code Read tool 출력은 라인마다 "    12→..." 같은 prefix를 붙임.
 * 코드 분석을 위해 prefix를 제거하여 원본에 가깝게 복원.
 */
function stripReadLinePrefixes(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+→/, ''))
    .join('\n');
}

function mergeSignatures(a: FileSignature, b: FileSignature): FileSignature {
  return {
    file_path: a.file_path,
    functions: dedupArr([...a.functions, ...b.functions]),
    imports: dedupArr([...a.imports, ...b.imports]),
    exports: dedupArr([...a.exports, ...b.exports]),
    patterns: dedupArr([...a.patterns, ...b.patterns]),
    line_count: Math.max(a.line_count, b.line_count),
  };
}

function dedupArr(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!it || seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  return out;
}

/**
 * 한국어 요약 텍스트.
 * 형식: "N개 프롬프트, M개 파일 수정, 12분"
 */
function buildSummary(
  promptCount: number,
  fileCount: number,
  durationSeconds: number
): string {
  const parts: string[] = [
    `${promptCount}개 프롬프트`,
    `${fileCount}개 파일 수정`,
  ];
  if (durationSeconds > 0) {
    parts.push(formatDuration(durationSeconds));
  }
  return parts.join(', ');
}

/**
 * 초를 한국어 표기로 변환.
 * - < 60초: "0분"
 * - 60초 ~ 1시간: "12분 34초" (초가 0이면 "12분")
 * - >= 1시간: "1시간 23분" (분이 0이면 "1시간")
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return '0분';
  const hours = Math.floor(seconds / 3600);
  const remainAfterHours = seconds % 3600;
  const minutes = Math.floor(remainAfterHours / 60);
  const secs = remainAfterHours % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  }
  return secs > 0 ? `${minutes}분 ${secs}초` : `${minutes}분`;
}
