import { randomToken } from "./crypto";

export interface ArithmeticChallenge {
  prompt: string;
  options: string[];
  answer: string;
  nonce: string;
}

/**
 * Generate a simple arithmetic challenge that is annoying for bots but nearly
 * frictionless for humans on mobile.
 *
 * We avoid division to keep the answer integral and avoid operator-precedence
 * traps; difficulty comes from mild distraction, not from tricky maths.
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

  const wrong = new Set<number>();
  while (wrong.size < 3) {
    const delta = randInt(-6, 6) || 2;
    const candidate = answer + delta;
    if (candidate > 0 && candidate !== answer) wrong.add(candidate);
  }

  const options = shuffle([String(answer), ...[...wrong].map(String)]);

  return {
    prompt: `请完成验证：${a} ${symbol} ${b} = ?`,
    options,
    answer: String(answer),
    nonce: randomToken(10),
  };
}

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
