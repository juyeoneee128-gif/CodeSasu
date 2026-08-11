-- 018_expected_items.sql
-- spec_features에 expected_items 컬럼 추가.
-- "이 기능이 갖춰야 할 세부 항목 전체 목록 (해야 할 일)"을 LLM이 extract 단계에서 채움.
-- implemented_items는 expected_items 중 실제 소스코드에서 확인된 부분집합.
-- 기존 row는 DEFAULT '[]'로 초기화 — 부팅 스캔에서 자동 backfill (route.ts).

ALTER TABLE spec_features
  ADD COLUMN expected_items jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN spec_features.expected_items IS
  '기획서가 요구하는 세부 항목 전체 목록. implemented_items는 이 중 실제 코드에서 확인된 부분집합.';
