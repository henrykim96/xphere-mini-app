// ============================================================
//  dynamic-handler — 미션 완료(+텔레그램 검증) + 초대(referral) 처리
// ------------------------------------------------------------
//  body 에 따라:
//    { telegram_id, mission_id }  → 미션 완료 (verify_type='telegram'이면 채널가입 확인 후 점수)
//    { telegram_id, referrer_id } → 초대 처리 (추천인 보상)
//
//  ※ SUPABASE_URL / SERVICE_ROLE_KEY 자동주입. BOT_TOKEN 은 Secrets에 넣은 값.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REFERRAL_POINTS = 10;

function seoulToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

// 텔레그램 채널 가입 여부 확인 (봇이 그 채널 관리자여야 함)
async function isTelegramMember(channel, userId) {
  const token = Deno.env.get("BOT_TOKEN");
  if (!token) return false;
  const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(channel)}&user_id=${userId}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const status = data && data.result ? data.result.status : null;
    // 가입 상태로 인정하는 값들 (탈퇴/추방은 제외)
    return ["creator", "administrator", "member", "restricted"].includes(status);
  } catch (e) {
    return false;
  }
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const { telegram_id, mission_id, referrer_id } = await req.json();
    if (!telegram_id) return json({ ok: false, reason: "bad_request" }, 400);

    const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

    // ===== ① 미션 완료 =====
    if (mission_id) {
      const { data: mission } = await db.from("missions")
        .select("points, category, active, verify_type, verify_target").eq("id", mission_id).maybeSingle();
      if (!mission || !mission.active) return json({ ok: false, reason: "no_mission" }, 404);

      // 텔레그램 검증이 필요한 미션이면 → 가입 여부 먼저 확인
      if (mission.verify_type === "telegram") {
        const joined = await isTelegramMember(mission.verify_target, telegram_id);
        if (!joined) return json({ ok: false, reason: "not_joined" }); // 미가입 → 점수 X
      }

      const day = mission.category === "general" ? "2000-01-01" : seoulToday();
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

    // ===== ② 초대(referral) =====
    if (referrer_id) {
      if (Number(referrer_id) === Number(telegram_id)) return json({ ok: false, reason: "self" });
      const { data: me } = await db.from("app_users").select("referred_by").eq("telegram_id", telegram_id).maybeSingle();
      if (me && me.referred_by) return json({ ok: false, reason: "already_referred" });
      const { data: ref } = await db.from("app_users").select("points, referrals").eq("telegram_id", referrer_id).maybeSingle();
      if (!ref) return json({ ok: false, reason: "no_referrer" });
      await db.from("app_users").upsert({ telegram_id, referred_by: referrer_id });
      await db.from("app_users").update({
        points: (ref.points || 0) + REFERRAL_POINTS,
        referrals: (ref.referrals || 0) + 1,
      }).eq("telegram_id", referrer_id);
      return json({ ok: true, reason: "referred", reward: REFERRAL_POINTS });
    }

    return json({ ok: false, reason: "no_action" }, 400);
  } catch (e) {
    return json({ ok: false, reason: "error", detail: String(e) }, 500);
  }
});
