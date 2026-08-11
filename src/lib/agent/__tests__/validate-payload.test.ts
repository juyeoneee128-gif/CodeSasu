import { describe, it, expect } from 'vitest';
import {
  validatePayload,
  validatePayloadSize,
  validateSourceSnapshotPayload,
  MAX_PAYLOAD_SIZE,
} from '../validate-payload';
import { MOCK_PUSH_PAYLOAD } from './mock-jsonl';

describe('validatePayload', () => {
  it('유효한 페이로드를 통과시킨다', () => {
    const result = validatePayload(MOCK_PUSH_PAYLOAD);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.project_id).toBe('test-project-uuid');
      expect(result.payload.session_data.jsonl_log.length).toBeGreaterThan(0);
    }
  });

  it('null/undefined body를 거부한다', () => {
    expect(validatePayload(null).valid).toBe(false);
    expect(validatePayload(undefined).valid).toBe(false);
  });

  it('project_id 누락 시 에러를 반환한다', () => {
    const result = validatePayload({
      session_data: { jsonl_log: 'test' },
      metadata: { agent_version: '1.0', pushed_at: '2026-01-01' },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('project_id is required and must be a string');
    }
  });

  it('jsonl_log 누락 시 에러를 반환한다', () => {
    const result = validatePayload({
      project_id: 'test',
      session_data: {},
      metadata: { agent_version: '1.0', pushed_at: '2026-01-01' },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('jsonl_log'))).toBe(true);
    }
  });

  it('빈 jsonl_log를 거부한다', () => {
    const result = validatePayload({
      project_id: 'test',
      session_data: { jsonl_log: '   ' },
      metadata: { agent_version: '1.0', pushed_at: '2026-01-01' },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('empty'))).toBe(true);
    }
  });

  it('metadata 누락 시 에러를 반환한다', () => {
    const result = validatePayload({
      project_id: 'test',
      session_data: { jsonl_log: 'test' },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('metadata'))).toBe(true);
    }
  });

  it('잘못된 diffs 구조를 거부한다', () => {
    const result = validatePayload({
      project_id: 'test',
      session_data: {
        jsonl_log: 'test',
        diffs: [{ file_path: 'a.ts' }], // diff_content, change_type 누락
      },
      metadata: { agent_version: '1.0', pushed_at: '2026-01-01' },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('diff_content'))).toBe(true);
      expect(result.errors.some((e) => e.includes('change_type'))).toBe(true);
    }
  });

  it('여러 필드 누락 시 모든 에러를 한번에 반환한다', () => {
    const result = validatePayload({});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });

  describe('docs_files 검증', () => {
    function withDocs(docs: unknown) {
      return {
        project_id: 'test',
        session_data: { jsonl_log: 'a', docs_files: docs },
        metadata: { agent_version: '1.0', pushed_at: '2026-01-01' },
      };
    }

    it('docs_files가 누락이어도 유효 (선택 필드)', () => {
      const result = validatePayload({
        project_id: 'test',
        session_data: { jsonl_log: 'a' },
        metadata: { agent_version: '1.0', pushed_at: '2026-01-01' },
      });
      expect(result.valid).toBe(true);
    });

    it('정상 docs_files 통과', () => {
      const result = validatePayload(
        withDocs([
          {
            path: 'docs/prd_v1.md',
            content: '# PRD',
            modified_at: '2026-01-01T00:00:00.000Z',
          },
        ])
      );
      expect(result.valid).toBe(true);
    });

    it('배열이 아니면 거부', () => {
      const result = validatePayload(withDocs('not an array'));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('must be an array'))).toBe(true);
      }
    });

    it('path 누락 시 거부', () => {
      const result = validatePayload(
        withDocs([{ content: 'x', modified_at: '2026-01-01T00:00:00.000Z' }])
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('path'))).toBe(true);
      }
    });

    it('content 누락 시 거부', () => {
      const result = validatePayload(
        withDocs([{ path: 'a.md', modified_at: '2026-01-01T00:00:00.000Z' }])
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('content'))).toBe(true);
      }
    });

    it('content가 60_000자 초과 시 거부', () => {
      const result = validatePayload(
        withDocs([
          {
            path: 'a.md',
            content: 'x'.repeat(60_001),
            modified_at: '2026-01-01T00:00:00.000Z',
          },
        ])
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('60_000'))).toBe(true);
      }
    });

    it('modified_at이 invalid ISO이면 거부', () => {
      const result = validatePayload(
        withDocs([{ path: 'a.md', content: 'x', modified_at: 'not-a-date' }])
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('valid ISO'))).toBe(true);
      }
    });
  });
});

describe('validatePayloadSize', () => {
  it('한도 이하를 허용한다', () => {
    expect(validatePayloadSize('small payload')).toBe(true);
  });

  it('한도 초과를 거부한다', () => {
    const largePayload = 'x'.repeat(MAX_PAYLOAD_SIZE + 1);
    expect(validatePayloadSize(largePayload)).toBe(false);
  });
});

describe('source_files 검증 (full_scan)', () => {
  function withSources(files: unknown, scanMode = 'full') {
    return {
      project_id: 'test',
      session_data: { jsonl_log: 'a', source_files: files },
      metadata: { agent_version: '1.0', pushed_at: '2026-01-01', scan_mode: scanMode },
    };
  }

  it('정상 source_files + scan_mode=full을 통과시킨다', () => {
    const result = validatePayload(
      withSources([
        { path: 'src/auth.ts', content: 'export function login() {}', line_count: 1 },
      ])
    );
    expect(result.valid).toBe(true);
  });

  it('파일당 80KB 초과 시 거부한다', () => {
    const big = 'x'.repeat(80_001);
    const result = validatePayload(
      withSources([{ path: 'big.ts', content: big, line_count: 1 }])
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('exceeds 80000'))).toBe(true);
    }
  });

  it('전체 합산 2MB 초과 시 거부한다', () => {
    // 파일당 70KB × 31 = 2.1MB → 합산 초과
    const chunk = 'a'.repeat(70_000);
    const files = Array.from({ length: 31 }, (_, i) => ({
      path: `f${i}.ts`,
      content: chunk,
      line_count: 1,
    }));
    const result = validatePayload(withSources(files));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('total content exceeds'))).toBe(true);
    }
  });

  it('line_count 누락/음수 시 거부한다', () => {
    const result = validatePayload(
      withSources([{ path: 'a.ts', content: 'x', line_count: -1 }])
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('line_count'))).toBe(true);
    }
  });

  it('scan_mode 잘못된 값 거부', () => {
    const result = validatePayload(withSources([], 'bogus'));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('scan_mode'))).toBe(true);
    }
  });
});

describe('validateSourceSnapshotPayload (부팅 스캔)', () => {
  const validMeta = { agent_version: '0.5.0', pushed_at: '2026-05-16T00:00:00.000Z' };

  it('정상 페이로드를 통과시킨다', () => {
    const result = validateSourceSnapshotPayload({
      project_id: 'p-1',
      source_files: [
        { path: 'src/auth.ts', content: 'export function login() {}', line_count: 1 },
      ],
      metadata: validMeta,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.project_id).toBe('p-1');
      expect(result.payload.source_files).toHaveLength(1);
    }
  });

  it('project_id 누락 시 거부한다', () => {
    const result = validateSourceSnapshotPayload({
      source_files: [{ path: 'a.ts', content: 'x', line_count: 1 }],
      metadata: validMeta,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('project_id'))).toBe(true);
    }
  });

  it('source_files가 빈 배열이면 거부한다 (적어도 1개 필요)', () => {
    const result = validateSourceSnapshotPayload({
      project_id: 'p-1',
      source_files: [],
      metadata: validMeta,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('at least 1 file'))).toBe(true);
    }
  });

  it('파일당 80KB 초과 시 거부한다', () => {
    const big = 'x'.repeat(80_001);
    const result = validateSourceSnapshotPayload({
      project_id: 'p-1',
      source_files: [{ path: 'big.ts', content: big, line_count: 1 }],
      metadata: validMeta,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('exceeds 80000'))).toBe(true);
    }
  });

  it('전체 합산 2MB 초과 시 거부한다', () => {
    const chunk = 'a'.repeat(70_000);
    const files = Array.from({ length: 31 }, (_, i) => ({
      path: `f${i}.ts`,
      content: chunk,
      line_count: 1,
    }));
    const result = validateSourceSnapshotPayload({
      project_id: 'p-1',
      source_files: files,
      metadata: validMeta,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('total content exceeds'))).toBe(true);
    }
  });

  it('metadata 누락 시 거부한다', () => {
    const result = validateSourceSnapshotPayload({
      project_id: 'p-1',
      source_files: [{ path: 'a.ts', content: 'x', line_count: 1 }],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('metadata'))).toBe(true);
    }
  });

  it('source_files가 배열이 아니면 거부한다', () => {
    const result = validateSourceSnapshotPayload({
      project_id: 'p-1',
      source_files: 'not-array',
      metadata: validMeta,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('must be an array'))).toBe(true);
    }
  });

  describe('docs_files 부가 검증', () => {
    const okSource = [{ path: 'a.ts', content: 'x', line_count: 1 }];
    const okDoc = {
      path: 'docs/prd.md',
      content: '# PRD',
      modified_at: '2026-05-16T00:00:00.000Z',
    };

    it('정상 docs_files를 통과시킨다 (정상)', () => {
      const result = validateSourceSnapshotPayload({
        project_id: 'p-1',
        source_files: okSource,
        docs_files: [okDoc],
        metadata: validMeta,
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.payload.docs_files).toHaveLength(1);
      }
    });

    it('docs_files가 누락이어도 통과 (선택 필드 — 엣지)', () => {
      const result = validateSourceSnapshotPayload({
        project_id: 'p-1',
        source_files: okSource,
        metadata: validMeta,
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.payload.docs_files).toBeUndefined();
      }
    });

    it('docs_files 파일당 200KB 초과 시 거부한다 (에러)', () => {
      const huge = 'a'.repeat(200_001);
      const result = validateSourceSnapshotPayload({
        project_id: 'p-1',
        source_files: okSource,
        docs_files: [{ ...okDoc, content: huge }],
        metadata: validMeta,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('exceeds 200000'))).toBe(true);
      }
    });

    it('docs_files 전체 합산 1MB 초과 시 거부한다 (에러)', () => {
      const chunk = 'a'.repeat(150_000);
      const docs = Array.from({ length: 8 }, (_, i) => ({
        path: `docs/${i}.md`,
        content: chunk,
        modified_at: '2026-05-16T00:00:00.000Z',
      }));
      const result = validateSourceSnapshotPayload({
        project_id: 'p-1',
        source_files: okSource,
        docs_files: docs,
        metadata: validMeta,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('total content exceeds'))).toBe(true);
      }
    });
  });
});
