#!/usr/bin/env node
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Watcher } from './watcher.js';
import { State } from './state.js';
import { collectSession } from './collector.js';
import { collectSourceFiles } from './source-collector.js';
import { collectDocs } from './docs-collector.js';
import { pushSession, pushSourceSnapshot, checkFullScanPending } from './sender.js';

const HOME = homedir();
const CODESASU_HOME = join(HOME, '.codesasu');
const CONFIG_PATH = join(CODESASU_HOME, 'config.env');
const STATE_PATH = join(CODESASU_HOME, 'state.json');
const LOG_PATH = join(CODESASU_HOME, 'logs', 'agent.log');
const DEFAULT_CLAUDE_DIR = join(HOME, '.claude', 'projects');
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_API_URL = 'http://localhost:3000';
const DEFAULT_POLL_INTERVAL_MS = 60_000;

async function loadConfig() {
  let raw;
  try {
    raw = await readFile(CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 파일이 없으면 process.env만 사용
      raw = '';
    } else {
      throw err;
    }
  }

  const fromFile = parseEnvFile(raw);
  const merged = { ...fromFile, ...pickEnv() };

  const projectId = merged.CODESASU_PROJECT_ID;
  const token = merged.CODESASU_AGENT_TOKEN;
  const signingKey = merged.CODESASU_SIGNING_KEY || '';
  const apiUrl = merged.CODESASU_API_URL || DEFAULT_API_URL;
  const idleTimeoutMs = parseInt(merged.CODESASU_IDLE_TIMEOUT_MS || '', 10) || DEFAULT_IDLE_TIMEOUT_MS;
  const pollIntervalMs = parseInt(merged.CODESASU_POLL_INTERVAL_MS || '', 10) || DEFAULT_POLL_INTERVAL_MS;
  const claudeDir = merged.CODESASU_CLAUDE_DIR || DEFAULT_CLAUDE_DIR;
  // 프로젝트 루트 — 부팅 스캔과 idle 수동 재분석 시 소스 파일을 수집하는 기준.
  // 미설정 시 process.cwd() fallback (설치 디렉토리에서 실행되는 경우를 대비).
  const projectDir = merged.CODESASU_PROJECT_DIR || process.cwd();

  const missing = [];
  if (!projectId) missing.push('CODESASU_PROJECT_ID');
  if (!token) missing.push('CODESASU_AGENT_TOKEN');
  if (missing.length > 0) {
    throw new Error(
      `Missing required config: ${missing.join(', ')}. Set in ${CONFIG_PATH} or environment.`
    );
  }

  return { projectId, token, signingKey, apiUrl, idleTimeoutMs, pollIntervalMs, claudeDir, projectDir };
}

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function pickEnv() {
  const keys = [
    'CODESASU_PROJECT_ID',
    'CODESASU_AGENT_TOKEN',
    'CODESASU_SIGNING_KEY',
    'CODESASU_API_URL',
    'CODESASU_IDLE_TIMEOUT_MS',
    'CODESASU_POLL_INTERVAL_MS',
    'CODESASU_CLAUDE_DIR',
    'CODESASU_PROJECT_DIR',
  ];
  const out = {};
  for (const k of keys) {
    if (process.env[k]) out[k] = process.env[k];
  }
  return out;
}

function createLogger() {
  const write = async (level, msg) => {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    process.stdout.write(line);
    try {
      await mkdir(join(CODESASU_HOME, 'logs'), { recursive: true });
      await appendFile(LOG_PATH, line, 'utf8');
    } catch {
      // 로그 파일 쓰기 실패는 무시 (stdout으로는 출력됨)
    }
  };
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}

/**
 * 부팅 시 1회 실행 — 서버의 first_scan_done이 false면 전체 소스 파일을 수집하여
 * source-snapshot 라우트로 전송한다. 상태 일치 시 즉시 return.
 *
 * 실패해도 에러를 throw하지 않음 — watcher는 계속 동작해야 한다 (graceful degradation).
 */
async function runBootScanIfNeeded({ config, state, logger }) {
  const serverStatus = await checkFullScanPending({
    apiUrl: config.apiUrl,
    token: config.token,
  });

  if (!serverStatus) {
    await logger.warn('boot scan: /api/agent/check failed — skipping boot scan (will retry next boot)');
    return;
  }

  if (serverStatus.firstScanDone) {
    // 서버가 single source of truth — state.json 미기록이라도 보정만 하고 종료
    if (!state.hasFullScanSent(config.projectId)) {
      await state.markFullScanSent(config.projectId);
    }
    await logger.info('boot scan: first_scan_done=true on server — skipped');
    return;
  }

  await logger.info(
    `boot scan: first connection — collecting source + docs from ${config.projectDir}`
  );
  const sourceRun = await collectSourceFiles(config.projectDir);
  for (const w of sourceRun.warnings) await logger.warn(w);

  if (sourceRun.files.length === 0) {
    await logger.warn(
      `boot scan: no source files found under ${config.projectDir} — skipping`
    );
    return;
  }

  // docs/*.md 동시 수집 — 없으면 빈 배열 (정상). 서버는 docs_files가 있을 때만 extract 실행.
  const docsRun = await collectDocs(config.projectDir);
  for (const w of docsRun.warnings) await logger.warn(w);

  await logger.info(
    `boot scan: ${sourceRun.files.length} source + ${docsRun.docs.length} docs collected — sending`
  );
  const result = await pushSourceSnapshot({
    apiUrl: config.apiUrl,
    token: config.token,
    signingKey: config.signingKey,
    projectId: config.projectId,
    sourceFiles: sourceRun.files,
    docsFiles: docsRun.docs,
  });

  if (result.ok) {
    await state.markFullScanSent(config.projectId);
    if (result.skipped) {
      await logger.info(`boot scan: server reported ${result.skipped} — state synced`);
    } else {
      await logger.info(
        `boot scan: ${result.featuresExtracted ?? 0} features extracted, ${result.featuresAssessed} assessed in ${result.scanDurationMs}ms`
      );
    }
  } else {
    await logger.error(
      `boot scan failed: status=${result.status ?? 'n/a'} ${
        result.error ?? JSON.stringify(result.body ?? '')
      }`
    );
  }
}

async function main() {
  const logger = createLogger();
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    await logger.error(err.message);
    process.exit(1);
  }

  await logger.info(
    `CodeSasu agent starting — project=${config.projectId} api=${config.apiUrl} idle=${config.idleTimeoutMs}ms poll=${config.pollIntervalMs}ms projectDir=${config.projectDir} hmac=${config.signingKey ? 'on' : 'off (legacy)'}`
  );

  if (!config.signingKey) {
    await logger.warn(
      'CODESASU_SIGNING_KEY missing — payload signature disabled. Re-run setup-codesasu.sh with --signing-key for HMAC protection.'
    );
  }

  const state = new State(STATE_PATH);
  await state.load();

  // 부팅 시 1회 — first_scan_done=false면 즉시 전체 소스 스캔 → source-snapshot 라우트로 전송.
  // 실패해도 watcher는 계속 동작 (다음 부팅에 자연 재시도).
  await runBootScanIfNeeded({ config, state, logger });

  // 수동 재분석(=서버의 pending_full_scan) 픽업용 플래그.
  // 부팅 스캔이 first_scan을 담당하므로, idle 경로는 pending만 처리한다.
  let pendingFullScan = false;

  const watcher = new Watcher({
    claudeDir: config.claudeDir,
    idleTimeoutMs: config.idleTimeoutMs,
    logger,
    onSessionIdle: async (path) => {
      await logger.info(`session idle detected: ${path}`);
      const result = await collectSession(path);
      if (!result.ok) {
        await logger.warn(`collect skip (${result.reason}): ${path}`);
        return;
      }
      if (state.has(result.sessionId)) {
        await logger.info(`session ${result.sessionId} already pushed — skip`);
        return;
      }
      for (const w of result.warnings) await logger.warn(w);

      // 수동 재분석 요청만 full_scan을 트리거 — first_scan은 부팅 경로가 책임짐.
      if (pendingFullScan) {
        const sourceDir = result.cwd || config.projectDir;
        await logger.info(`pending full_scan — collecting source files from ${sourceDir}`);
        const sourceRun = await collectSourceFiles(sourceDir);
        for (const w of sourceRun.warnings) await logger.warn(w);
        result.sourceFiles = sourceRun.files;
        result.scanMode = 'full';
        await logger.info(`source files collected: ${sourceRun.files.length} files`);
      }

      const pushResult = await pushSession({
        apiUrl: config.apiUrl,
        token: config.token,
        signingKey: config.signingKey,
        projectId: config.projectId,
        sessionResult: result,
      });

      if (pushResult.ok) {
        await state.markPushed(result.sessionId);
        if (result.scanMode === 'full') {
          await state.markFullScanSent(config.projectId);
          pendingFullScan = false;
        }
        // 서버가 추가 full_scan을 요청하면 다음 idle에 반영
        if (pushResult.scan?.request_full_scan) {
          pendingFullScan = true;
          await logger.info('server requested full_scan on next push');
        }
        await logger.info(
          `push ok (${pushResult.duplicate ? 'duplicate' : 'new'}) session=${pushResult.sessionId} mode=${result.scanMode ?? 'incremental'}`
        );
      } else {
        await logger.error(
          `push failed: status=${pushResult.status ?? 'n/a'} ${
            pushResult.error ?? JSON.stringify(pushResult.body ?? '')
          }`
        );
      }
    },
  });

  watcher.start();

  // 폴링 루프 — 60초마다 /api/agent/check 호출하여 pending_full_scan 픽업
  const pollHandle = setInterval(async () => {
    const status = await checkFullScanPending({
      apiUrl: config.apiUrl,
      token: config.token,
    });
    if (status && status.requestFullScan) {
      if (!pendingFullScan) {
        await logger.info(
          `poll: full_scan requested (first_scan_done=${status.firstScanDone}, pending=${status.pendingFullScan})`
        );
      }
      pendingFullScan = true;
    }
  }, config.pollIntervalMs);
  // process.exit 시까지 살아있게 — unref로 폴링이 종료 막지 않도록
  pollHandle.unref?.();

  const shutdown = async (signal) => {
    await logger.info(`received ${signal} — shutting down`);
    clearInterval(pollHandle);
    await watcher.stop();
    await watcher.drain();
    await logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack ?? err.message}`);
  process.exit(1);
});
