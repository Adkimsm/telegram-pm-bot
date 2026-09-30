import { randomToken } from "./crypto";

export interface ArithmeticChallenge {
  prompt: string;
  answer: string;
  nonce: string;
}

/**
 * Generate a simple arithmetic challenge that is annoying for bots but nearly
 * frictionless for humans on mobile.
 *
 * We avoid division to keep the answer integral and avoid operator-precedence
 * traps; difficulty comes from mild distraction, not from tricky maths.
 *
 * The answer is never offered as a set of choices. A four-option keyboard gave
 * a one-in-four chance of passing by blind luck, which made the gate useless
 * against scripted accounts; the caller now has to ask the user to type the
 * answer, and the challenge is compared server-side.
 */
export function makeArithmeticChallenge(): ArithmeticChallenge {
  const kinds = ["add", "sub", "mul"] as const;
  const kind = kinds[Math.floor(Math.random() * kinds.length)]!;

  let a = 0;
  let b = 0;
  let answer = 0;
  let symbol = "+";

  switch (kind) {
    case "add":
      a = randInt(2, 19);
      b = randInt(2, 19);
      answer = a + b;
      symbol = "+";
      break;
    case "sub":
      a = randInt(6, 24);
      b = randInt(1, a - 1);
      answer = a - b;
      symbol = "-";
      break;
    case "mul":
      a = randInt(2, 9);
      b = randInt(2, 9);
      answer = a * b;
      symbol = "×";
      break;
  }

  return {
    prompt: `请完成验证：${a} ${symbol} ${b} = ?`,
    answer: String(answer),
    nonce: randomToken(10),
  };
}

/**
 * Normalise a typed answer before comparing it with the stored one.
 *
 * People on mobile keyboards routinely produce full-width digits (`１５`), a
 * typographic minus (`−`), or a stray leading `=`, none of which should cost
 * them a verification attempt. NFKC folds the full-width forms to ASCII; the
 * rest is handled explicitly.
 */
export function normalizeAnswer(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/\s+/g, "")
    .replace(/^=+/, "");
}

/**
 * True when the text is plausibly an answer attempt rather than ordinary chat.
 *
 * This keeps the flow forgiving: someone who ignores the challenge and types
 * their actual message gets a reminder instead of burning an attempt. A bot
 * still has to send a number eventually, and every number it sends is either
 * right or costs it one of its attempts.
 */
export function looksLikeAnswer(raw: string): boolean {
  return /^-?\d{1,6}$/.test(normalizeAnswer(raw));
}

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}