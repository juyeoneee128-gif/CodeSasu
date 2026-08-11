import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// agent/docs-collector.js는 ESM JS — vitest는 Node ESM으로 직접 import 가능
import { collectDocs } from '../agent/docs-collector.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'codesasu-docs-test-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('collectDocs', () => {
  it('docs/ 폴더가 없으면 빈 배열 + 경고 없음', async () => {
    const result = await collectDocs(cwd);
    expect(result.docs).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('cwd가 없으면 빈 배열 + 경고', async () => {
    const result = await collectDocs('');
    expect(result.docs).toEqual([]);
    expect(result.warnings.some((w: string) => w.includes('cwd missing'))).toBe(true);
  });

  it('docs/*.md 파일을 수집한다', async () => {
    await mkdir(join(cwd, 'docs'));
    await writeFile(join(cwd, 'docs', 'prd_v1.md'), '# PRD v1\n\n본문');
    await writeFile(join(cwd, 'docs', 'frd_v1.md'), '# FRD v1\n\n본문');

    const result = await collectDocs(cwd);
    expect(result.docs).toHaveLength(2);
    const paths = result.docs.map((d) => d.path).sort();
    expect(paths).toEqual(['docs/frd_v1.md', 'docs/prd_v1.md']);
    const prd = result.docs.find((d) => d.path === 'docs/prd_v1.md')!;
    expect(prd.content).toContain('PRD v1');
    expect(prd.modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('하위 폴더도 재귀적으로 스캔', async () => {
    await mkdir(join(cwd, 'docs', 'specs'), { recursive: true });
    await writeFile(join(cwd, 'docs', 'top.md'), 'top');
    await writeFile(join(cwd, 'docs', 'specs', 'nested.md'), 'nested');

    const result = await collectDocs(cwd);
    const paths = result.docs.map((d) => d.path).sort();
    expect(paths).toEqual(['docs/specs/nested.md', 'docs/top.md']);
  });

  it('.md 외 확장자는 무시 (.txt, .mdx 등)', async () => {
    await mkdir(join(cwd, 'docs'));
    await writeFile(join(cwd, 'docs', 'a.md'), 'md');
    await writeFile(join(cwd, 'docs', 'b.txt'), 'txt');
    await writeFile(join(cwd, 'docs', 'c.mdx'), 'mdx');

    const result = await collectDocs(cwd);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].path).toBe('docs/a.md');
  });

  it('대소문자 .MD도 인식한다', async () => {
    await mkdir(join(cwd, 'docs'));
    await writeFile(join(cwd, 'docs', 'README.MD'), 'cap');
    const result = await collectDocs(cwd);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].path).toBe('docs/README.MD');
  });

  it('50KB 초과 단일 파일은 skip + warning', async () => {
    await mkdir(join(cwd, 'docs'));
    const huge = 'x'.repeat(60_000); // > 50KB
    await writeFile(join(cwd, 'docs', 'huge.md'), huge);
    await writeFile(join(cwd, 'docs', 'small.md'), 'ok');

    const result = await collectDocs(cwd);
    expect(result.docs.map((d) => d.path)).toEqual(['docs/small.md']);
    expect(result.warnings.some((w: string) => w.includes('huge.md'))).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('exceeds'))).toBe(true);
  });

  it('전체 500KB 초과 시 작은 파일 우선, 큰 것이 잘림', async () => {
    await mkdir(join(cwd, 'docs'));
    // 각 40KB × 14 = 560KB → 13개 (520KB)는 들어가고 14번째는 잘림
    const body = 'x'.repeat(40_000);
    for (let i = 0; i < 14; i++) {
      await writeFile(join(cwd, 'docs', `f${String(i).padStart(2, '0')}.md`), body);
    }
    const result = await collectDocs(cwd);
    expect(result.docs.length).toBeLessThan(14);
    expect(result.docs.length).toBeGreaterThanOrEqual(12);
    expect(result.warnings.some((w: string) => w.includes('total budget'))).toBe(true);
  });

  it('심볼릭 링크는 따라가지 않음 + warning', async () => {
    await mkdir(join(cwd, 'docs'));
    await mkdir(join(cwd, 'outside'));
    await writeFile(join(cwd, 'outside', 'secret.md'), 'secret');
    await symlink(join(cwd, 'outside'), join(cwd, 'docs', 'link'));

    const result = await collectDocs(cwd);
    expect(result.docs.find((d) => d.path.includes('secret.md'))).toBeUndefined();
    expect(result.warnings.some((w: string) => w.includes('symlink'))).toBe(true);
  });

  it('결과는 path 알파벳순으로 정렬된다', async () => {
    await mkdir(join(cwd, 'docs'));
    await writeFile(join(cwd, 'docs', 'z.md'), 'z');
    await writeFile(join(cwd, 'docs', 'a.md'), 'a');
    await writeFile(join(cwd, 'docs', 'm.md'), 'm');

    const result = await collectDocs(cwd);
    const paths = result.docs.map((d) => d.path);
    expect(paths).toEqual(['docs/a.md', 'docs/m.md', 'docs/z.md']);
  });
});
