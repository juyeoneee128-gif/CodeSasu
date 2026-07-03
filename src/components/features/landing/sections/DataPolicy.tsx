import { Lock, ShieldCheck, FileSearch } from 'lucide-react';
import { FadeIn } from '@/src/components/features/landing/_components/FadeIn';

const policies = [
  {
    Icon: Lock,
    title: '코드 원본은 즉시 파기합니다',
    body: '분석이 끝나면 코드는 저장하지 않고 바로 폐기합니다',
  },
  {
    Icon: ShieldCheck,
    title: '기획서(docs)는 기능 추출을 위해 저장됩니다',
    body: '무엇을 만들려 했는지 대조하는 데만 씁니다',
  },
  {
    Icon: FileSearch,
    title: '민감정보는 값 자체를 저장하지 않습니다',
    body: '비밀번호·API 키 같은 값은 저장하지 않지만, 코드나 설정 파일에 키가 노출돼 있으면 유출 위험을 알려드립니다',
  },
];

export function DataPolicy() {
  return (
    <section className="bg-white">
      <div className="max-w-[1200px] mx-auto px-6 py-16 md:py-24">
        <FadeIn>
          <div className="max-w-2xl text-center mx-auto mb-14">
            <h2 className="text-[32px] md:text-[44px] leading-[1.15] font-bold text-foreground tracking-tight">
              당신의 코드는 안전합니다
            </h2>
          </div>
        </FadeIn>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-5xl mx-auto">
          {policies.map(({ Icon, title, body }, idx) => (
            <FadeIn key={title} delay={idx * 100}>
              <div className="h-full rounded-2xl border border-border bg-[#FAFAF9] p-7">
                <div className="w-10 h-10 rounded-lg bg-[#FFF7ED] flex items-center justify-center mb-5">
                  <Icon size={20} className="text-[#E67D22]" />
                </div>
                <h3 className="text-[16px] font-semibold text-foreground tracking-tight">
                  {title}
                </h3>
                <p className="mt-2.5 text-[14px] font-medium text-muted-foreground leading-relaxed whitespace-pre-line">
                  {body}
                </p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
