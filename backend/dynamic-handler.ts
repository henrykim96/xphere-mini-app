// ============================================================
//  dynamic-handler — 미션·초대·출석·등록 + initData 보안검증
// ------------------------------------------------------------
//  모든 '쓰기'는 이 함수를 거침. body.action / mission_id / referrer_id 로 분기.
//  ★ initData 검증으로 '진짜 유저'만 처리. (개발용 우회: 런칭 전 제거)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REFERRAL_ENABLED = false; // ★ 초대(레퍼럴) 기능 스위치. 다시 켜려면 true (index.html의 REFERRAL_ENABLED도 같이)
const REFERRAL_POINTS = 10;
const CHECKIN_POINTS = 2;
// ★ 데일리 리셋 기준 = UTC 자정 (2026-10-23 서울→UTC로 변경)
function utcToday() { return new Date().toISOString().slice(0, 10); }
function utcYesterday() {
  const d = new Date(utcToday() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}
async function verifyInitData(initData) {
  const token = Deno.env.get("BOT_TOKEN");
  if (!token || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(k + "=" + v);
  pairs.sort();
  const secretKey = await hmac(new TextEncoder().encode("WebAppData"), token);
  const computed = await hmac(secretKey, pairs.join("\n"));
  const computedHex = [...computed].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (computedHex !== hash) return null;
  try { return JSON.parse(params.get("user")); } catch (e) { return null; }
}
async function resolveUserId(body) {
  if (body.initData) {
    const u = await verifyInitData(body.initData);
    if (!u || !u.id) return { error: "unauthorized" };
    return { id: Number(u.id), name: u.first_name || "User" }; // 이름도 같이 (표시용 최신화)
  }
  return { error: "no_user" }; // initData 서명 없으면 무조건 거부 (우회 없음)
}
async function isTelegramMember(channel, userId) {
  const token = Deno.env.get("BOT_TOKEN");
  if (!token) return false;
  const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(channel)}&user_id=${userId}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const status = data && data.result ? data.result.status : null;
    return ["creator", "administrator", "member", "restricted"].includes(status);
  } catch (e) { return false; }
}

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const body = await req.json();
    const { action, mission_id, referrer_id } = body;

    // ===== 관리자 리더보드 (팀 비밀번호를 서버가 검증) =====
    if (action === "admin_leaderboard") {
      const pw = Deno.env.get("ADMIN_PASSWORD");
      if (!pw || body.password !== pw) return json({ ok: false, reason: "unauthorized" }, 401);
      const dbA = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
      const { data } = await dbA.from("app_users")
        .select("name, points, referrals, wallet, x_handle, discord, telegram_id, onboarded").order("points", { ascending: false });
      return json({ ok: true, users: data || [] });
    }

    const who = await resolveUserId(body); // ★ 서버가 신원 확인
    if (who.error) return json({ ok: false, reason: who.error }, 401);
    const telegram_id = who.id;

    const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

    // ===== 내 정보 불러오기 (앱 켤 때 호출) =====
    //  DB를 클라이언트가 직접 못 읽게 잠갔으므로, 읽기도 이 창구로만.
    //  처음 온 유저면 여기서 새로 등록. 텔레그램 이름 바뀌었으면 최신화.
    if (action === "load_user") {
      let { data: u } = await db.from("app_users")
        .select("name, points, streak, last_checkin, discord, wallet, x_handle, agreed, onboarded, referred_by, referrals")
        .eq("telegram_id", telegram_id).maybeSingle();
      if (!u) {
        await db.from("app_users").insert({ telegram_id, name: who.name, points: 0, streak: 0 });
        u = { name: who.name, points: 0, streak: 0, last_checkin: null };
      } else if (who.name && u.name !== who.name) {
        await db.from("app_users").update({ name: who.name }).eq("telegram_id", telegram_id); // 이름 최신화
      }
      const { data: comp } = await db.from("completions")
        .select("mission_id").eq("telegram_id", telegram_id).in("day", [utcToday(), "2000-01-01"]);
      return json({ ok: true, user: u, completions: (comp || []).map((c) => c.mission_id) });
    }

    // ===== 출석체크 =====
    if (action === "checkin") {
      let { data: u } = await db.from("app_users").select("points, streak, last_checkin").eq("telegram_id", telegram_id).maybeSingle();
      if (!u) { // 행이 없으면 먼저 만들어둠 (아래 '조건부 갱신'이 대상 행을 필요로 함)
        await db.from("app_users").upsert({ telegram_id, name: who.name, points: 0, streak: 0 }, { ignoreDuplicates: true });
        u = { points: 0, streak: 0, last_checkin: null };
      }
      const today = utcToday();
      if (u.last_checkin === today) return json({ ok: false, reason: "already", points: u.points || 0, streak: u.streak || 0 });
      const newStreak = (u.last_checkin === utcYesterday()) ? ((u.streak || 0) + 1) : 1; // 연속/리셋
      const newPoints = (u.points || 0) + CHECKIN_POINTS;
      // ★ 동시요청 방어: "오늘 출석 안 한 행"만 갱신하는 조건부 UPDATE.
      //   DB가 한 요청만 통과시키므로, 연타/동시 호출해도 점수가 딱 한 번만 들어감.
      const { data: claimed } = await db.from("app_users")
        .update({ streak: newStreak, last_checkin: today, points: newPoints })
        .eq("telegram_id", telegram_id)
        .or(`last_checkin.is.null,last_checkin.neq.${today}`)
        .select("points");
      if (!claimed || claimed.length === 0) {
        const { data: cur } = await db.from("app_users").select("points, streak").eq("telegram_id", telegram_id).maybeSingle();
        return json({ ok: false, reason: "already", points: cur ? cur.points || 0 : 0, streak: cur ? cur.streak || 0 : 0 });
      }
      return json({ ok: true, points: newPoints, streak: newStreak });
    }

    // ===== 등록/온보딩 저장 =====
    if (action === "register") {
      const upd = { telegram_id };
      if (body.discord !== undefined) upd.discord = body.discord;
      if (body.x_handle !== undefined) upd.x_handle = body.x_handle;
      if (body.agreed !== undefined) upd.agreed = body.agreed;
      if (body.onboarded !== undefined) upd.onboarded = body.onboarded;
      if (body.wallet !== undefined) {
        const w = String(body.wallet || "");
        if (w && (!w.startsWith("0x") || w.length < 10)) return json({ ok: false, reason: "bad_wallet" }); // 서버도 검증
        upd.wallet = body.wallet;
      }
      // 온보딩이 '지금 처음' 완료되는 순간인지 확인 (보상 중복 지급 방지)
      const { data: before } = await db.from("app_users").select("onboarded, referred_by").eq("telegram_id", telegram_id).maybeSingle();
      const justOnboarded = body.onboarded === true && !(before && before.onboarded);
      upd.registered_at = new Date().toISOString();
      await db.from("app_users").upsert(upd);
      // 초대받고 온 유저가 온보딩을 끝냈으면 → 이제서야 추천인에게 보상 + 초대 수 +1
      if (REFERRAL_ENABLED && justOnboarded && before && before.referred_by) {
        const { data: ref } = await db.from("app_users").select("points, referrals").eq("telegram_id", before.referred_by).maybeSingle();
        if (ref) {
          await db.from("app_users").update({ points: (ref.points || 0) + REFERRAL_POINTS, referrals: (ref.referrals || 0) + 1 }).eq("telegram_id", before.referred_by);
        }
      }
      return json({ ok: true });
    }

    // ===== 미션 완료 (+텔레그램 검증) =====
    if (mission_id) {
      const { data: mission } = await db.from("missions")
        .select("points, category, active, verify_type, verify_target").eq("id", mission_id).maybeSingle();
      if (!mission || !mission.active) return json({ ok: false, reason: "no_mission" }, 404);
      if (mission.verify_type === "telegram") {
        const joined = await isTelegramMember(mission.verify_target, telegram_id);
        if (!joined) return json({ ok: false, reason: "not_joined" });
      }
      const day = mission.category === "general" ? "2000-01-01" : utcToday();
      const { error: insErr } = await db.from("completions").insert({ telegram_id, mission_id, day });
      if (insErr) {
        const { data: u } = await db.from("app_users").select("points").eq("telegram_id", telegram_id).maybeSingle();
        return json({ ok: false, reason: "already", points: u ? u.points : 0 });
      }
      const { data: u } = await db.from("app_users").select("points").eq("telegram_id", telegram_id).maybeSingle();
      const newPoints = (u ? u.points : 0) + mission.points;
      await db.from("app_users").upsert({ telegram_id, points: newPoints });
      return json({ ok: true, points: newPoints, added: mission.points });
    }

    // ===== 초대 =====
    if (referrer_id) {
      if (!REFERRAL_ENABLED) return json({ ok: false, reason: "disabled" }); // 기능 꺼짐 → 초대 기록도 안 함
      if (Number(referrer_id) === Number(telegram_id)) return json({ ok: false, reason: "self" });
      const { data: me } = await db.from("app_users").select("referred_by").eq("telegram_id", telegram_id).maybeSingle();
      if (me && me.referred_by) return json({ ok: false, reason: "already_referred" });
      const { data: ref } = await db.from("app_users").select("telegram_id").eq("telegram_id", referrer_id).maybeSingle();
      if (!ref) return json({ ok: false, reason: "no_referrer" });
      // ★ 여기선 '누가 초대했는지'만 기록. 보상은 피초대자가 온보딩을 끝낸 뒤(register)에 지급 → 부계정 어뷰징 방지
      await db.from("app_users").upsert({ telegram_id, referred_by: referrer_id });
      return json({ ok: true, reason: "referred" });
    }

    return json({ ok: false, reason: "no_action" }, 400);
  } catch (e) {
    return json({ ok: false, reason: "error", detail: String(e) }, 500);
  }
});
