import type { Update } from "grammy/types";
import { handleApi } from "./api";
import { processUpdate } from "./bot";
import {
  createSession,
  redeemLoginNonce,
  sessionCookie,
} from "./lib/auth";
import { deriveWebhookSecret, timingSafeEqual } from "./lib/crypto";
import { cleanup } from "./lib/db";
import { loadSettings } from "./lib/settings";
import type { Env } from "./lib/types";

export { MediaGroupBuffer } from "./lib/media-group";

const SESSION_TTL_SEC = 7 * 86400;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (!env.BOT_TOKEN) {
      return new Response(
        "BOT_TOKEN is not set. Run: wrangler secret put BOT_TOKEN",
        { status: 500 },
      );
    }

    if (url.pathname.startsWith("/tg/")) {
      return handleWebhook(request, env, url, ctx);
    }

    if (url.pathname.startsWith("/auth/")) {
      return handleAuthRedeem(request, env, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    // Everything else is the static console. `run_worker_first` only routes
    // the three prefixes above here, so this is just a safety net.
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const deleted = await cleanup(env);
    console.log("[cron] cleanup", deleted);
  },
} satisfies ExportedHandler<Env>;

/**
 * Telegram webhook.
 *
 * Two layers of protection: the path segment is unguessable, and the
 * `X-Telegram-Bot-Api-Secret-Token` header is verified in constant time. Both
 * are derived from BOT_TOKEN, so no extra configuration is involved.
 */
async function handleWebhook(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const expected = await deriveWebhookSecret(env.BOT_TOKEN);
  const pathSecret = url.pathname.slice("/tg/".length);
  const headerSecret =
    request.headers.get("x-telegram-bot-api-secret-token") ?? "";

  if (
    !timingSafeEqual(pathSecret, expected) ||
    !timingSafeEqual(headerSecret, expected)
  ) {
    // 401 rather than 404: a wrong secret is not a routing problem, and
    // Telegram will retry, which is the correct behaviour if we ever rotate.
    return new Response("unauthorised", { status: 401 });
  }

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    // Malformed body: acknowledge so Telegram does not retry forever.
    return new Response("ok");
  }

  if (typeof update?.update_id !== "number") return new Response("ok");

  const settings = await loadSettings(env);

  // Always answer 2xx. A non-2xx makes Telegram redeliver the update, which
  // would duplicate anything that already succeeded. Errors are logged inside.
  try {
    await processUpdate(env, settings, update, url, (p) => ctx.waitUntil(p));
  } catch (err) {
    console.error("[webhook]", err);
  }

  return new Response("ok");
}

/**
 * Redeem a single-use login link and set the session cookie.
 *
 * The nonce is deleted as part of redemption, so a leaked link in browser
 * history or a chat log cannot be reused.
 */
async function handleAuthRedeem(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const nonce = url.pathname.slice("/auth/".length);

  if (!nonce || nonce.length > 128) {
    return htmlError("Invalid login link.");
  }

  if (!(await redeemLoginNonce(env, nonce))) {
    return htmlError(
      "This login link has expired or was already used. Send /login to the bot again.",
    );
  }

  const { token } = await createSession(
    env,
    request.headers.get("User-Agent") ?? "",
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${url.origin}/`,
      "Set-Cookie": sessionCookie(token, SESSION_TTL_SEC),
      "Cache-Control": "no-store",
    },
  });
}

function htmlError(message: string): Response {
  const body = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pmbot</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; background: #0f1115; color: #e6e6e6; }
  .card { max-width: 30rem; padding: 2rem; text-align: center; }
  code { background: #1c1f26; padding: .15em .4em; border-radius: .25rem; }
</style></head>
<body><div class="card"><h1>Cannot sign in</h1><p>${escapeHtml(message)}</p>
<p>Send <code>/login</code> to your bot to get a fresh link.</p></div></body></html>`;

  return new Response(body, {
    status: 401,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
