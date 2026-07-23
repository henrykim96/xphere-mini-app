-- ============================================================
--  DB 잠그기 (보안 강화) — 2026-07-23
-- ------------------------------------------------------------
--  ★ 이 파일을 Supabase → SQL Editor 에 붙여넣고 Run 하세요. (딱 1번만)
--
--  [무엇을 하나요?]
--  지금까지는 학습용으로 "누구나 DB를 직접 읽고/쓰기 가능"하게 열어뒀는데,
--  이러면 개발자도구를 아는 사람이 자기 포인트를 마음대로 바꿀 수 있어요.
--  이 SQL은 그 옆문을 닫습니다. 닫아도 앱은 정상 작동해요 —
--  앱이 이제 전부 '서버(dynamic-handler)'를 통해서만 읽고 쓰거든요.
--  (서버는 관리자 열쇠(service role)를 쓰기 때문에 잠금의 영향을 안 받음)
-- ============================================================

-- 1) app_users: 직접 읽기/등록/수정 전부 차단 (서버만 가능)
drop policy "anyone can read"   on app_users;
drop policy "anyone can insert" on app_users;
drop policy "anyone can update" on app_users;

-- 2) completions: 직접 읽기/등록 차단 (서버만 가능)
drop policy "anyone can read"   on completions;
drop policy "anyone can insert" on completions;

-- 3) missions: "anyone can read"는 그대로 둠 (미션 목록은 공개 정보라 OK)
--    → 아무것도 안 해도 됨
