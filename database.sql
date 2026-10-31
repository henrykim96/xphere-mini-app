-- ============================================================
--  Xphere 에어드랍 미니앱 — 데이터베이스 전체 구조 (Supabase / PostgreSQL)
-- ------------------------------------------------------------
--  이 파일은 "지금까지 만든 DB의 설계도"입니다.
--  이미 Supabase에 다 실행해둔 것이라, 다시 돌릴 필요는 없어요.
--  나중에 "이 테이블/칸이 뭐였지?" 할 때 참고용으로 보면 됩니다.
--
--  [테이블 3개]
--    app_users   : 유저별 점수 / 연속출석 / 마지막출석일
--    missions    : 미션 목록 (Supabase에서 직접 추가·수정)
--    completions : 누가·어떤미션·언제 완료했는지 (중복방지 + 리셋 판단)
--
--  ※ SQL 주석은 -- 로 시작합니다 (그 줄 끝까지는 설명, 실행 안 됨)
-- ============================================================


-- ============================================================
--  1) app_users — 유저 정보
-- ============================================================
create table app_users (
  telegram_id  bigint primary key,          -- 텔레그램 유저 고유번호 (한 사람당 하나, 중복 불가)
  name         text,                         -- 유저 이름 (표시용)
  points       integer default 0,            -- 모은 포인트 총합
  created_at   timestamptz default now(),    -- 처음 등록된 시각 (자동 기록)
  last_checkin date,                          -- 마지막으로 출석체크한 날짜 (출석 중복 방지용)
  streak       integer default 0             -- 연속 출석 일수
);

-- RLS(Row Level Security) 켜기 = "이 표에 누가 접근 가능한지 규칙으로 통제"
alter table app_users enable row level security;

-- 정책: 없음! = 클라이언트(anon)는 직접 접근 불가, 서버(service role)만 가능
--  ※ 처음엔 학습용으로 read/insert/update 열어뒀다가 2026-07-23 잠금 (database-lockdown.sql 참고)
--  ※ 앱은 dynamic-handler의 load_user/register 등을 통해서만 읽고 씀


-- ============================================================
--  2) completions — 미션 완료 기록
--     "누가 · 어떤 미션을 · 어느 날짜에 완료했나"
--     이 표 덕분에 하루 1회 제한 / 영구 1회 제한이 가능함
-- ============================================================
create table completions (
  telegram_id bigint,                         -- 완료한 유저
  mission_id  integer,                        -- 완료한 미션 (missions.id 와 연결)
  day         date,                           -- 완료 '날짜'.
                                              --   daily 미션  = 그날 서울날짜 (날짜 바뀌면 다시 가능 = 매일 리셋)
                                              --   general 미션 = 고정 '2000-01-01' (안 바뀌니 영원히 1번만)
  created_at  timestamptz default now(),      -- 완료한 시각 (자동 기록)

  -- 핵심! (유저 + 미션 + 날짜) 조합은 딱 하나만 허용 → 같은 걸 두 번 완료 못 함
  primary key (telegram_id, mission_id, day)
);

alter table completions enable row level security;

-- 정책: 없음! = 클라이언트 직접 접근 불가, 서버만 가능 (2026-07-23 잠금)


-- ============================================================
--  3) missions — 미션 목록
--     henry가 Supabase Table Editor 에서 직접 관리 (코드 수정 없이)
-- ============================================================
create table missions (
  id         serial primary key,             -- 미션 번호 (자동으로 1,2,3... 증가)
  title      text    not null,               -- 미션 제목 (화면에 보임)
  points     integer not null default 3,     -- 완료 시 주는 포인트
  link       text,                           -- 미션 링크 (트위터/텔레그램 등). Verify 누르면 열림. 비어도 됨
  category   text    not null default 'daily', -- 'daily'(매일 리셋) 또는 'general'(영구 1회)
  active     boolean not null default true,  -- true=보임 / false=숨김 (삭제 안 하고 끄기)
  sort_order integer default 0               -- 화면에 보이는 순서 (숫자 작을수록 위)
);

alter table missions enable row level security;

-- 정책: 누구나 '읽기'만 가능
--  → 일반 유저는 미션을 못 바꾸고, henry만 대시보드에서 추가/수정 (안전)
create policy "anyone can read" on missions for select using (true);

-- 초기 미션 데이터 (daily 3개 + general 5개) --------------------
-- daily : 매일 리셋되는 미션
insert into missions (title, points, link, category, sort_order) values
  ('Comment on Xphere Post', 3, null, 'daily', 1),
  ('Like on Xphere Post',    3, null, 'daily', 2),
  ('Retweet on Xphere Post', 3, null, 'daily', 3);

-- general : 한 번만 하면 되는 미션
insert into missions (title, points, link, category, sort_order) values
  ('Join Xphere Telegram',   5, null, 'general', 1),
  ('Follow Xphere on X',     5, null, 'general', 2),
  ('Join Xphere Discord',    5, null, 'general', 3),
  ('Visit Xphere Website',   3, null, 'general', 4),
  ('Connect Your Wallet',   10, null, 'general', 5);


-- ============================================================
--  자주 쓰는 관리용 SQL (참고) — 필요할 때 골라서 실행
-- ============================================================

-- ▶ 미션 추가 (예: 새 이벤트 미션)
-- insert into missions (title, points, link, category, sort_order)
--   values ('New Event Mission', 5, 'https://x.com/...', 'daily', 10);

-- ▶ 미션 숨기기 / 다시 보이기 (id는 실제 번호로)
-- update missions set active = false where id = 4;   -- 숨김
-- update missions set active = true  where id = 4;   -- 다시 보임

-- ▶ 미션 제목/점수/링크 수정
-- update missions set title = '새 제목', points = 5, link = 'https://...' where id = 4;

-- ▶ 미션 순서 바꾸기 (숫자 작을수록 위)
-- update missions set sort_order = 0 where id = 3;

-- ▶ 특정 유저의 오늘 완료기록 지우기 (테스트로 미션 다시 열기)
-- delete from completions where telegram_id = 7716704251 and day = '2026-07-14';

-- ▶ 테스트 유저 삭제 (id=999999 같은 것)
-- delete from app_users where telegram_id = 999999;

-- ▶ 유저 순위 보기 (포인트 높은 순) — 나중에 에어드랍 대상 뽑을 때
-- select telegram_id, name, points from app_users order by points desc;


-- ============================================================
--  2026-10-29 추가 — 지갑·X 핸들 '1인 1계정' (중복 방지)
-- ------------------------------------------------------------
--  Supabase → SQL Editor 에서 1)→2)→3) 순서로 실행 (딱 1번)
--  서버(dynamic-handler)도 저장 전에 중복을 확인하지만, 이 인덱스는
--  '동시에 같은 값을 저장'하는 경우까지 DB가 마지막으로 막아줌.
-- ============================================================

-- 1) 기존 값 정리: X 핸들은 앞의 @ 제거 + 소문자 + 빈 값은 NULL, 지갑은 공백 제거 + 빈 값은 NULL
update app_users set x_handle = nullif(lower(regexp_replace(trim(x_handle), '^@+', '')), '') where x_handle is not null;
update app_users set wallet   = nullif(trim(wallet), '') where wallet is not null;

-- 2) 중복 확인 — 아래 두 개가 '결과 없음(0행)'이어야 3)이 성공함. 행이 나오면 그 계정들 값을 먼저 정리
select lower(wallet) as wallet, count(*) from app_users where wallet is not null group by 1 having count(*) > 1;
select x_handle, count(*) from app_users where x_handle is not null group by 1 having count(*) > 1;

-- 3) 중복 방지 인덱스 (이름은 서버 코드가 오류를 알아보는 데 쓰므로 바꾸지 말 것)
create unique index if not exists app_users_wallet_uniq  on app_users (lower(wallet)) where wallet is not null;
create unique index if not exists app_users_xhandle_uniq on app_users (x_handle)      where x_handle is not null;


-- ============================================================
--  2026-10-29 추가 — X 리포스트 검증(X API)용 열
-- ------------------------------------------------------------
--  ★ 서버(dynamic-handler)를 배포하기 '전에' 먼저 실행 (관리자 화면도 이 열을 읽음)
--  x_user_id        : X 계정 번호 (핸들은 바꿀 수 있어도 번호는 그대로 → 1인 1계정 판단)
--  x_repost_status  : 'verified'(리포스트 확인됨) / 'skipped'(API 장애로 통과, 지급 전 점검 대상) / NULL(미확인)
--  x_check_count/day: 하루 시도 횟수 제한(비용 상한)
-- ============================================================
alter table app_users add column if not exists x_user_id text;
alter table app_users add column if not exists x_repost_status text;
alter table app_users add column if not exists x_check_count integer default 0;
alter table app_users add column if not exists x_check_day date;
create unique index if not exists app_users_xuserid_uniq on app_users (x_user_id) where x_user_id is not null;


-- ============================================================
--  X 연동(OAuth 로그인)용  (2026-10-29)
--  ★ SQL Editor 에서 '서버 코드 배포 전에' 실행. 여러 번 실행해도 안전.
-- ============================================================
alter table app_users add column if not exists x_connected boolean default false;  -- X 로그인으로 연동된 계정인지

-- 연동 진행 중인 1회용 기록 (state = 시도 식별자, verifier = PKCE 검증값). 서버만 접근.
create table if not exists x_oauth (
  state       text primary key,
  telegram_id bigint not null,
  verifier    text not null,
  created_at  timestamptz default now()
);
alter table x_oauth enable row level security;   -- 정책 없음 = 클라이언트 접근 불가, 서버(service role)만 가능


-- ============================================================
--  포인트 내역(History 탭)용  (2026-10-31)
--  ★ SQL Editor 에서 '서버 코드 배포 전에' 실행. 여러 번 실행해도 안전.
--  포인트가 들어올 때마다 서버가 한 줄씩 기록 (kind: mission / checkin / referral)
-- ============================================================
create table if not exists point_log (
  id          bigint generated always as identity primary key,
  telegram_id bigint not null,
  kind        text   not null,
  points      integer not null,
  note        text,
  created_at  timestamptz default now()
);
create index if not exists point_log_user_idx on point_log (telegram_id, created_at desc);
alter table point_log enable row level security;  -- 정책 없음 = 클라이언트 접근 불가, 서버(service role)만 가능
