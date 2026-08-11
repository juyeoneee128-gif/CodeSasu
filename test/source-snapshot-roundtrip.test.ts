import { describe, it, expect } from 'vitest';
import { signPayload } from '../agent/sender.js';
import { computeSignature, verifyHmacSignature } from '../src/lib/agent/verify-signature';
import { validateSourceSnapshotPayload } from '../src/lib/agent/validate-payload';

/**
 * 에이전트 ↔ 서버 source-snapshot 라운드트립 회귀 보호.
 *
 * 에이전트의 pushSourceSnapshot이 만든 페이로드와 HMAC 서명을
 * 서버의 validateSourceSnapshotPayload + verifyHmacSignature가 정상 수용하는지 검증.
 * 알고리즘 또는 스키마가 갈라지면 모든 부팅 스캔이 실패하므로 강한 보호가 필요.
 */
describe('source-snapshot agent ↔ server round-trip', () => {
  const KEY = 'b2c3d4e5'.repeat(8); // hex 64자
  const AGENT_VERSION = '0.5.0';

  function buildAgentPayload(projectId = 'p-1') {
    return {
      project_id: projectId,
      source_files: [
        { path: 'src/auth.ts', content: 'export function login() {}', line_count: 1 },
        { path: 'src/db.ts', content: 'export const db = {};', line_count: 1 },
      ],
      metadata: {
        agent_version: AGENT_VERSION,
        pushed_at: new Date().toISOString(),
      },
    };
  }

  it('에이전트가 만든 payload를 서버가 validate 통과시킨다', () => {
    const payload = buildAgentPayload();
    const body = JSON.stringify(payload);
    const result = validateSourceSnapshotPayload(JSON.parse(body));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.source_files).toHaveLength(2);
    }
  });

  it('에이전트의 signPayload === 서버의 computeSignature (서명 알고리즘 일치)', () => {
    const body = JSON.stringify(buildAgentPayload());
    const ts = Date.now().toString();
    expect(signPayload(ts, body, KEY)).toBe(computeSignature(ts, body, KEY));
  });

  it('에이전트가 서명한 source-snapshot 페이로드를 서버 verify가 수용', () => {
    const body = JSON.stringify(buildAgentPayload());
    const now = Date.now();
    const ts = now.toString();
    const sig = signPayload(ts, body, KEY);
    const result = verifyHmacSignature(body, sig, ts, KEY, now);
    expect(result.valid).toBe(true);
  });

  it('source_files 한 글자만 변조해도 서명 검증 실패', () => {
    const body = JSON.stringify(buildAgentPayload());
    const now = Date.now();
    const ts = now.toString();
    const sig = signPayload(ts, body, KEY);
    const tampered = body.replace('export function login', 'export function pwn');
    const result = verifyHmacSignature(tampered, sig, ts, KEY, now);
    expect(result.valid).toBe(false);
  });

  it('source_files 0건은 서버가 거부 (부팅 스캔의 최소 1개 원칙)', () => {
    const payload = buildAgentPayload();
    payload.source_files = [];
    const result = validateSourceSnapshotPayload(payload);
    expect(result.valid).toBe(false);
  });

  it('docs_files를 함께 보내면 서버 validate 통과 + 페이로드 보존 (기능 추출 입력 준비)', () => {
    const payload = {
      ...buildAgentPayload(),
      docs_files: [
        {
          path: 'docs/prd.md',
          content: '# PRD\n\n## 기능1\n로그인',
          modified_at: '2026-05-16T00:00:00.000Z',
        },
        {
          path: 'docs/frd.md',
          content: '# FRD\n\n## 기능2\n회원가입',
          modified_at: '2026-05-16T00:00:00.000Z',
        },
      ],
    };
    const body = JSON.stringify(payload);
    const result = validateSourceSnapshotPayload(JSON.parse(body));
    expect(result.valid).toBe(true);
    if (result.valid) {
      // 라우트는 이 docs_files를 보고 syncAgentDocs + extractFeaturesForDocument를 실행한다.
      // payload.docs_files가 그대로 보존되어 서버 로직이 입력으로 사용 가능해야 함.
      expect(result.payload.docs_files).toHaveLength(2);
      expect(result.payload.docs_files?.[0].path).toBe('docs/prd.md');
    }
  });

  it('docs_files를 함께 서명해도 라운드트립 (변조 없으면 통과)', () => {
    const payload = {
      ...buildAgentPayload(),
      docs_files: [
        {
          path: 'docs/prd.md',
          content: '# PRD',
          modified_at: '2026-05-16T00:00:00.000Z',
        },
      ],
    };
    const body = JSON.stringify(payload);
    const now = Date.now();
    const ts = now.toString();
    const sig = signPayload(ts, body, KEY);
    const result = verifyHmacSignature(body, sig, ts, KEY, now);
    expect(result.valid).toBe(true);
  });
});
