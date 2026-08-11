import { describe, it, expect } from 'vitest';
import { extractSignatureFromContent } from '../extract-signature-regex';

describe('extractSignatureFromContent — 언어 필터', () => {
  it('JS/TS 외 확장자는 null', () => {
    expect(extractSignatureFromContent('config.json', '{}')).toBeNull();
    expect(extractSignatureFromContent('app.py', 'def foo(): pass')).toBeNull();
    expect(extractSignatureFromContent('main.go', 'func main() {}')).toBeNull();
    expect(extractSignatureFromContent('readme.md', '# title')).toBeNull();
  });

  it('TS/TSX/JS/JSX/MJS/CJS 확장자는 추출', () => {
    expect(extractSignatureFromContent('a.ts', '')).not.toBeNull();
    expect(extractSignatureFromContent('a.tsx', '')).not.toBeNull();
    expect(extractSignatureFromContent('a.js', '')).not.toBeNull();
    expect(extractSignatureFromContent('a.jsx', '')).not.toBeNull();
    expect(extractSignatureFromContent('a.mjs', '')).not.toBeNull();
    expect(extractSignatureFromContent('a.cjs', '')).not.toBeNull();
  });
});

describe('extractSignatureFromContent — functions', () => {
  it('function 선언과 async function을 추출', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `function handleLogin() {}
       async function validateEmail() {}`
    );
    expect(sig!.functions).toEqual(expect.arrayContaining(['handleLogin', 'validateEmail']));
  });

  it('arrow function 표현식을 추출', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `const onClick = () => {};
       const fetchUser = async (id) => { return id; };`
    );
    expect(sig!.functions).toEqual(
      expect.arrayContaining(['onClick', 'fetchUser'])
    );
  });

  it('function 표현식 (const x = function ...)도 추출', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `const oldStyle = function () {};
       const asyncOldStyle = async function () {};`
    );
    expect(sig!.functions).toEqual(
      expect.arrayContaining(['oldStyle', 'asyncOldStyle'])
    );
  });

  it('주석 안의 함수 선언은 무시한다', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `// function shouldNotMatch() {}
       /* function alsoIgnore() {} */
       function realOne() {}`
    );
    expect(sig!.functions).toContain('realOne');
    expect(sig!.functions).not.toContain('shouldNotMatch');
    expect(sig!.functions).not.toContain('alsoIgnore');
  });
});

describe('extractSignatureFromContent — imports', () => {
  it('default/named/모두 import의 모듈 경로 추출', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `import React from 'react';
       import { useState, useEffect } from 'react';
       import * as fs from 'node:fs';
       import './styles.css';`
    );
    expect(sig!.imports).toEqual(
      expect.arrayContaining(['react', 'node:fs', './styles.css'])
    );
  });

  it('require도 추출', () => {
    const sig = extractSignatureFromContent(
      'a.cjs',
      `const path = require('path');
       const { readFileSync } = require('fs');`
    );
    expect(sig!.imports).toEqual(expect.arrayContaining(['path', 'fs']));
  });

  it('동일 모듈 중복은 dedup', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `import { a } from 'mod';
       import { b } from 'mod';`
    );
    expect(sig!.imports.filter((m) => m === 'mod')).toHaveLength(1);
  });
});

describe('extractSignatureFromContent — exports', () => {
  it('export default를 default라는 이름으로 기록', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `export default function App() {}`
    );
    expect(sig!.exports).toContain('default');
  });

  it('named export 선언', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `export function login() {}
       export const PI = 3.14;
       export class User {}`
    );
    expect(sig!.exports).toEqual(
      expect.arrayContaining(['login', 'PI', 'User'])
    );
  });

  it('export { foo, bar as baz }', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `export { foo, bar as baz };`
    );
    expect(sig!.exports).toEqual(expect.arrayContaining(['foo', 'bar']));
  });
});

describe('extractSignatureFromContent — patterns', () => {
  it('supabase 호출 체인을 추출', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `await supabase.auth.signInWithPassword({ email, password });
       supabase.from('users').select('*');`
    );
    // 첫 번째 메서드 체인까지 캡처되는 정도면 충분
    const hasSignIn = sig!.patterns.some((p) => p.includes('supabase.auth'));
    const hasFrom = sig!.patterns.some((p) => p.includes('supabase.from'));
    expect(hasSignIn).toBe(true);
    expect(hasFrom).toBe(true);
  });

  it('fetch 호출 패턴', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `await fetch('/api/users');`
    );
    expect(sig!.patterns).toContain('fetch');
  });

  it('"use client" 지시문', () => {
    const sig = extractSignatureFromContent(
      'a.tsx',
      `'use client';
       export default function Page() {}`
    );
    expect(sig!.patterns).toContain('use client');
  });

  it('stripe·prisma·openai·anthropic 호출 추출', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `stripe.charges.create({});
       prisma.user.findMany();
       openai.chat.completions.create();
       anthropic.messages.create();`
    );
    const hasAll =
      sig!.patterns.some((p) => p.startsWith('stripe.')) &&
      sig!.patterns.some((p) => p.startsWith('prisma.')) &&
      sig!.patterns.some((p) => p.startsWith('openai.')) &&
      sig!.patterns.some((p) => p.startsWith('anthropic.'));
    expect(hasAll).toBe(true);
  });

  it('문자열 안 fetch는 제외 (주석/문자열 strip 후)', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      `const url = "fetch('/api')"; // comment fetch
       const x = 1;`
    );
    expect(sig!.patterns).not.toContain('fetch');
  });
});

describe('extractSignatureFromContent — line_count', () => {
  it('줄 수를 정확히 카운트', () => {
    const sig = extractSignatureFromContent(
      'a.ts',
      'line1\nline2\nline3'
    );
    expect(sig!.line_count).toBe(3);
  });

  it('빈 본문은 1줄', () => {
    const sig = extractSignatureFromContent('a.ts', '');
    expect(sig!.line_count).toBe(1);
  });
});

describe('extractSignatureFromContent — 통합 시나리오', () => {
  it('전형적인 Next.js route.ts 파일을 종합 추출', () => {
    const sig = extractSignatureFromContent(
      'app/api/auth/login/route.ts',
      `import { NextResponse } from 'next/server';
       import { createClient } from '@/src/lib/supabase/server';

       export async function POST(request: Request) {
         const supabase = await createClient();
         const { email, password } = await request.json();
         const { data, error } = await supabase.auth.signInWithPassword({ email, password });
         if (error) return NextResponse.json({ error: error.message }, { status: 401 });
         return NextResponse.json({ user: data.user });
       }`
    );

    expect(sig!.file_path).toBe('app/api/auth/login/route.ts');
    expect(sig!.imports).toEqual(
      expect.arrayContaining(['next/server', '@/src/lib/supabase/server'])
    );
    expect(sig!.exports).toContain('POST');
    expect(sig!.functions).toContain('POST');
    const hasSupabase = sig!.patterns.some((p) => p.startsWith('supabase.'));
    expect(hasSupabase).toBe(true);
    expect(sig!.line_count).toBeGreaterThan(5);
  });
});
