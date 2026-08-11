import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// agent/source-collector.js는 ESM JS — vitest는 Node ESM으로 직접 import 가능
import { collectSourceFiles } from '../agent/source-collector.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'codesasu-source-test-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('collectSourceFiles', () => {
  it('cwd가 없으면 빈 배열 + 경고', async () => {
    const result = await collectSourceFiles('');
    expect(result.files).toEqual([]);
    expect(result.warnings.some((w: string) => w.includes('cwd missing'))).toBe(true);
  });

  it('소스 파일을 .ts/.tsx/.js/.md 확장자만 수집한다 (정상 케이스)', async () => {
    await writeFile(join(cwd, 'app.ts'), 'export const x = 1;');
    await writeFile(join(cwd, 'view.tsx'), 'export const View = () => null;');
    await writeFile(join(cwd, 'README.md'), '# Hello');
    await writeFile(join(cwd, 'logo.png'), 'binary');
    await writeFile(join(cwd, 'data.csv'), 'a,b,c');

    const result = await collectSourceFiles(cwd);
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toContain('app.ts');
    expect(paths).toContain('view.tsx');
    expect(paths).toContain('README.md');
    expect(paths).not.toContain('logo.png');
    expect(paths).not.toContain('data.csv');
  });

  it('node_modules / .git / dist 디렉토리는 제외한다 (엣지)', async () => {
    await mkdir(join(cwd, 'node_modules', 'foo'), { recursive: true });
    await mkdir(join(cwd, '.git'), { recursive: true });
    await mkdir(join(cwd, 'dist'), { recursive: true });
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'node_modules', 'foo', 'index.js'), 'lib');
    await writeFile(join(cwd, '.git', 'HEAD'), 'ref');
    await writeFile(join(cwd, 'dist', 'bundle.js'), 'bundle');
    await writeFile(join(cwd, 'src', 'app.ts'), 'app');

    const result = await collectSourceFiles(cwd);
    const paths = result.files.map((f) => f.path);
    expect(paths.every((p) => !p.includes('node_modules'))).toBe(true);
    expect(paths.every((p) => !p.startsWith('.git'))).toBe(true);
    expect(paths.every((p) => !p.startsWith('dist'))).toBe(true);
    expect(paths).toContain('src/app.ts');
  });

  it('storybook-static / .storybook / __pycache__ 디렉토리는 제외한다 (빌드 산출물 엣지)', async () => {
    await mkdir(join(cwd, 'storybook-static'), { recursive: true });
    await mkdir(join(cwd, '.storybook'), { recursive: true });
    await mkdir(join(cwd, '__pycache__'), { recursive: true });
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'storybook-static', 'iframe.html'), 'noise');
    await writeFile(join(cwd, 'storybook-static', 'main.js'), 'bundle');
    await writeFile(join(cwd, '.storybook', 'main.ts'), 'config');
    await writeFile(join(cwd, '__pycache__', 'foo.pyc'), 'binary');
    await writeFile(join(cwd, 'src', 'app.ts'), 'app');

    const result = await collectSourceFiles(cwd);
    const paths = result.files.map((f) => f.path);
    expect(paths.every((p) => !p.startsWith('storybook-static'))).toBe(true);
    expect(paths.every((p) => !p.startsWith('.storybook'))).toBe(true);
    expect(paths.every((p) => !p.startsWith('__pycache__'))).toBe(true);
    expect(paths).toContain('src/app.ts');
  });

  it('package-lock.json / .env / lock 파일은 제외한다 (보안 엣지)', async () => {
    await writeFile(join(cwd, '.env'), 'SECRET=x');
    await writeFile(join(cwd, '.env.local'), 'KEY=y');
    await writeFile(join(cwd, 'package-lock.json'), '{}');
    await writeFile(join(cwd, 'yarn.lock'), '');
    await writeFile(join(cwd, 'package.json'), '{"name":"x"}');

    const result = await collectSourceFiles(cwd);
    const paths = result.files.map((f) => f.path);
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('.env.local');
    expect(paths).not.toContain('package-lock.json');
    expect(paths).not.toContain('yarn.lock');
    expect(paths).toContain('package.json');
  });

  it('500줄 초과 파일은 잘라서 line_count=500 + truncation 마커를 추가한다', async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `// line ${i}`).join('\n');
    await writeFile(join(cwd, 'big.ts'), big);

    const result = await collectSourceFiles(cwd);
    const file = result.files.find((f) => f.path === 'big.ts');
    expect(file).toBeDefined();
    expect(file!.line_count).toBe(500);
    expect(file!.content).toContain('truncated at 500 lines');
  });

  it('파일당 80KB 초과는 skip + warning', async () => {
    // 단일 파일 100KB
    const big = 'a'.repeat(100_000);
    await writeFile(join(cwd, 'huge.ts'), big);

    const result = await collectSourceFiles(cwd);
    expect(result.files.find((f) => f.path === 'huge.ts')).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('huge.ts') && w.includes('exceeds'))).toBe(true);
  });
});
