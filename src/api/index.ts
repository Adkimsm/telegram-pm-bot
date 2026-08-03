import { Api, GrammyError } from "grammy";
import {
  clearedSessionCookie,
  readSessionCookie,
  revokeAllSessions,
  revokeSession,
  verifySession,
} from "../lib/auth";
import { deriveWebhookSecret } from "../lib/crypto";
import {
  banUser,
  cleanup,
  deleteTopic,
  getStats,
  getUser,
  listBans,
  listCandidateChats,
  listUsers,
  unbanUser,
} from "../lib/db";
import { displayName, parseUserIdArg } from "../lib/format";
import { loadSettings, setSetting, validateSetting } from "../lib/settings";
import { ALLOWED_UPDATES } from "../bot";
import type { Env } from "../lib/types";

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

/**
 * Every /api/* route is authenticated. Read-only routes are gated too: the
 * user list and settings are as sensitive as the ability to change them.
 */
export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const token = readSessionCookie(request);

  if (!(await verifySession(env, token))) {
    return json(
      { error: "unauthenticated" },
      { status: 401, headers: { "Set-Cookie": clearedSessionCookie() } },
    );
  }

  // Cookies are SameSite=Lax, which stops cross-site form posts but not all
  // cross-origin fetches; requiring a same-origin marker closes that gap.
  if (request.method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) {
      return json({ error: "cross-origin request rejected" }, { status: 403 });
    }
  }

  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = request.method;

  try {
    switch (`${method} ${path}`) {
      case "GET overview":
        return await getOverview(env, url);
      case "GET settings":
        return await getSettings(env);
      case "PUT settings":
        return await putSettings(request, env);
      case "GET users":
        return await getUsers(env, url);
      case "GET bans":
        return json({ bans: await listBans(env) });
      case "POST bans":
        return await postBan(request, env);
      case "DELETE bans":
        return await deleteBan(request, env);
      case "GET chats":
        return json({ chats: await listCandidateChats(env) });
      case "POST bind":
        return await postBind(request, env);
      case "GET webhook":
        return await getWebhook(env, url);
      case "POST webhook":
        return await postWebhook(env, url);
      case "POST cleanup":
        return json({ deleted: await cleanup(env) });
      case "POST logout":
        return await postLogout(env, token);
      case "POST revoke-all":
        return json(
          { revoked: await revokeAllSessions(env) },
          { headers: { "Set-Cookie": clearedSessionCookie() } },
        );
      case "DELETE topic":
        return await deleteTopicRoute(request, env);
      default:
        return json({ error: "not found" }, { status: 404 });
    }
  } catch (err) {
    console.error("[api]", err);
    return json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function getOverview(env: Env, url: URL): Promise<Response> {
  const settings = await loadSettings(env);
  const stats = await getStats(env);

  // Surface the setup state explicitly so the UI can show a checklist rather
  // than making the operator guess why nothing is being relayed.
  let relayCheck: {
    ok: boolean;
    detail: string;
    isForum?: boolean;
    canManageTopics?: boolean;
  } = { ok: false, detail: "No relay group bound." };

  if (settings.relayChatId !== null) {
    relayCheck = await probeRelayChat(env, settings.relayChatId);
  }

  return json({
    settings: {
      ...settings,
      ownerId: settings.ownerId,
      relayChatId: settings.relayChatId,
    },
    stats,
    relayCheck,
    consoleUrl: url.origin,
    ready: settings.ownerId !== null && relayCheck.ok,
  });
}

/**
 * Verify the bound group really is a forum and the bot can manage topics.
 * Doing this on demand beats discovering it when a correspondent's first
 * message fails to relay.
 */
async function probeRelayChat(
  env: Env,
  chatId: number,
): Promise<{
  ok: boolean;
  detail: string;
  isForum?: boolean;
  canManageTopics?: boolean;
  title?: string;
}> {
  const api = new Api(env.BOT_TOKEN);
  try {
    const chat = await api.getChat(chatId);
    const me = await api.getMe();
    const member = await api.getChatMember(chatId, me.id);

    const isForum = "is_forum" in chat && chat.is_forum === true;
    const canManageTopics =
      member.status === "creator" ||
      (member.status === "administrator" && member.can_manage_topics === true);

    const title = "title" in chat ? (chat.title ?? "") : "";

    if (!isForum) {
      return {
        ok: false,
        detail:
          "Topics are not enabled for this group. Enable them in the group settings.",
        isForum,
        canManageTopics,
        title,
      };
    }
    if (!canManageTopics) {
      return {
        ok: false,
        detail:
          'The bot needs to be an admin with the "Manage topics" permission.',
        isForum,
        canManageTopics,
        title,
      };
    }
    return { ok: true, detail: "Ready.", isForum, canManageTopics, title };
  } catch (err) {
    return {
      ok: false,
      detail:
        err instanceof GrammyError
          ? `Cannot read the group: ${err.description}`
          : "Cannot read the group.",
    };
  }
}

async function getSettings(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT key, value, updated_at FROM settings ORDER BY key",
  ).all<{ key: string; value: string; updated_at: number }>();
  return json({ settings: results });
}

async function putSettings(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body !== "object") return badRequest("expected a JSON object");

  const applied: Record<string, string> = {};
  const errors: string[] = [];

  for (const [key, raw] of Object.entries(body)) {
    const result = validateSetting(key, raw);
    if (!result.ok) {
      errors.push(result.error ?? `invalid value for ${key}`);
      continue;
    }
    applied[key] = result.value!;
  }

  // Reject the whole request on any error so the operator never ends up with
  // a half-applied configuration.
  if (errors.length > 0) return json({ errors }, { status: 400 });

  for (const [key, value] of Object.entries(applied)) {
    await setSetting(env, key, value);
  }

  return json({ applied });
}

async function getUsers(env: Env, url: URL): Promise<Response> {
  const search = url.searchParams.get("q") ?? undefined;
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);

  const { users, total } = await listUsers(env, { search, limit, offset });
  return json({
    users: users.map((u) => ({ ...u, display_name: displayName(u) })),
    total,
    limit,
    offset,
  });
}

async function postBan(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    user_id?: unknown;
    reason?: unknown;
  } | null;
  const userId = parseUserIdArg(String(body?.user_id ?? ""));
  if (userId === null) return badRequest("user_id must be a numeric Telegram id");

  const reason = typeof body?.reason === "string" ? body.reason.slice(0, 500) : "";
  await banUser(env, userId, reason);
  return json({ ok: true, user_id: userId });
}

async function deleteBan(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    user_id?: unknown;
  } | null;
  const userId = parseUserIdArg(String(body?.user_id ?? ""));
  if (userId === null) return badRequest("user_id must be a numeric Telegram id");

  const removed = await unbanUser(env, userId);
  return json({ ok: true, removed, user_id: userId });
}

/**
 * Bind the relay group.
 *
 * The group is probed first: binding a group that is not a forum, or where the
 * bot cannot manage topics, would silently break relaying.
 */
async function postBind(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    chat_id?: unknown;
  } | null;
  const chatId = parseUserIdArg(String(body?.chat_id ?? ""));
  if (chatId === null) return badRequest("chat_id must be a numeric chat id");

  const check = await probeRelayChat(env, chatId);
  if (!check.ok) return json({ error: check.detail, check }, { status: 400 });

  await setSetting(env, "relay_chat_id", String(chatId));
  return json({ ok: true, chat_id: chatId, check });
}

async function getWebhook(env: Env, url: URL): Promise<Response> {
  const api = new Api(env.BOT_TOKEN);
  const secret = await deriveWebhookSecret(env.BOT_TOKEN);
  const expected = `${url.origin}/tg/${secret}`;

  try {
    const info = await api.getWebhookInfo();
    return json({
      info,
      expected,
      matches: info.url === expected,
    });
  } catch (err) {
    return json(
      {
        error:
          err instanceof GrammyError ? err.description : "getWebhookInfo failed",
        expected,
      },
      { status: 502 },
    );
  }
}

async function postWebhook(env: Env, url: URL): Promise<Response> {
  const api = new Api(env.BOT_TOKEN);
  const secret = await deriveWebhookSecret(env.BOT_TOKEN);
  const target = `${url.origin}/tg/${secret}`;

  try {
    await api.setWebhook(target, {
      secret_token: secret,
      // Must be sent explicitly every time: "If not specified, the previous
      // setting will be used."
      allowed_updates: [...ALLOWED_UPDATES],
    });
    const info = await api.getWebhookInfo();
    return json({ ok: true, url: target, info });
  } catch (err) {
    return json(
      {
        error: err instanceof GrammyError ? err.description : "setWebhook failed",
      },
      { status: 502 },
    );
  }
}

async function postLogout(env: Env, token: string | null): Promise<Response> {
  if (token) await revokeSession(env, token);
  return json(
    { ok: true },
    { headers: { "Set-Cookie": clearedSessionCookie() } },
  );
}

/**
 * Forget a correspondent's topic binding.
 *
 * This does not delete the Telegram topic — deleteForumTopic would destroy the
 * conversation history. It only clears the mapping so the next message starts
 * a fresh topic.
 */
async function deleteTopicRoute(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    user_id?: unknown;
  } | null;
  const userId = parseUserIdArg(String(body?.user_id ?? ""));
  if (userId === null) return badRequest("user_id must be a numeric Telegram id");

  const user = await getUser(env, userId);
  if (!user) return json({ error: "unknown user" }, { status: 404 });

  await deleteTopic(env, userId);
  return json({ ok: true, user_id: userId });
}

/**
 * Parse an optional numeric query parameter.
 *
 * `Number(null)` is 0, not NaN, so a missing parameter must be checked before
 * conversion — otherwise an absent `limit` would clamp to the minimum instead
 * of falling back to the default.
 */
function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
