-- spec_features에 문서 간 중복 기능 마킹용 is_duplicate 컬럼 추가
--
-- prd_v1.md, prd_v3.md 같이 버전별 기획서가 docs/에 함께 있으면 같은 기능이
-- 여러 번 추출되어 구현 현황이 엉킴. extract 완료 후 후처리(dedupeFeaturesForProject)에서
-- 키워드 50% 매칭으로 중복 감지 → 가장 최근 문서의 기능만 active로 두고 나머지는
-- is_duplicate=true로 마킹 (soft hide; 물리 삭제하지 않아 복구 가능).
--
-- assess와 GET features API는 is_duplicate=false만 기본 반환.

ALTER TABLE public.spec_features
  ADD COLUMN is_duplicate boolean NOT NULL DEFAULT false;

CREATE INDEX idx_spec_features_active
  ON public.spec_features (project_id, is_duplicate);
