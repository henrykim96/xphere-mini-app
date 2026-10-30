// ============================================================
//  bot — 텔레그램 봇 '채팅 서버' (webhook)
// ------------------------------------------------------------
//  텔레그램이 유저 메시지(/start 등)를 이 함수로 보내줌(webhook).
//  /start 를 받으면 → 환영 메시지 + 버튼(Play 등)을 답장.
//  ※ BOT_TOKEN(Secrets)로 답장 전송. 이 함수는 'Verify JWT' 꺼야 함.
// ============================================================

Deno.serve(async (req) => {
  const token = Deno.env.get("BOT_TOKEN");

  // (선택) 텔레그램 비밀토큰 확인 — TG_WEBHOOK_SECRET 넣었으면 검사
  const secret = Deno.env.get("TG_WEBHOOK_SECRET");
  if (secret && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  let update = null;
  try { update = await req.json(); } catch (e) { return new Response("ok"); }

  const msg = update && update.message;
  const text = msg && msg.text ? msg.text : "";

  // /start 명령에 답장
  if (msg && text.startsWith("/start")) {
    const chatId = msg.chat.id;
    const appUrl = "https://henrykim96.github.io/xphere-mini-app/"; // 미니앱 주소 (GitHub Pages)

    const welcome =
      "Welcome to Xphere Community! 🚀\n\n" +
      "Earn points by completing missions, checking in daily, and inviting friends. " +
      "Rewards await when the Xphere airdrop launches.\n\n" +
      "Tap Play to get started.";

    const keyboard = {
      inline_keyboard: [
        [{ text: "🎮 Play", web_app: { url: appUrl } }],
        [{ text: "👥 My Referrals", web_app: { url: appUrl } }],
      ],
    };

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: welcome, reply_markup: keyboard }),
    });
  }

  return new Response("ok"); // 텔레그램에는 항상 200 응답
});
