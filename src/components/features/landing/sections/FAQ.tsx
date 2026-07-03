'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { FadeIn } from '@/src/components/features/landing/_components/FadeIn';

const faqs = [
  {
    q: '코드를 모르는데 쓸 수 있나요?',
    a: "네 CodeSasu는 비개발자를 위해 만들어졌습니다 예를 들어, '결제 기능이 삭제되었습니다'라는 이슈가 감지되면 문제의 원인과 심각도를 알려주고, 수정 명령어를 제공합니다 사수가 제공하는 수정 명령어를 붙여넣으면 코드가 복구됩니다 코드를 직접 읽거나 수정할 필요가 전혀 없습니다",
  },
  {
    q: '내 코드가 서버에 저장되나요?',
    a: '아닙니다 코드 원본은 분석 후 즉시 파기됩니다 분석 결과만 안전하게 저장됩니다',
  },
  {
    q: 'Claude Code 외에 다른 도구도 지원하나요?',
    a: '현재는 Claude Code(macOS)를 지원합니다 Cursor, Windsurf, Windows 등은 출시 후 순차 지원 예정이며, 사전 등록해두시면 지원이 확대될 때 가장 먼저 알려드립니다',
  },
  {
    q: '무료로 쓸 수 있나요?',
    a: '사전 등록하시면 출시 첫 달 무료 크레딧을 드립니다 본인 Claude API 키를 등록하면 추가 비용 없이 계속 사용할 수 있습니다',
  },
  {
    q: '기존 코드 검사 도구와 뭐가 다른가요?',
    a: '기존 도구(SonarQube, ESLint 등)는 개발자용입니다 CodeSasu는 같은 가치를 비개발자가 이해할 수 있는 언어로 제공합니다',
  },
];

export function FAQ() {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  return (
    <section id="faq" className="bg-[#FAFAF9] border-y border-border">
      <div className="max-w-3xl mx-auto px-6 py-16 md:py-24">
        <FadeIn>
          <div className="text-center mb-12">
            <h2 className="text-[32px] md:text-[44px] leading-[1.15] font-bold text-foreground tracking-tight">
              자주 묻는 질문
            </h2>
          </div>
        </FadeIn>
        <FadeIn delay={100}>
          <div className="flex flex-col gap-3">
            {faqs.map((item, idx) => {
              const isOpen = openIdx === idx;
              return (
                <div
                  key={idx}
                  className="rounded-xl border border-border bg-white overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => setOpenIdx(isOpen ? null : idx)}
                    className="w-full min-h-[48px] flex items-center justify-between gap-4 px-6 py-5 text-left cursor-pointer hover:bg-[#FAFAF9] transition-colors"
                  >
                    <span className="text-[15px] font-semibold text-foreground">
                      {item.q}
                    </span>
                    <ChevronDown
                      size={18}
                      className={[
                        'flex-shrink-0 text-muted-foreground transition-transform duration-200',
                        isOpen ? 'rotate-180' : '',
                      ].join(' ')}
                    />
                  </button>
                  {isOpen && (
                    <div className="px-6 pb-5 -mt-1">
                      <p className="text-[14px] font-medium text-muted-foreground leading-relaxed">
                        {item.a}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
