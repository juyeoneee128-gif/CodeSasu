# CodeSasu — CLAUDE.md

Claude Code 프로젝트의 코드 파손 감지 + 복구 + 보호 도구 (MVP)

---

## 하네스 규칙

### 절대 금지 (CRITICAL)
- CRITICAL: supabase/migrations/ 폴더의 기존 파일을 수정하지 않는다. 새 마이그레이션만 추가.
- CRITICAL: src/lib/analysis/prompts.ts의 ANALYSIS_RESULT_TOOL required 배열을 변경하지 않는다.
- CRITICAL: agent/ 폴더의 설치 스크립트(setup-codesasu.sh) 호환성을 깨는 변경 금지.
- CRITICAL: 전체 테스트(vitest run) 통과 없이 커밋하지 않는다.

### 작업 프로세스
- 파일 3개 이상 수정 시 반드시 계획을 먼저 보여주고 승인 후 실행
- "실행해" 또는 "진행해"라고 할 때까지 코드를 작성하지 마라
- 커밋 메시지는 한글로, "feat: 이슈 탭 Critical 뷰 구현" 형식 (conventional commits)
- 새로운 페이지나 기능을 만들기 전에 반드시 계획서를 먼저 작성하고 승인을 받아라

### DB 규칙
- 새 테이블 작성 시 반드시 RLS 활성화 + 최소 1개 정책 포함
- 새 컬럼 추가 시 기존 row 호환 보장 (DEFAULT 값 필수)
- status/enum 컬럼 변경 시 기존 상태 전이 로직 전수 점검
- 마이그레이션 파일명: NNN_설명.sql (013부터 순번)

### 분석 파이프라인 규칙
- 프롬프트 수정 시 반드시 기존 테스트 키워드 보존 확인
- problems_only 모드에서 토큰 비용 증가하는 변경 금지 (자동 분석 비용 관리)
- file_signatures는 합집합 머지만 허용 (교체/삭제 금지, stale 용인)
- issues 상태 전이: unconfirmed ↔ auto_resolved ↔ confirmed. 재감지 시 unconfirmed 복원.

### 테스트 규칙
- 기능 추가 시 최소 3개 테스트 필수 (정상/엣지/에러)
- 프롬프트 변경 시 키워드 검증 테스트 필수
- 테스트 커밋 prefix: test:, 코드 변경 없으면 fix: 사용 금지

### 컴포넌트 규칙
- 기존 컴포넌트(src/components/)는 수정하지 말고 새 컴포넌트로 확장
- 새 컴포넌트는 반드시 같은 경로에 *.stories.tsx 파일 함께 생성

### 개발 로그 (옵시디언 연동)
- 작업 완료 후 `~/Desktop/[Project] Codesasu/logs/YYYY-MM-DD.md`에 요약 추가
- 파일이 없으면 새로 생성 (frontmatter 포함), 있으면 하단에 추가 (append)
- 볼트 경로가 없으면 skip (에러 아님)
- 형식:

```markdown
---
date: YYYY-MM-DD
project: CodeSasu
tags: [dev-log, 관련태그들]
---

# YYYY-MM-DD 개발 로그

## 📊 오늘의 요약
| 항목 | 내용 |
|------|------|
| 작업 시간 | HH:mm ~ HH:mm |
| 커밋 수 | N건 |
| 테스트 | N/N 통과 |

---

## HH:mm 작업명

### 뭘 했나
- 구체적 변경 내용

### 왜 했나
- 이 작업을 하게 된 배경과 이유

### 배운 것
- 이 작업을 통해 이해하게 된 기술 개념

### 기술 용어 정리
- `용어`: 비개발자 눈높이의 설명

### 커밋
- `해시` feat: 설명

---

## 💡 오늘의 핵심 인사이트
> 한 줄로 정리한 오늘의 교훈

## ❓ 나중에 더 공부할 것
- [ ] 추후 학습할 주제
```

---

## 제품 정체성

- 한 줄 정의: Claude Code로 코딩할 때, AI가 기존 기능을 망가뜨리면 자동 감지 → Fix 제공 → CLAUDE.md 보호 규칙 추가
- 타겟: 사이드프로젝트/1인 SaaS 바이브코더 (비개발자, Claude Code 사용자)
- 핵심 루프: 감지 → Fix → 보호. 한 번 당한 문제는 두 번 없다.
- MVP 범위: Claude Code 전용. Cursor/Aider는 Phase 2.

---

## 기술 스택

- **프레임워크**: Next.js 16 (App Router)
- **언어**: TypeScript (strict mode)
- **스타일링**: Tailwind CSS v4
- **UI 라이브러리**: React 19, Lucide React (아이콘)
- **DB**: Supabase (PostgreSQL)
- **AI 분석**: Claude API
- **배포**: Vercel
- **테스트**: Vitest + Playwright
- **컴포넌트 문서화**: Storybook 10
- **폰트**: Pretendard (한글), JetBrains Mono (코드/터미널)

---

## 디렉토리 구조

```
app/                          # Next.js App Router 페이지
  (home)/                     # 홈 레이아웃 그룹 (좌측 홈 사이드바)
    projects/page.tsx         # 프로젝트 목록 (카드 그리드)
    settings/                 # 내 설정
      account/page.tsx        # 계정 정보
      credits/page.tsx        # 크레딧 상세
      api-key/page.tsx        # API 키 관리
  onboarding/page.tsx         # 온보딩 3단계
  projects/[id]/              # 프로젝트 레이아웃 (프로젝트 사이드바)
    page.tsx                  # 프로젝트 리다이렉트
    status/page.tsx           # [현황] 탭
    issues/page.tsx           # [이슈] 탭
    claude-md/page.tsx        # [CLAUDE.md] 탭
    sessions/page.tsx         # [세션] 탭
    specs/page.tsx            # 기획서 탭
    settings/page.tsx         # 프로젝트 설정
  api/                        # API 라우트
  auth/                       # 인증 (login/logout/callback)

src/
  components/
    ui/                       # 기본 UI 컴포넌트 (Badge, Button, Card, ...)
    composite/                # 조합 컴포넌트 (AlertBanner, EmptyState, SettingsCardGrid)
    layout/                   # 레이아웃 컴포넌트 (Sidebar, GlobalHeader, MasterDetailLayout)
    features/                 # 기능별 컴포넌트 (home/, issues/, status/, ...)
  lib/                        # 유틸리티, mock 데이터
  styles/
    globals.css               # 디자인 토큰 (@theme)

agent/                        # 로컬 에이전트 (Node 데몬)
  index.js                    # 엔트리: config 로드 + SIGTERM graceful shutdown
  watcher.js                  # chokidar로 ~/.claude/projects/*.jsonl 감시 + idle 감지
  collector.js                # JSONL 파싱 + git diff 수집
  sender.js                   # POST /api/agent/push (지수 백오프 재시도)
  state.js                    # ~/.codesasu/state.json 영속 (중복 push 방지)
  package.json

setup-codesasu.sh              # 에이전트 설치 스크립트 (launchd/systemd 등록)

stories/                      # Storybook 설정
docs/                         # PRD, 기능명세서
```

---

## 컴포넌트 계층

```
ui/         → 최소 단위. 독립적. props만으로 동작. 비즈니스 로직 없음.
composite/  → ui 컴포넌트 2개 이상 조합. 약간의 상태 허용.
layout/     → 페이지 골격. Sidebar, GlobalHeader, MasterDetailLayout.
features/   → 탭/페이지 전용. 비즈니스 로직 포함. app/ 라우트와 1:1 대응.
```

- 새 컴포넌트는 반드시 같은 경로에 `*.stories.tsx` 파일 함께 생성
- 공통 컴포넌트는 각 디렉토리의 `index.ts`에서 export

---

## 디자인 시스템

### 컬러 (Warm Gray / Stone 계열)

| 토큰 | 값 | 용도 |
|---|---|---|
| --color-primary | #E67D22 | 주 액센트 (Claude Orange) |
| --color-primary-hover | #C2410C | 버튼 hover |
| --color-primary-active | #9A3412 | 버튼 active |
| --color-foreground | #1C1917 | 기본 텍스트 |
| --color-muted | #F5F5F4 | 좌측 리스트 배경, 배지 배경 |
| --color-muted-foreground | #78716C | 부제, 보조 텍스트 |
| --color-border | #E7E5E4 | 구분선, 테두리 |
| --color-destructive | #DC2626 | 삭제, Critical |
| --color-warning-orange | #F97316 | Warning 이슈 |
| --color-info-blue | #3B82F6 | Info 이슈 |

### 상태 컬러

| 상태 | 컬러 | 배지 배경 |
|---|---|---|
| 구현 완료 | #16A34A (초록) | #F0FDF4 |
| 부분 구현 | #C2410C (주황) | #FFF7ED |
| 미구현 | #A8A29E (회색) | #F5F5F4 |
| 확인 필요 | #DC2626 (빨강) | #FEE2E2 |

### 배경색 4단계 명도 위계

1. 글로벌 헤더: #F5F5F4 + 하단 #E7E5E4 border
2. 좌측 사이드바: #FFFFFF
3. 좌측 리스트 (Master): #F5F5F4
4. 우측 패널 (Detail): #FAFAF9
5. 카드: #FFFFFF + shadow-card

### 타이포그래피

- 본문: Pretendard
- 코드/터미널: JetBrains Mono
- 기준 해상도: 1440 x 900

### 버튼 체계

| 종류 | 기본 | hover | active |
|---|---|---|---|
| Primary | #E67D22 배경, 흰색 | #C2410C | #9A3412 |
| Outline | border #E7E5E4, #1C1917 텍스트 | 배경 #F5F5F4 | 배경 #E7E5E4 |
| Ghost | 투명, #78716C 텍스트 | 배경 #F5F5F4 | 배경 #E7E5E4 |
| 확인 완료 | #44403C 배경, 흰색 | #292524 | #1C1917 |
| Destructive | #DC2626 배경, 흰색 | #B91C1C | #991B1B |
| Destructive Ghost | border #FCA5A5, #DC2626 텍스트 | 배경 #FEF2F2 | 배경 #FEE2E2 |

### 인터랙션

- 토스트: fade-in 300ms, 3초 후 fade-out 300ms, 하단 중앙
- 모달: 오버레이 fade-in 200ms + scale 0.95→1.0 200ms
- 드롭다운: fade-in + translateY(-4px→0) 150ms
- 카드 hover: shadow 강화 (shadow-card → shadow-card-hover)
- 텍스트 링크(#E67D22): hover 시 밑줄
- 초록색 사용 제한: 온보딩/스테퍼에서 미사용. 체크 아이콘은 #1C1917

---

## 레이아웃 규칙

- 전체: Manyfast 스타일 좌측 사이드바(220px) + 우측 메인 콘텐츠
- 프로젝트 내부: Master-Detail (좌측 리스트 + 우측 상세 패널)
- 빈 상태: Master-Detail 유지 (좌측 빈 섹션 + 우측 안내 메시지). CTA 버튼 최대 240px.
- 사이드바 메뉴 순서: 현황 / 이슈 / CLAUDE.md / 세션 / 기획서 / 설정 / 내 설정
- 글로벌 헤더 높이: 56px
- 선택 항목: #FFFFFF 배경 + 좌측 컬러 3px 세로선

---

## 탭별 핵심 구조

### [이슈] 탭
- 플랫 리스트: 미확인(심각도순) → 해결됨(초록 뱃지, 접히지 않음) → 확인 완료(접힌 그룹)
- 이슈 상태: unconfirmed / auto_resolved / confirmed
- 상세 패널: 원인(FactCard) → 상세(접기/펼치기) → 해결 명령어(다크 FixBox) → 판단 기준+관련 파일(2분할)
- 하단 sticky 바: "× 무시" + "확인 완료"
- "확인 완료" 시 CLAUDE.md 규칙 자동 생성 + 토스트 알림 (모달 아님)
- 이슈 레벨: Critical(#DC2626) / Warning(#F97316) / Info(#3B82F6)
- 뱃지에 stroke 일괄 적용

### [현황] 탭
- 기획서 대비 구현 현황 (프로그레스 바 + 퍼센트)
- 기능별 상태: 구현완료/부분구현/미구현/확인필요
- 메트릭 카드 3열 + 구현 항목 리스트 + 기획서 참고 + 기술 상세
- ⓘ 툴팁: hover 시 표시, #1C1917 다크 배경, 흰색 텍스트

### [CLAUDE.md] 탭
- 단일 페이지, 카테고리별(보안/안정성/품질) 규칙 카드
- 카드 접기/펼치기 — 접힌 상태 기본, 1개만 펼침
- 개별 "추가" 버튼 + 제목 줄에 "전체 추가" (Outline)
- 헤더에 "CLAUDE.md 미리보기" 버튼 1개만
- 코드 스니펫 다크 배경 (#1C1917)
- 복사 시 마크다운 형태: ## CodeSasu 보호 규칙 → ### 보안/안정성/품질

### [세션] 탭
- 좌측 세션 리스트 + 우측 상세 패널
- 4카드 통계: 프롬프트 / 변경 파일 / 감지 이슈 / 지속 시간
- 감지 이슈 숫자: 0이면 초록, Critical 있으면 빨강
- 요약 첫 문장 Semibold + CLAUDE.md 연결 링크
- 세션 로그 탭 제거 → MD 내보내기로 대체 (Phase 2에 로그 뷰어)

### 기획서 탭
- 좌측 첨부 문서 리스트 + 우측 통합 기능 목록 (출처 FRD/PRD pill)

---

## 비즈니스 규칙

- 크레딧: 무료 30크레딧 제공 → 소진 시 BYOK(본인 API 키) 연동. MVP에서 결제 미포함.
- 분석 실행 전 "예상 소요 크레딧: 약 N 크레딧" 사전 안내
- 인증: Google OAuth (최소 스코프: email, profile)
- API 키: Supabase pgcrypto AES-256 서버 사이드 암호화
- 데이터 전송: JSONL 로그 + 파일 구조 + diff. 코드 원본은 Ephemeral Processing (분석 후 즉시 파기)
- API 키 미연결 상태: #F97316 주황 ("대기" — 빨강 아님)

---

## 의도적 미포함 (Non-Goals)

- Cursor/Aider 지원 (Phase 2)
- 코드 직접 수정 (Fix 가이드만 제공)
- 실시간 디버깅 (세션 종료 후 분석)
- CLAUDE.md 자동 주입 (MVP는 텍스트 복사 방식)
- 플랜 및 결제 (Phase 2)
- 휴지통 (정책 확정 후)
- 파일 전체 내용 서버 전송 (프라이버시 — Opt-in 시에만, Phase 2)
- 세션 로그 뷰어 (Phase 2 — MVP는 MD 내보내기)
- 개선 제안 Tip 카테고리 (Phase 2)
- 성능 분석 (Phase 2)

---

## 프론트엔드 개발 계획서

### 1. 라우팅 구조

```
/                           → 리다이렉트 → /projects
/onboarding                 → 온보딩 Step 1~3
/projects                   → 프로젝트 메인 홈 (카드 그리드)
/projects/[id]/status       → [현황] 탭
/projects/[id]/issues       → [이슈] 탭
/projects/[id]/claude-md    → CLAUDE.md 탭
/projects/[id]/sessions     → [세션] 탭
/projects/[id]/specs        → 기획서 탭
/projects/[id]/settings     → 프로젝트 설정
/settings                   → 내 설정 메인
/settings/account           → 계정 정보 상세
/settings/credits           → 크레딧 상세
/settings/api-key           → API 키 상세
/404                        → 404 에러
/500                        → 500 에러
```

**레이아웃 중첩 구조:**

```
RootLayout (app/layout.tsx)
├── /onboarding              → 단독 레이아웃 (사이드바 없음, Stepper만)
├── /projects                → 메인 홈 레이아웃 (좌측 홈 사이드바)
├── /projects/[id]/*         → 프로젝트 레이아웃 (좌측 프로젝트 사이드바 + GlobalHeader)
├── /settings/*              → 메인 홈 레이아웃 (좌측 홈 사이드바)
└── /404, /500               → 단독 레이아웃
```

### 2. 구현 순서 (의존성 기준)

| Phase | 페이지 | 이유 |
|-------|--------|------|
| Phase 0 | 공통 레이아웃 + 라우팅 뼈대 | 모든 페이지의 기반. Sidebar, GlobalHeader 조합. |
| Phase 1 | 프로젝트 메인 홈 (/projects) | 진입점. 프로젝트 선택 후 다른 탭으로 이동하는 허브. |
| Phase 2 | [이슈] 탭 (/projects/[id]/issues) | 핵심 와우포인트. Fact→Detail→Fix 상세 패널이 제품 가치의 중심. |
| Phase 3 | CLAUDE.md 탭 (/projects/[id]/claude-md) | 이슈에서 "확인 완료" 후 보호 규칙이 여기로 연결됨. 이슈 탭과 1세트. |
| Phase 4 | [현황] 탭 (/projects/[id]/status) | PRD 감리. 기획서 탭과 연동되나 독립 표시 가능. |
| Phase 5 | [세션] 탭 (/projects/[id]/sessions) | 세션 로그 뷰어. 비교적 단순한 Master-Detail. |
| Phase 6 | 기획서 탭 (/projects/[id]/specs) | 문서 업로드 + 통합 기능 목록. 현황 탭과 데이터 연동. |
| Phase 7 | 프로젝트 설정 + 내 설정 | SettingsCardGrid 재사용. 모달 3~4개. |
| Phase 8 | 온보딩 (/onboarding) | Step 1~3. 독립 플로우. 다른 페이지 완성 후가 자연스러움. |
| Phase 9 | 공통 시스템 (404/500/스켈레톤/세션 만료) | 마무리 단계. |

### 3. 각 페이지별 상세

#### Phase 0: 공통 레이아웃 (0.5일) ✅ 완료

- 사용 컴포넌트: Sidebar, GlobalHeader
- 신규: HomeSidebar, ProjectLayout

#### Phase 1: 프로젝트 메인 홈 (1일) ✅ 완료

- 사용 컴포넌트: Card, StatusDot, Dropdown, Badge, EmptyState, Button
- 신규: ProjectCard (Card 확장)
- mock: `Project { id, name, agentStatus, lastAnalysis, issueCount, implementationRate }`

#### Phase 2: [이슈] 탭 (2~2.5일) ✅ 완료

- 6개 뷰 + 모달 1개
- 사용 컴포넌트: MasterDetailLayout, SectionHeader, ListItem, Badge, FactCard, FixBox, TechDetailCard, Button, Modal, CodeBlock, EmptyState
- 신규: IssueDetailPanel, IssueListSection
- mock: `Issue { id, title, level, status, fact, detail, fixCommand, file, basis, detectedAt, isRedetected }`

#### Phase 3: CLAUDE.md 탭 (1일) ✅ 완료

- 3개 뷰 + 모달 2개
- 사용 컴포넌트: MasterDetailLayout, SectionHeader, ListItem, CodeBlock, Button, Modal, EmptyState
- 신규: GuidelineDetailPanel, GuidelineListSection, FullPreviewModal
- mock: `Guideline { id, title, rule, status, sourceIssueId, detectedAt }`

#### Phase 4: [현황] 탭 (2일) ✅ 완료

- 7개 뷰 + 배너 2개 + 모달 2개
- 사용 컴포넌트: MasterDetailLayout, ListItem, StatusDot, Tooltip, MetricCard, Card, Badge, TextLink, AlertBanner, Modal, EmptyState
- 신규: FeatureDetailPanel, FeatureListItem
- mock: `Feature { id, name, status, implementedItems, totalItems, issueCount, lastSession, techStack, relatedFiles, prdSummary }`

#### Phase 5: [세션] 탭 (1일) ✅ 완료

- 3개 뷰 (요약 / 세션 로그 / 빈 상태)
- 사용 컴포넌트: MasterDetailLayout, Card, EmptyState
- 신규: SessionDetailPanel (요약/로그 탭 + claude-replay 스타일 다크 터미널 로그 뷰어)
- mock: `Session { id, number, title, date, filesChanged, toolUseCount, hasIssue?, summary, changedFiles, prompts, log: SessionLogEntry[] }` — `SessionLogEntry`는 user/assistant/tool 구분 + add/remove/info 라인 컬러링

#### Phase 6: 기획서 탭 (1일) ✅ 완료

- 2개 뷰 + 모달 1개 + 드롭다운(삭제만)
- 사용 컴포넌트: MasterDetailLayout, Dropdown, Modal, Button
- 신규: SpecDocList(FRD/PRD pill + ⋮ 삭제), SpecFeatureList(읽기 전용), SpecUploadModal(텍스트 붙여넣기)
- mock: `SpecDocument { id, name, uploadedAt, type }`, `SpecFeature { id, name, sources: SpecDocType[], status }` — 한 기능이 여러 문서에 등장 가능
- MVP 정책: 기능 목록은 읽기 전용 (편집/추가 없음), 문서 교체는 삭제 후 재추가, 파일 업로드는 Phase 2 (현재 텍스트 붙여넣기만)

#### Phase 7: 내 설정 + 프로젝트 설정 (1.5일) ✅ 완료

- 범위: `/settings/*` (내 계정/크레딧/API키) + `/projects/[id]/settings` (프로젝트 설정)
- 사용 컴포넌트: SettingsCardGrid, StatusDot, Modal, InputField, Button, CodeBlock, ProgressBar, Card
- 신규: 없음

#### Phase 8: 온보딩 (1.5일) ✅ 완료

- 사용 컴포넌트: Stepper, CodeBlock, Button, StatusDot, Card, Badge, ProgressBar
- 신규: OnboardingLayout, FileUploadArea

#### Phase 9: 공통 시스템 (0.5일) ✅ 완료

- 사용 컴포넌트: Button, Modal
- 신규: Skeleton (pulse 애니메이션)

### 4. 폴더 구조

```
src/components/features/          ← 신규 페이지 전용 컴포넌트
  ├── issues/
  │   ├── IssueDetailPanel.tsx
  │   └── IssueListSection.tsx
  ├── claude-md/
  │   ├── GuidelineDetailPanel.tsx
  │   ├── GuidelineListSection.tsx
  │   └── FullPreviewModal.tsx
  ├── status/
  │   ├── FeatureDetailPanel.tsx
  │   └── FeatureListItem.tsx
  ├── sessions/
  │   └── SessionDetailPanel.tsx
  ├── specs/
  │   ├── SpecDocList.tsx
  │   ├── SpecFeatureList.tsx
  │   └── SpecUploadModal.tsx
  ├── home/
  │   └── ProjectCard.tsx
  └── onboarding/
      ├── OnboardingLayout.tsx
      └── FileUploadArea.tsx
```

### 5. 결정 사항 (확정)

| # | 항목 | 결정 |
|---|------|------|
| 1 | 상태 관리 | useState/Context (API 연동 시 Zustand 도입) |
| 2 | mock 데이터 | /lib/mock-data.ts 중앙 관리 |
| 3 | 온보딩 라우팅 | 단일 페이지 + 내부 step 상태 |
| 4 | 인증 | mock (MVP 프론트 완성 후 Auth) |
| 5 | 프로젝트 전환 | 별도 ProjectSwitcher 컴포넌트 |

### 6. 총 예상 작업량: 약 14일

| Phase | 작업량 | 상태 |
|-------|--------|------|
| Phase 0: 공통 레이아웃 | 0.5일 | ✅ 완료 |
| Phase 1: 프로젝트 홈 | 1일 | ✅ 완료 |
| Phase 2: 이슈 탭 | 2.5일 | ✅ 완료 |
| Phase 3: CLAUDE.md 탭 | 1일 | ✅ 완료 |
| Phase 4: 현황 탭 | 2일 | ✅ 완료 |
| Phase 5: 세션 탭 | 1일 | ✅ 완료 |
| Phase 6: 기획서 탭 | 1일 | ✅ 완료 |
| Phase 7: 내 설정 + 프로젝트 설정 | 1.5일 | ✅ 완료 |
| Phase 8: 온보딩 | 1.5일 | ✅ 완료 |
| Phase 9: 공통 시스템 | 0.5일 | ✅ 완료 |

### 7. 진행 현황

| Phase | 상태 | 완료일 | 주요 산출물 |
|-------|------|--------|------------|
| Phase 0 | ✅ 완료 | 2026-04-03 | RootLayout, Sidebar, GlobalHeader, MasterDetailLayout, 라우팅 뼈대 |
| Phase 1 | ✅ 완료 | 2026-04-10 | 프로젝트 카드 그리드(`features/home/ProjectCard`), 프로젝트 목록 페이지 |
| Phase 2 | ✅ 완료 | 2026-04-10 | 이슈 탭(미확인/확인/해결 3섹션), `IssueListSection`, `IssueDetailPanel`(Fact→Detail→Fix→기술근거), 보호 규칙 제안 모달 |
| Phase 3 | ✅ 완료 | 2026-04-10 | CLAUDE.md 탭(미적용/적용 2섹션), `GuidelineDetailPanel`, `GuidelineListSection`, `FullPreviewModal`(터미널 스타일) |
| Phase 4 | ✅ 완료 | 2026-04-10 | 현황 탭, `FeatureListItem`, `FeatureDetailPanel`(메트릭 카드 + 구현 항목 + PRD 참고 + 기술 상세) |
| Phase 5 | ✅ 완료 | 2026-04-10 | 세션 탭(평면 리스트), `SessionDetailPanel`(요약/세션 로그 탭), claude-replay 스타일 다크 터미널 로그 뷰어, EmptyState |
| Phase 6 | ✅ 완료 | 2026-04-10 | 기획서 탭, `SpecDocList`(FRD/PRD pill + ⋮ 삭제 메뉴), `SpecFeatureList`(읽기 전용 통합 기능 목록), `SpecUploadModal`(텍스트 붙여넣기 방식) |
| Phase 7 | ✅ 완료 | 2026-04-24 | 내 설정(`/settings/*`) + 프로젝트 설정, SettingsCardGrid 재사용 |
| Phase 8 | ✅ 완료 | 2026-04-24 | 온보딩 Step 1~3 (에이전트 연결 확인 포함), `OnboardingLayout`, `FileUploadArea` |
| Phase 9 | ✅ 완료 | 2026-04-24 | 404/500/스켈레톤/세션 만료 등 공통 시스템 페이지 |

---

## 백엔드 개발 계획서

### 개발 우선순위 (의존성 기준)

```
Tier 0 (스키마 + 인증 + API 구조)
  └─→ Tier 1 (프로젝트 CRUD)
        └─→ Tier 2 (에이전트 데이터 수신 + 세션 파싱)
              └─→ Tier 3 (분석 엔진 + 이슈/Fix/보호 규칙 생성)  ← 핵심
                    ├─→ Tier 4 (이슈/가이드라인 API)
                    └─→ Tier 5 (기획서 + 현황)
                          └─→ Tier 6 (크레딧 + 설정)
```

### Tier 0: 기반 인프라

| # | 기능 | 상세 |
|---|------|------|
| 0-1 | Supabase 스키마 설계 | 7개 테이블: users, projects, sessions, issues, guidelines, spec_documents, spec_features |
| 0-2 | Google OAuth 인증 | Supabase Auth, 세션 토큰(httpOnly cookie), JWT |
| 0-3 | API 라우트 구조 + 미들웨어 | app/api/ 구조, 인증 미들웨어, 에러 핸들링 공통 |

### Tier 1: 프로젝트 관리

| # | 기능 | 상세 |
|---|------|------|
| 1-1 | 프로젝트 CRUD | 생성/조회/수정/삭제, 프로젝트 목록 |
| 1-2 | 에이전트 연결 상태 관리 | 연결/미연결 상태, 마지막 통신 시간 |

### Tier 2: 데이터 수집 파이프라인

| # | 기능 | 상세 |
|---|------|------|
| 2-1 | 로컬 에이전트 데이터 수신 API | JSONL 로그, 파일 구조, diff 수신 (Smart Push) |
| 2-2 | 세션 파싱 및 저장 | JSONL → 세션 단위 분리, 요약 생성, 변경 파일 추출 |
| 2-3 | Ephemeral Processing | 코드 원본 수신 → 분석 → 즉시 파기. TTL + 삭제 cron |

### Tier 3: 분석 엔진 (핵심)

| # | 기능 | 상세 |
|---|------|------|
| 3-1 | 정적 분석 | API 키 노출, 인증 부재, 에러 처리 누락, 미호출 함수. OWASP Top 10 |
| 3-2 | 세션 간 비교 분석 | 이전 vs 현재 세션 diff → 삭제/변경 기능 감지 |
| 3-3 | 이슈 + Fix 생성 | 감지 결과 → Issue 레코드 (level, fact, detail, fixCommand) |
| 3-4 | CLAUDE.md 보호 규칙 생성 | 이슈 기반 보호 규칙 텍스트 자동 생성 |
| 3-5 | Claude API 연동 | 분석 프롬프트 설계, API 호출, 응답 파싱 |

### Tier 4: 이슈 관리 API

| # | 기능 | 상세 |
|---|------|------|
| 4-1 | 이슈 CRUD + 상태 전이 | 미확인→확인완료→해결됨, 재감지 시 미확인 복귀 |
| 4-2 | 이슈 목록 조회 | 프로젝트별, 상태별 필터링, 레벨별 카운트 |
| 4-3 | 가이드라인 CRUD | 미적용/적용완료 상태, 삭제 |
| 4-4 | 분석 실행 트리거 | 수동 분석 실행, 예상 크레딧 계산 |

### Tier 5: 현황 (PRD 감리)

| # | 기능 | 상세 |
|---|------|------|
| 5-1 | 기획서 업로드 + 기능 추출 | 문서 업로드 → Claude API로 기능 목록 자동 추출 |
| 5-2 | PRD vs 코드 대조 | 기획서 기능 vs 실제 코드 → 구현/부분/미구현/확인필요 판정 |
| 5-3 | Reverse IA | 기획서 없이 코드+CLI 로그에서 기능 자동 추출 |

### Tier 6: 크레딧 + 설정

| # | 기능 | 상세 |
|---|------|------|
| 6-1 | 크레딧 관리 | 잔여 조회, 분석 시 차감, 사용 내역 기록 |
| 6-2 | API 키 관리 | AES-256 암호화 저장/조회 (pgcrypto) |
| 6-3 | 계정 관리 | 프로필 수정, 계정 삭제 (cascade) |

### DB 스키마 (7개 테이블)

```
users         { id, name, email, avatar_url, login_method, credits, total_credits, role(user/admin) }
projects      { id, user_id, name, agent_status, agent_last_seen, agent_path }
sessions      { id, project_id, number, title, summary, raw_log, files_changed, changed_files, prompts }
issues        { id, project_id, session_id, title, level, status, fact, detail, fix_command, file, basis, is_redetected }
guidelines    { id, project_id, source_issue_id, title, rule, status }
spec_documents { id, project_id, name, type, file_url }
spec_features  { id, project_id, document_id, name, source, status, implemented_items, total_items, related_files, prd_summary }
```

### API 라우트 구조

```
app/api/
├── projects/
│   ├── route.ts                GET (목록), POST (생성)
│   └── [id]/
│       ├── route.ts            GET, PATCH, DELETE
│       ├── issues/route.ts
│       ├── sessions/route.ts
│       ├── guidelines/route.ts
│       ├── specs/
│       │   ├── documents/route.ts
│       │   └── features/route.ts
│       └── analyze/route.ts    POST (분석 실행)
├── agent/
│   └── push/route.ts           POST (에이전트 데이터 수신)
└── user/
    ├── route.ts                GET, PATCH
    ├── credits/route.ts
    └── api-key/route.ts
```

### 결정 사항 (확정)

| # | 항목 | 결정 |
|---|------|------|
| 1 | DB | Supabase (PostgreSQL) — 신규 프로젝트 생성 |
| 2 | 인증 | Supabase Auth + Google OAuth |
| 3 | 로컬 에이전트 | 백엔드 범위 포함 (setup-codesasu.sh) |
| 4 | 진행 순서 | Tier 0부터 순서대로 |

### 진행 현황

| Tier | 상태 | 완료일 | 주요 산출물 |
|------|------|--------|------------|
| Tier 0 | ✅ 완료 | 2026-04-03 | 7개 테이블 스키마(001_initial.sql), Supabase Auth(client/server/middleware), Google OAuth 로그인/콜백, DB 타입(types.ts) |
| Tier 1 | ✅ 완료 | 2026-04-03 | 프로젝트 CRUD API(GET/POST/PATCH/DELETE), 로그아웃(POST /auth/logout) |
| Tier 2 | ✅ 완료 | 2026-04-09 | 에이전트 데이터 수신 API(`/api/agent/push`), JSONL 세션 파싱, diff 파일 경로 → `sessions.changed_files` 병합, Ephemeral Processing |
| Tier 3 | ✅ 완료 | 2026-04-10 | 정적 분석 + 세션 간 비교, 이슈/Fix/보호 규칙 생성, Claude API 연동, 분석 엔진 고도화(테스트 1~3), maxTokens 버그 수정 |
| Tier 4 | ✅ 완료 | 2026-04-09 | 이슈/가이드라인 CRUD API, 상태 전이(미확인↔확인↔해결), 분석 실행 트리거, 예상 크레딧 추정 |
| Tier 5 | ✅ 완료 | 2026-04-09 | 기획서 업로드/기능 추출, PRD vs 코드 대조(현황 감리), Reverse IA |
| Tier 6 | ✅ 완료 | 2026-04-10 | 크레딧 관리(잔여/차감/내역), API 키 AES-256 암호화(pgcrypto), 계정 관리(프로필/삭제 cascade) |

---

## 로컬 에이전트

Claude Code 세션 JSONL을 감시해 `/api/agent/push`로 자동 전송하는 Node 데몬.

### 구성
- `agent/index.js` — 엔트리, `~/.codesasu/config.env` 로드, SIGTERM/SIGINT graceful shutdown
- `agent/watcher.js` — chokidar로 `~/.claude/projects/**/*.jsonl` 감시, 파일당 idle 타이머(기본 60s) + in-flight 가드
- `agent/collector.js` — JSONL에서 sessionId/cwd 추출, `git diff HEAD` 수집, 파일당 10KB / 전체 9MB 예산
- `agent/sender.js` — POST `/api/agent/push`, 5xx 지수 백오프 3회(1s/3s/9s), 409 중복은 성공 처리
- `agent/state.js` — `~/.codesasu/state.json`에 pushed_session_ids 보관 (상한 1000)
- `setup-codesasu.sh` — `~/.codesasu/agent/` 설치 + macOS launchd / Linux systemd --user 등록

### 환경변수 (`~/.codesasu/config.env`, 권한 600)
- `CODESASU_PROJECT_ID` (필수)
- `CODESASU_AGENT_TOKEN` (필수)
- `CODESASU_API_URL` (기본 `http://localhost:3000`)
- `CODESASU_IDLE_TIMEOUT_MS` (기본 60000)
- `CODESASU_CLAUDE_DIR` (기본 `~/.claude/projects`)

### 설치

```
./setup-codesasu.sh --project-id <uuid> --token <agent-token> [--api-url <url>]
```

### 진행 현황

| 구성 | 상태 | 완료일 | 비고 |
|------|------|--------|------|
| 에이전트 데몬 + 설치 스크립트 | ✅ 완료 | 2026-04-24 | chokidar 기반 idle 감지, launchd/systemd 등록, JSONL 전송·git diff 수집 |
