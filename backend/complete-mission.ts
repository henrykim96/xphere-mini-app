// ============================================================
//  complete-mission — 미션 완료를 '서버가 검증하고 점수 지급'하는 함수
// ------------------------------------------------------------
//  왜 백엔드로 옮기나?
//    지금까지는 화면이 직접 DB에 "나 3점 줘" 라고 썼어요 (조작 가능).
//    이제는 화면이 "3번 미션 했어요"만 신고하고,
//    점수 액수·중복 여부는 '서버'가 DB를 보고 직접 판단·지급해요.
//
//  ※ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는
//    Supabase가 함수에 자동으로 넣어주는 값이라 따로 설정 안 해도 돼요.
//    service_role 키 = 서버 전용 마스터키 (화면엔 절대 없음)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 서버(UTC)에서도 '서울 기준 오늘'을 정확히 계산
function seoulToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

Deno.serve(async (req) => {
  // CORS (화면에서 호출 허용)
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // JSON 응답 도우미
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  try {
    // 화면이 보낸 값: 누가(telegram_id) · 어떤 미션(mission_id)
    const { telegram_id, mission_id } = await req.json();
    if (!telegram_id || !mission_id) return json({ ok: false, reason: "bad_request" }, 400);

    // 서버 전용 마스터키로 DB 접속 (RLS 통과)
    const db = createClient(
      Deno.env.get("SUPABASE_URL"),
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    );

    // ① 미션이 진짜 있고 활성화됐는지 + 몇 점인지 (점수는 서버가 결정!)
    const { data: mission } = await db
      .from("missions")
      .select("points, category, active")
      .eq("id", mission_id)
      .maybeSingle();
    if (!mission || !mission.active) return json({ ok: false, reason: "no_mission" }, 404);

    // ② 완료기록에 쓸 날짜: general=영구(2000-01-01) / daily=오늘
    const day = mission.category === "general" ? "2000-01-01" : seoulToday();

    // ③ 완료기록 남기기. (유저+미션+날짜)가 이미 있으면 DB가 거부 → 이미 완료한 것
    const { error: insErr } = await db
      .from("completions")
      .insert({ telegram_id, mission_id, day });
    if (insErr) {
      // 이미 완료 → 점수 안 주고, 현재 점수만 돌려줌
      const { data: u } = await db.from("app_users").select("points").eq("telegram_id", telegram_id).maybeSingle();
      return json({ ok: false, reason: "already", points: u ? u.points : 0 });
    }

    // ④ 점수 지급 — 현재 점수 읽고 + 미션 점수 더해서 저장
    const { data: u } = await db.from("app_users").select("points").eq("telegram_id", telegram_id).maybeSingle();
    const newPoints = (u ? u.points : 0) + mission.points;
    await db.from("app_users").upsert({ telegram_id, points: newPoints }); // 없으면 새로 생성

    // 화면에 최종 점수 돌려줌
    return json({ ok: true, points: newPoints, added: mission.points });
  } catch (e) {
    return json({ ok: false, reason: "error", detail: String(e) }, 500);
  }
});
