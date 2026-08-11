import { createHmac } from 'node:crypto';

const AGENT_VERSION = '0.5.0';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

/**
 * 서버와 동일한 방식으로 HMAC-SHA256 서명을 계산합니다.
 * 입력: `{timestamp}.{body}` — timestamp 변조 차단.
 *
 * test/agent-server-roundtrip.test.ts에서 import해서 서버 검증 로직과 일치 확인.
 */
export function signPayload(timestamp, body, signingKey) {
  return createHmac('sha256', signingKey).update(`${timestamp}.${body}`).digest('hex');
}

export async function pushSession({ apiUrl, token, signingKey, projectId, sessionResult }) {
  const scanMode = sessionResult.scanMode === 'full' ? 'full' : 'incremental';
  const sourceFiles = scanMode === 'full' ? (sessionResult.sourceFiles ?? []) : [];

  const payload = {
    project_id: projectId,
    session_data: {
      jsonl_log: sessionResult.jsonlLog,
      diffs: sessionResult.diffs,
      eslint_results: sessionResult.eslintResults ?? [],
      docs_files: sessionResult.docsFiles ?? [],
      ...(sourceFiles.length > 0 ? { source_files: sourceFiles } : {}),
    },
    metadata: {
      agent_version: AGENT_VERSION,
      pushed_at: new Date().toISOString(),
      entrypoint: 'local-agent',
      scan_mode: scanMode,
    },
  };

  const body = JSON.stringify(payload);
  const endpoint = `${apiUrl.replace(/\/$/, '')}/api/agent/push`;

  // signing_key가 있으면 HMAC 서명 헤더 추가. 없으면 0.3.x 호환 모드.
  const buildHeaders = () => {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (signingKey) {
      const timestamp = Date.now().toString();
      headers['X-CodeSasu-Timestamp'] = timestamp;
      headers['X-CodeSasu-Signature'] = signPayload(timestamp, body, signingKey);
    }
    return headers;
  };

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildHeaders(),
        body,
      });

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // non-JSON response
      }

      if (res.status === 201) {
        return {
          ok: true,
          sessionId: json?.session_id ?? sessionResult.sessionId,
          status: 201,
          scan: json?.scan ?? null,
        };
      }
      if (res.status === 409) {
        // 서버에서 중복으로 판정 — 정상 처리로 간주
        return {
          ok: true,
          duplicate: true,
          sessionId: json?.existing_session_id ?? sessionResult.sessionId,
          status: 409,
        };
      }

      if (res.status >= 400 && res.status < 500) {
        // 클라이언트 에러는 재시도 안 함
        return { ok: false, status: res.status, body: json ?? text };
      }

      lastError = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(3, attempt);
      await sleep(delay);
    }
  }

  return { ok: false, error: lastError?.message ?? 'unknown error' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /api/agent/source-snapshot — 에이전트 부팅 시 1회 호출.
 * 전체 소스 파일을 서버로 전송하여 assessFeatures만 실행시킨다.
 * push 라우트와 분리된 엔드포인트 — jsonl_log/diff/eslint 없음.
 *
 * 재시도 정책은 pushSession과 동일 (5xx만 지수 백오프, 4xx는 즉시 실패).
 */
export async function pushSourceSnapshot({
  apiUrl,
  token,
  signingKey,
  projectId,
  sourceFiles,
  docsFiles,
}) {
  const payload = {
    project_id: projectId,
    source_files: sourceFiles,
    ...(docsFiles && docsFiles.length > 0 ? { docs_files: docsFiles } : {}),
    metadata: {
      agent_version: AGENT_VERSION,
      pushed_at: new Date().toISOString(),
    },
  };

  const body = JSON.stringify(payload);
  const endpoint = `${apiUrl.replace(/\/$/, '')}/api/agent/source-snapshot`;

  const buildHeaders = () => {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (signingKey) {
      const timestamp = Date.now().toString();
      headers['X-CodeSasu-Timestamp'] = timestamp;
      headers['X-CodeSasu-Signature'] = signPayload(timestamp, body, signingKey);
    }
    return headers;
  };

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildHeaders(),
        body,
      });

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // non-JSON response
      }

      if (res.status === 201 || res.status === 200) {
        return {
          ok: true,
          status: res.status,
          skipped: json?.skipped ?? null,
          featuresAssessed: json?.features_assessed ?? 0,
          featuresExtracted: json?.features_extracted ?? 0,
          docsSynced: json?.docs_synced ?? 0,
          scanDurationMs: json?.scan_duration_ms ?? 0,
          sourceFilesCount: json?.source_files_count ?? sourceFiles.length,
        };
      }

      if (res.status >= 400 && res.status < 500) {
        return { ok: false, status: res.status, body: json ?? text };
      }

      lastError = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(3, attempt);
      await sleep(delay);
    }
  }

  return { ok: false, error: lastError?.message ?? 'unknown error' };
}

/**
 * GET /api/agent/check — pending_full_scan / first_scan_done 상태 확인.
 * 폴링용. 가벼운 호출 (DB 단일 row 조회).
 * 실패 시 null 반환 (다음 폴링 사이클에서 재시도).
 */
export async function checkFullScanPending({ apiUrl, token }) {
  const endpoint = `${apiUrl.replace(/\/$/, '')}/api/agent/check`;
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return {
      requestFullScan: !!json.request_full_scan,
      firstScanDone: !!json.first_scan_done,
      pendingFullScan: !!json.pending_full_scan,
    };
  } catch {
    return null;
  }
}
