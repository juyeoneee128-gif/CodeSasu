-- file_signatures: 프로젝트 파일별 코드 시그니처를 누적 저장
--
-- assessFeatures가 파일명+세션 요약만 보고 추정하던 방식(정확도 ~60%)을
-- 파일별 함수/import/export/패턴/줄 수 시그니처를 보고 판단하는 방식(~80%)으로 개선.
--
-- 두 경로에서 데이터가 들어옴:
-- 1. 정적 분석 (LLM, full 모드만) — diff에 포함된 파일 시그니처 추출
-- 2. 세션 로그 tool_result (정규식, 무료) — Read tool로 본 파일 시그니처 추출
--
-- 두 경로 모두 합집합 머지 (set union). 삭제된 함수는 stale로 잔존하지만
-- last_seen_at 기반 cutoff cron으로 정리(별도 작업).

create table public.file_signatures (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  file_path text not null,
  functions text[] not null default '{}',
  imports text[] not null default '{}',
  exports text[] not null default '{}',
  patterns text[] not null default '{}',
  line_count integer not null default 0,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, file_path)
);

-- last_seen_at 기반 stale 정리 cron용 인덱스
create index idx_file_signatures_last_seen
  on public.file_signatures(project_id, last_seen_at);

alter table public.file_signatures enable row level security;

create policy "Users can access own project file_signatures" on public.file_signatures
  for all using (
    project_id in (select id from public.projects where user_id = auth.uid())
  );

-- updated_at 자동 갱신 (001에서 정의된 handle_updated_at 재사용)
create trigger set_updated_at before update on public.file_signatures
  for each row execute function public.handle_updated_at();
