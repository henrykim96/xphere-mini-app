// ============================================================
//  x-callback — X 연동(OAuth) 승인 결과를 받는 함수 (Supabase 함수 이름: x-callback)
// ------------------------------------------------------------
//  ★ 이 함수는 'Verify JWT' 를 반드시 OFF 로 배포 (X 가 브라우저로 직접 호출하므로 인증 헤더가 없음. bot 함수와 같은 방식)
//  흐름: 유저가 X 에서 Authorize → X 가 ?code=&state= 로 여기를 호출
//        → state 로 어떤 텔레그램 유저의 시도인지 찾고(1회용) → code 를 토큰으로 교환 → /2/users/me 로 계정 번호·핸들 확인
//        → app_users 에 저장(x_connected=true) → 안내 페이지(x-done.html)로 이동
//  필요한 Secrets: X_CLIENT_ID, X_CLIENT_SECRET (dynamic-handler 와 공통)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL = "https://zingy-starlight-297d87.netlify.app"; // 미니앱 주소 (x-done.html 이 있는 곳)
const back = (s: string) => new Response(null, { status: 302, headers: { Location: APP_URL + "/x-done.html?s=" + s } });

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    if (u.searchParams.get("error")) return back("denied"); // 유저가 Authorize 를 취소
    const code = u.searchParams.get("code"), state = u.searchParams.get("state");
    if (!code || !state) return back("error");

    const cid = Deno.env.get("X_CLIENT_ID"), secret = Deno.env.get("X_CLIENT_SECRET");
    if (!cid || !secret) return back("error");
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // state 로 시도 찾기 → 바로 삭제(1회용) → 15분 지난 건 무효
    const { data: row } = await db.from("x_oauth").select("telegram_id, verifier, created_at").eq("state", state).maybeSingle();
    if (!row) return back("expired");
    await db.from("x_oauth").delete().eq("state", state);
    if (Date.now() - Date.parse(row.created_at) > 15 * 60 * 1000) return back("expired");

    // code → 접근 토큰
    const redirect = Deno.env.get("SUPABASE_URL") + "/functions/v1/x-callback";
    const tok = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(cid + ":" + secret) },
      body: new URLSearchParams({ code, grant_type: "authorization_code", client_id: cid, redirect_uri: redirect, code_verifier: row.verifier }),
    });
    const tj = await tok.json().catch(() => null);
    if (!tok.ok || !tj || !tj.access_token) { console.log("x token fail", tok.status, JSON.stringify(tj)); return back("error"); }

    // 승인한 사람이 누구인지 (계정 번호 + 핸들)
    const me = await fetch("https://api.x.com/2/users/me", { headers: { Authorization: "Bearer " + tj.access_token } });
    const mj = await me.json().catch(() => null);
    if (!me.ok || !mj || !mj.data || !mj.data.id) { console.log("x users/me fail", me.status, JSON.stringify(mj)); return back("error"); }
    const xid = String(mj.data.id), handle = String(mj.data.username || "").toLowerCase();
    const tg = row.telegram_id;

    // 이 X 계정을 이미 다른 텔레그램 계정이 연동했으면 거절 (1인 1계정)
    const { data: dupId } = await db.from("app_users").select("telegram_id").eq("x_user_id", xid).neq("telegram_id", tg).limit(1);
    if (dupId && dupId.length) return back("taken");

    // 이미 리포스트 검증까지 끝난 유저가 다른 X 계정으로 바꾸려는 경우 거절
    const { data: cur } = await db.from("app_users").select("x_user_id, x_repost_status").eq("telegram_id", tg).maybeSingle();
    if (cur && cur.x_repost_status === "verified" && cur.x_user_id && cur.x_user_id !== xid) return back("locked");

    // 예전에 '핸들 직접 입력'으로 이 핸들만 선점해 둔(연동 안 된) 다른 행은 핸들을 비워줌 → 진짜 주인이 연동할 수 있게
    await db.from("app_users").update({ x_handle: null }).eq("x_handle", handle).neq("telegram_id", tg).or("x_connected.is.null,x_connected.eq.false");

    const upd: Record<string, unknown> = { telegram_id: tg, x_handle: handle, x_user_id: xid, x_connected: true };
    if (!cur || cur.x_user_id !== xid) upd.x_repost_status = null; // 다른 계정으로 바뀌면 리포스트 확인을 처음부터 다시
    const { error } = await db.from("app_users").upsert(upd);
    if (error) {
      const m = String(error.message || "");
      console.log("x save fail", m);
      return back(m.includes("uniq") ? "taken" : "error");
    }
    return back("ok");
  } catch (e) {
    console.log("x-callback error", String(e));
    return back("error");
  }
});
