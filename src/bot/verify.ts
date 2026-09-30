import type { Message } from "grammy/types";
import {
  applyVerificationBan,
  bumpVerificationFailure,
  getVerificationState,
  now,
  resetExpiredChallenge,
  saveVerificationChallenge,
  setVerified,
  touchUser,
} from "../lib/db";
import type { Settings } from "../lib/types";
import { looksLikeAnswer, makeArithmeticChallenge, normalizeAnswer } from "../lib/verify";
import type { BotContext } from "./context";
import { logError } from "./context";

type VerificationState = NonNullable<
  Awaited<ReturnType<typeof getVerificationState>>
>;

/** Upper bound on the escalated cooldown, in seconds (24 hours). */
const MAX_BAN_SECONDS = 24 * 3600;

/**
 * Intercept private-chat messages until the user passes verification.
 *
 * Returns true when the message has been fully handled and must not proceed to
 * the normal relay path.
 *
 * The challenge is answered by typing the result back as a message. An inline
 * keyboard would be a single tap with a one-in-four chance of being right by
 * luck, which is not a gate at all; a typed answer has to be read and
 * understood. Progress and failure counts deliberately survive a `/start`
 * refresh — otherwise the attempt limit can be reset at will.
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

  let pending =
    state?.verify_state === "pending" && (state?.verify_expires_at ?? 0) > ts;
  let attempts = state?.verify_attempts ?? 0;
  let step = state?.verify_step ?? 0;

  if (!pending && state?.verify_state === "pending") {
    // The challenge lapsed. Start the cycle over, but keep the strike history
    // so repeated offenders keep their longer cooldowns.
    await resetExpiredChallenge(env, from.id);
    attempts = 0;
    step = 0;
  }

  if (msg.text?.startsWith("/start")) {
    await sendChallenge(ctx, from.id, true, attempts, step);
    return true;
  }

  if (pending) {
    const text = msg.text ?? "";

    // Ordinary chat is not an answer: remind, but do not spend an attempt.
    if (!looksLikeAnswer(text)) {
      await api
        .sendMessage(
          from.id,
          "请直接回复这道题的答案（只发数字）。想换一题就发送 /start。",
        )
        .catch((e) => logError("verify-remind", e));
      return true;
    }

    if (ts - state!.verify_issued_at < settings.humanVerifyMinSeconds) {
      await recordFailure(ctx, state!, from.id, "fast");
      return true;
    }

    if (normalizeAnswer(text) === state!.verify_answer) {
      if (step + 1 >= settings.humanVerifyRounds) {
        await setVerified(env, from.id);
        await api
          .sendMessage(from.id, "✅ 验证通过。现在请重新发送你的消息。")
          .catch((e) => logError("verify-pass-msg", e));
        return true;
      }
      // Correct so far: hand out the next question, keeping the failure count
      // and the progress made.
      await sendChallenge(ctx, from.id, false, attempts, step + 1);
      return true;
    }

    await recordFailure(ctx, state!, from.id, "wrong");
    return true;
  }

  // Before verification, every ordinary message is stopped here. The user was
  // expected to come in via /start and then solve the challenge before sending
  // anything meaningful, so there is no buffering or replay path.
  await sendChallenge(ctx, from.id, false, attempts, step);
  return true;
}

/**
 * Count a failed answer and either re-issue the challenge or start a cooldown.
 *
 * `reason` only changes the wording; both a wrong answer and one that arrived
 * impossibly fast cost the same attempt.
 */
async function recordFailure(
  ctx: BotContext,
  state: VerificationState,
  userId: number,
  reason: "wrong" | "fast",
): Promise<void> {
  const { env, api, settings } = ctx;

  if (state.verify_attempts + 1 >= settings.humanVerifyMaxAttempts) {
    const until = now() + cooldownSeconds(settings, state.verify_strikes);
    await applyVerificationBan(env, userId, until);
    const minutes = Math.max(1, Math.round((until - now()) / 60));
    await api
      .sendMessage(
        userId,
        `验证失败过多，已临时限制 ${minutes} 分钟。`,
      )
      .catch((e) => logError("verify-ban", e));
    return;
  }

  const attempts = await bumpVerificationFailure(env, userId);
  const remaining = settings.humanVerifyMaxAttempts - attempts;
  await api
    .sendMessage(
      userId,
      reason === "fast"
        ? `作答过快，已记为一次失败；还剩 ${remaining} 次机会。`
        : `答案错误，还剩 ${remaining} 次机会。`,
    )
    .catch((e) => logError("verify-wrong", e));

  await sendChallenge(ctx, userId, false, attempts, state.verify_step);
}

/**
 * Cooldown length for a failure cycle.
 *
 * Each completed cycle doubles the wait, capped at a day: a script retrying
 * forever is eventually reduced to a handful of guesses per day. The very
 * first failure is exactly `humanVerifyBanMinutes` because `strikes` starts
 * at 0.
 */
function cooldownSeconds(settings: Settings, strikes: number): number {
  const base = settings.humanVerifyBanMinutes * 60;
  if (!settings.humanVerifyEscalate) return base;
  // Cap the exponent before it can overflow; the result is clamped anyway.
  const grown = base * 2 ** Math.min(Math.max(strikes, 0), 20);
  return Math.min(grown, MAX_BAN_SECONDS);
}

export async function sendChallenge(
  ctx: BotContext,
  userId: number,
  includeWelcome: boolean,
  attempts = 0,
  step = 0,
): Promise<void> {
  const { env, api, settings } = ctx;
  const ts = now();
  const q = makeArithmeticChallenge();

  await saveVerificationChallenge(
    env,
    userId,
    {
      nonce: q.nonce,
      answer: q.answer,
      expiresAt: ts + settings.humanVerifyTimeout,
      issuedAt: ts,
    },
    attempts,
    step,
  );

  const lines: string[] = [];
  if (includeWelcome && settings.welcomeText) lines.push(settings.welcomeText);
  if (settings.humanVerifyPrompt) lines.push(settings.humanVerifyPrompt);
  lines.push(q.prompt);
  lines.push(
    settings.humanVerifyRounds > 1
      ? `请直接回复答案数字（第 ${step + 1}/${settings.humanVerifyRounds} 题）。`
      : "请直接回复答案数字。",
  );

  // No reply_markup: the answer is typed, not picked from a list.
  await api
    .sendMessage(userId, lines.join("\n\n"))
    .catch((e) => logError("verify-send", e));
}