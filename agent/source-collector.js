// agent/source-collector.js — full_scan 모드에서 프로젝트 소스 파일을 수집.
// 결과는 push payload의 session_data.source_files로 전송 → 서버에서 ephemeral_data에 저장 →
// 분석 후 즉시 파기 (Ephemeral Processing).

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, isAbsolute, resolve, relative } from 'node:path';

// 파일당 상한 — 500줄 컷. 초과는 앞 500줄만 보존 + truncation 마커.
const MAX_LINES_PER_FILE = 500;
// 파일당 바이트 상한 — 서버 검증의 MAX_SOURCE_FILE_BYTES(80KB)와 일치
const MAX_FILE_BYTES = 80_000;
// 전체 합산 상한 — 1.5MB. 서버는 2MB까지 받지만 페이로드 12MB 안에서 다른 데이터와 공존 필요
const MAX_TOTAL_BYTES = 1_572_864;
// 재귀 깊이 상한
const MAX_DEPTH = 12;

// 수집 대상 확장자
const INCLUDE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.md',
]);

// 화이트리스트 — 정확한 파일명만 수집 (확장자 매칭 외)
const INCLUDE_BASENAME = new Set([
  'package.json',
  'tsconfig.json',
]);

// 제외 경로 (디렉토리 단위 — 어디서 만나든 들어가지 않음)
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  '.turbo',
  '.cache',
  'coverage',
  '.vercel',
  'storybook-static',
  '.storybook',
  '__pycache__',
]);

// 제외 파일명 패턴 (정확 매칭)
const EXCLUDE_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
]);

// 제외 확장자 (이미지/바이너리/폰트)
const EXCLUDE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.mov', '.webm', '.mp3', '.wav',
  '.pdf', '.zip', '.gz', '.tar',
  '.lock', '.lockb',
]);

/**
 * 프로젝트 루트(cwd) 하위 소스 파일을 재귀 수집.
 *
 * @param {string} cwd - 프로젝트 루트 (절대경로 권장)
 * @returns {Promise<{
 *   files: Array<{ path: string, content: string, line_count: number }>,
 *   warnings: string[]
 * }>}
 */
export async function collectSourceFiles(cwd) {
  const warnings = [];

  if (!cwd) {
    return { files: [], warnings: ['source: cwd missing — skipped'] };
  }

  const cwdAbs = resolve(cwd);

  let rootStat;
  try {
    rootStat = await stat(cwdAbs);
  } catch (err) {
    return { files: [], warnings: [`source: stat ${cwdAbs} failed (${err.message})`] };
  }
  if (!rootStat.isDirectory()) {
    return { files: [], warnings: [`source: ${cwdAbs} is not a directory`] };
  }

  // 1. 재귀 스캔 → 후보 수집 (메타데이터만)
  const candidates = [];
  await walkSourceFiles(cwdAbs, cwdAbs, 0, candidates, warnings);

  // 2. 80KB 초과 파일 skip
  const eligible = [];
  for (const c of candidates) {
    if (c.size > MAX_FILE_BYTES) {
      warnings.push(
        `source: ${c.path} exceeds ${MAX_FILE_BYTES} bytes (${c.size}) — skipped`
      );
      continue;
    }
    eligible.push(c);
  }

  // 3. line_count 작은 순으로 정렬 — 작은 파일(핵심 로직 가설) 우선 채움
  //    큰 파일이 먼저 잘림 → 전체 토큰 한도 안에서 더 많은 파일 보존
  eligible.sort((a, b) => a.size - b.size);

  const files = [];
  let totalBytes = 0;

  for (const c of eligible) {
    if (totalBytes + c.size > MAX_TOTAL_BYTES) {
      warnings.push(
        `source: ${c.path} (${c.size}B) skipped — total budget ${MAX_TOTAL_BYTES} reached`
      );
      continue;
    }

    let raw;
    try {
      raw = await readFile(c.absolute, 'utf8');
    } catch (err) {
      warnings.push(`source: read ${c.path} failed (${err.message})`);
      continue;
    }

    // 500줄 컷
    const lines = raw.split('\n');
    let content = raw;
    if (lines.length > MAX_LINES_PER_FILE) {
      content = lines.slice(0, MAX_LINES_PER_FILE).join('\n') + '\n// ...(truncated at 500 lines)';
    }

    // 컷 후에도 바이트 한도 재확인 (UTF-8 multibyte로 줄 수가 작아도 클 수 있음)
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      warnings.push(
        `source: ${c.path} exceeds ${MAX_FILE_BYTES} bytes after line cut — skipped`
      );
      continue;
    }

    const lineCount = Math.min(lines.length, MAX_LINES_PER_FILE);
    const byteSize = Buffer.byteLength(content, 'utf8');

    if (totalBytes + byteSize > MAX_TOTAL_BYTES) {
      warnings.push(
        `source: ${c.path} skipped after read — total budget exceeded`
      );
      continue;
    }

    files.push({ path: c.path, content, line_count: lineCount });
    totalBytes += byteSize;
  }

  // 결정적 순서
  files.sort((a, b) => a.path.localeCompare(b.path));

  return { files, warnings };
}

async function walkSourceFiles(dir, cwdAbs, depth, out, warnings) {
  if (depth > MAX_DEPTH) {
    warnings.push(`source: max depth ${MAX_DEPTH} hit at ${dir} — skipped deeper`);
    return;
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    warnings.push(`source: readdir ${dir} failed (${err.message})`);
    return;
  }

  for (const entry of entries) {
    const name = entry.name;

    // 점파일은 일부만 허용 (.env*는 절대 제외)
    if (name.startsWith('.env')) continue;
    if (name === '.gitignore' || name === '.eslintrc' || name === '.eslintrc.js') {
      // 설정 파일은 읽지 않고 skip — 가치 대비 노이즈 큼
      continue;
    }
    if (name.startsWith('.') && entry.isFile()) {
      // 그 외 점파일도 보수적으로 제외
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue; // 외부 가리킬 가능성
    }

    const absolute = join(dir, name);

    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      await walkSourceFiles(absolute, cwdAbs, depth + 1, out, warnings);
      continue;
    }

    if (!entry.isFile()) continue;

    if (EXCLUDE_BASENAMES.has(name)) continue;

    const lower = name.toLowerCase();
    const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
    if (EXCLUDE_EXT.has(ext)) continue;

    const included =
      INCLUDE_BASENAME.has(name) || INCLUDE_EXT.has(ext);
    if (!included) continue;

    // cwd 외부 차단
    const rel = relative(cwdAbs, absolute);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;

    let s;
    try {
      s = await stat(absolute);
    } catch {
      continue;
    }

    out.push({
      path: rel.split(/[\\/]/).join('/'),
      absolute,
      size: s.size,
    });
  }
}
