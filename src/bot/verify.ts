import type { CallbackQuery, Message } from "grammy/types";
import {
  bumpVerificationFailure,
  getVerificationState,
  now,
  resetExpiredChallenge,
  saveVerificationChallenge,
  setTemporaryVerificationBan,
  setVerified,
  touchUser,
} from "../lib/db";
import type { BotContext } from "./context";
import { logError } from "./context";
import { makeArithmeticChallenge } from "../lib/verify";

/**
 * Intercept private-chat messages until the user passes verification.
 *
 * Returns true when the message has been fully handled and must not proceed to
 * the normal relay path.
 */
export async function handleHumanVerification(
  ctx: BotContext,
  msg: Message,
): Promise<boolean> {
  const from = msg.from;
  if (!from || from.is_bot) return false;

  const { env, api, settings } = ctx;

  if (!settings.humanVerifyEnabled) return false;

  const state = await getVerificationState(env, from.id);
  const ts = now();

  if (state?.verified_at) return false;

  await touchUser(
    env,
    {
      userId: from.id,
      firstName: from.first_name ?? "",
      lastName: from.last_name ?? "",
      username: from.username ?? null,
      languageCode: from.language_code ?? null,
    },
    { enabled: false, max: 0, windowSec: 60 },
  );

  if ((state?.temp_banned_until ?? 0) > ts) {
    const seconds = Math.max(1, state!.temp_banned_until - ts);
    await api
      .sendMessage(
        from.id,
        `验证失败次数过多，请 ${seconds} 秒后再试。`,
      )
      .catch((e) => logError("verify-temp-ban", e));
    return true;
  }

  if ((state?.verify_expires_at ?? 0) <= ts && state?.verify_state === "pending") {
    await resetExpiredChallenge(env, from.id);
  }

  if (msg.text?.startsWith("/start")) {
    await sendChallenge(ctx, from.id, true);
    return true;
  }

  if (state?.verify_state === "pending" && state.verify_expires_at > ts) {
    await api
      .sendMessage(
        from.id,
        "请先完成上一道验证题；如果题目已经被消息淹没，请发送 /start 重新获取。",
      )
      .catch((e) => logError("verify-remind", e));
    return true;
  }

  // Before verification, every ordinary message is stopped here. The user was
  // expected to come in via /start and then solve the challenge before sending
  // anything meaningful, so there is no buffering or replay path.
  await sendChallenge(ctx, from.id, false);
  return true;
}

export async function maybeHandleVerificationCallback(
  ctx: BotContext,
  query: CallbackQuery,
): Promise<boolean> {
  const data = query.data ?? "";
  if (!data.startsWith("hv:")) return false;

  const { env, api, settings } = ctx;
  const actorId = query.from.id;

  const parts = data.split(":");
  const nonce = parts[1] ?? "";
  const answer = parts[2] ?? "";

  const state = await getVerificationState(env, actorId);
  const ts = now();

  if (!settings.humanVerifyEnabled) {
    await api.answerCallbackQuery(query.id, {
      text: "验证功能未启用。",
      show_alert: true,
    }).catch((e) => logError("verify-cb-disabled", e));
    return true;
  }

  if (!state || !state.verify_state) {
    await api.answerCallbackQuery(query.id, {
      text: "当前没有待完成的验证题。",
      show_alert: true,
    }).catch((e) => logError("verify-cb-none", e));
    return true;
  }

  if (state.verified_at) {
    await api.answerCallbackQuery(query.id, {
      text: "你已经通过验证。",
    }).catch((e) => logError("verify-cb-already", e));
    return true;
  }

  if (state.temp_banned_until > ts) {
    await api.answerCallbackQuery(query.id, {
      text: `请稍后再试（${state.temp_banned_until - ts} 秒）`,
      show_alert: true,
    }).catch((e) => logError("verify-cb-temp-ban", e));
    return true;
  }

  if (state.verify_expires_at <= ts || state.verify_nonce !== nonce) {
    await resetExpiredChallenge(env, actorId);
    await api.answerCallbackQuery(query.id, {
      text: "题目已过期，我会重新发一题。",
      show_alert: true,
    }).catch((e) => logError("verify-cb-expired", e));
    await sendChallenge(ctx, actorId, false);
    return true;
  }

  if (answer === state.verify_answer) {
    await setVerified(env, actorId);
    await api.answerCallbackQuery(query.id, {
      text: "验证通过。",
    }).catch((e) => logError("verify-cb-pass", e));

    await api.sendMessage(
      actorId,
      "✅ 验证通过。现在请重新发送你的消息。",
    ).catch((e) => logError("verify-pass-msg", e));
    return true;
  }

  const attempts = await bumpVerificationFailure(
    env,
    actorId,
    state.verify_attempts + 1 >= settings.humanVerifyMaxAttempts
      ? ts + settings.humanVerifyBanMinutes * 60
      : null,
  );

  if (attempts >= settings.humanVerifyMaxAttempts) {
    await setTemporaryVerificationBan(
      env,
      actorId,
      ts + settings.humanVerifyBanMinutes * 60,
    );
    await api.answerCallbackQuery(query.id, {
      text: `验证失败过多，已临时限制 ${settings.humanVerifyBanMinutes} 分钟。`,
      show_alert: true,
    }).catch((e) => logError("verify-cb-ban", e));
    return true;
  }

  await api.answerCallbackQuery(query.id, {
    text: `答案错误，还剩 ${settings.humanVerifyMaxAttempts - attempts} 次机会。`,
    show_alert: true,
  }).catch((e) => logError("verify-cb-wrong", e));

  await sendChallenge(ctx, actorId, false, attempts);
  return true;
}

export async function sendChallenge(
  ctx: BotContext,
  userId: number,
  includeWelcome: boolean,
  attempts = 0,
): Promise<void> {
  const { env, api, settings } = ctx;
  const ts = now();
  const q = makeArithmeticChallenge();

  await saveVerificationChallenge(env, userId, {
    nonce: q.nonce,
    answer: q.answer,
    expiresAt: ts + settings.humanVerifyTimeout,
  }, attempts);

  const lines = [];
  if (includeWelcome && settings.welcomeText) lines.push(settings.welcomeText);
  if (settings.humanVerifyPrompt) lines.push(settings.humanVerifyPrompt);
  lines.push(q.prompt);

  const rows = [
    q.options.slice(0, 2),
    q.options.slice(2, 4),
  ].filter((r) => r.length > 0);

  await api.sendMessage(userId, lines.join("\n\n"), {
    reply_markup: {
      inline_keyboard: rows.map((row) =>
        row.map((opt) => ({ text: opt, callback_data: `hv:${q.nonce}:${opt}` })),
      ),
    },
  }).catch((e) => logError("verify-send", e));
}
