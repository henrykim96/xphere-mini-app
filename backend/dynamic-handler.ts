// ============================================================
//  dynamic-handler — 미션 완료 + 초대(referral)를 처리하는 백엔드 함수
// ------------------------------------------------------------
//  요청 body 에 따라 두 가지 일을 함:
//    { telegram_id, mission_id }  → 미션 완료 처리 (점수 지급)
//    { telegram_id, referrer_id } → 초대 처리 (추천인에게 보상)
//
//  ※ SUPABASE_URL / SERVICE_ROLE_KEY 는 자동 주입됨 (설정 불필요)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REFERRAL_POINTS = 10; // 초대 1명당 추천인에게 주는 점수

// 서버(UTC)에서도 '서울 기준 오늘' 계산
function seoulToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
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

    const db = createClient(
      Deno.env.get("SUPABASE_URL"),
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    );

    // ===== ① 미션 완료 처리 =====
    if (mission_id) {
      const { data: mission } = await db.from("missions")
        .select("points, category, active").eq("id", mission_id).maybeSingle();
      if (!mission || !mission.active) return json({ ok: false, reason: "no_mission" }, 404);

      const day = mission.category === "general" ? "2000-01-01" : seoulToday();

      const { error: insErr } = await db.from("completions")
        .insert({ telegram_id, mission_id, day });
      if (insErr) {
        const { data: u } = await db.from("app_users").select("points").eq("telegram_id", telegram_id).maybeSingle();
        return json({ ok: false, reason: "already", points: u ? u.points : 0 });
      }

      const { data: u } = await db.from("app_users").select("points").eq("telegram_id", telegram_id).maybeSingle();
      const newPoints = (u ? u.points : 0) + mission.points;
      await db.from("app_users").upsert({ telegram_id, points: newPoints });
      return json({ ok: true, points: newPoints, added: mission.points });
    }

    // ===== ② 초대(referral) 처리 =====
    if (referrer_id) {
      // 자기 자신 초대 금지
      if (Number(referrer_id) === Number(telegram_id)) return json({ ok: false, reason: "self" });

      // 신규 유저(나)가 이미 누군가에게 초대됐는지 확인 → 한 번만 인정
      const { data: me } = await db.from("app_users").select("referred_by").eq("telegram_id", telegram_id).maybeSingle();
      if (me && me.referred_by) return json({ ok: false, reason: "already_referred" });

      // 추천인이 진짜 존재하는지 확인
      const { data: ref } = await db.from("app_users").select("points, referrals").eq("telegram_id", referrer_id).maybeSingle();
      if (!ref) return json({ ok: false, reason: "no_referrer" });

      // 내 기록: 추천인 저장 (없으면 새로 만들며 저장)
      await db.from("app_users").upsert({ telegram_id, referred_by: referrer_id });

      // 추천인 보상: 점수 +10, 초대수 +1
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
