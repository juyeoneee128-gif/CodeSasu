-- 전체 스캔(full_scan) 지원:
--   1. ephemeral_data.data_type CHECK에 'source_file' 추가 (008과 동일 패턴)
--   2. projects 테이블에 first_scan_done / pending_full_scan 컬럼 추가
--      - first_scan_done: 최초 연결 시 한 번만 전체 스캔 트리거
--      - pending_full_scan: 수동 재분석 시 에이전트가 polling으로 픽업
-- 기존 row 호환: DEFAULT FALSE로 자동 채워짐. RLS 정책 불변.

ALTER TABLE public.ephemeral_data
  DROP CONSTRAINT IF EXISTS ephemeral_data_data_type_check;

ALTER TABLE public.ephemeral_data
  ADD CONSTRAINT ephemeral_data_data_type_check
  CHECK (data_type IN ('file_tree', 'diff', 'eslint', 'source_file'));

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS first_scan_done BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pending_full_scan BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pending_full_scan_at TIMESTAMPTZ;

-- 에이전트 polling에서 token 기반 단일 row 조회만 발생하므로 별도 인덱스 불필요
