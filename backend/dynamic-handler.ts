// ============================================================
//  dynamic-handler — 미션(+텔레그램검증) + 초대 + initData 보안검증
// ------------------------------------------------------------
//  ★ initData 검증: 화면이 보낸 텔레그램 서명(initData)을 봇 토큰으로 확인 →
//     '진짜 그 유저'임을 서버가 증명. 위조하면 거부.
//  ※ 개발용 임시 우회: initData 없으면 body.telegram_id 사용 (⚠️런칭 전 제거)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REFERRAL_POINTS = 10;
function seoulToday() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }); }

// --- HMAC-SHA256 도우미 ---
async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

// --- 텔레그램 initData 서명 검증 → 진짜면 user 객체 반환, 위조면 null ---
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
  const dataCheckString = pairs.join("\n");
  const secretKey = await hmac(new TextEncoder().encode("WebAppData"), token); // 1차 키
  const computed = await hmac(secretKey, dataCheckString);                     // 2차 해시
  const computedHex = [...computed].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (computedHex !== hash) return null; // 서명 불일치 = 위조
  try { return JSON.parse(params.get("user")); } catch (e) { return null; }
}

// --- 요청자의 '진짜' telegram_id 알아내기 ---
async function resolveUserId(body) {
  if (body.initData) {
    const u = await verifyInitData(body.initData);
    if (!u || !u.id) return { error: "unauthorized" }; // 위조된 initData
    return { id: Number(u.id) };
  }
  // 개발용 우회 (⚠️ 실서비스 전 이 부분 제거)
  if (body.telegram_id) return { id: Number(body.telegram_id) };
  return { error: "no_user" };
}

// 텔레그램 채널 가입 확인
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
    const { mission_id, referrer_id } = body;

    // ★ 요청자 신원 확인 (여기서 telegram_id 를 '서버가' 결정 — 화면 말 안 믿음)
    const who = await resolveUserId(body);
    if (who.error) return json({ ok: false, reason: who.error }, 401);
    const telegram_id = who.id;

    const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

    // ① 미션 완료 (+텔레그램 검증)
    if (mission_id) {
      const { data: mission } = await db.from("missions")
        .select("points, category, active, verify_type, verify_target").eq("id", mission_id).maybeSingle();
      if (!mission || !mission.active) return json({ ok: false, reason: "no_mission" }, 404);

      if (mission.verify_type === "telegram") {
        const joined = await isTelegramMember(mission.verify_target, telegram_id);
        if (!joined) return json({ ok: false, reason: "not_joined" });
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

    // ② 초대(referral)
    if (referrer_id) {
      if (Number(referrer_id) === Number(telegram_id)) return json({ ok: false, reason: "self" });
      const { data: me } = await db.from("app_users").select("referred_by").eq("telegram_id", telegram_id).maybeSingle();
      if (me && me.referred_by) return json({ ok: false, reason: "already_referred" });
      const { data: ref } = await db.from("app_users").select("points, referrals").eq("telegram_id", referrer_id).maybeSingle();
      if (!ref) return json({ ok: false, reason: "no_referrer" });
      await db.from("app_users").upsert({ telegram_id, referred_by: referrer_id });
      await db.from("app_users").update({ points: (ref.points || 0) + REFERRAL_POINTS, referrals: (ref.referrals || 0) + 1 }).eq("telegram_id", referrer_id);
      return json({ ok: true, reason: "referred", reward: REFERRAL_POINTS });
    }

    return json({ ok: false, reason: "no_action" }, 400);
  } catch (e) {
    return json({ ok: false, reason: "error", detail: String(e) }, 500);
  }
});
