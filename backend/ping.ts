// ============================================================
//  ping 함수 — 백엔드가 살아있는지 확인하는 '테스트용' 함수
// ------------------------------------------------------------
//  이건 진짜 기능은 아니고, "백엔드 함수가 만들어지고 호출되는지"
//  플러밍(배관)이 되는지 확인하는 첫 실험용이에요.
//
//  Supabase Edge Function 은 Deno + TypeScript 로 돌아가요.
//  Deno.serve(...) = "누가 이 함수를 부르면 여기 안이 실행됨"
// ============================================================

Deno.serve(async (req) => {
  // ----- CORS 설정 -----
  // 화면(GitHub Pages 주소)에서 이 함수를 부를 때, 브라우저가 보안상
  // "다른 주소 호출"을 막을 수 있어서 아래 허용 헤더가 필요해요.
  const cors = {
    "Access-Control-Allow-Origin": "*",                       // 어떤 화면에서든 호출 허용
    "Access-Control-Allow-Headers": "authorization, content-type",
  };

  // 브라우저가 실제 요청 전에 먼저 보내는 'OPTIONS' 예비 요청 처리
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  // ----- 실제 응답 -----
  // 지금은 그냥 "살아있어요!" 라고 답만 돌려줌
  return new Response(
    JSON.stringify({ ok: true, message: "백엔드 살아있어요!" }),
    { headers: { ...cors, "Content-Type": "application/json" } }
  );
});
