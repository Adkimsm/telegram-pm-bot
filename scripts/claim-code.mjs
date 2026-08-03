#!/usr/bin/env node
/**
 * Print the claim code for this bot.
 *
 * The code is HMAC-SHA256(BOT_TOKEN, "pmbot:claim:v1") truncated to 12 hex
 * characters. Computing it requires the bot token, and anyone holding the
 * token could redeploy the Worker anyway, so gating ownership on it adds no
 * attack surface — unlike a first-come `/start`, which is trivially squatted.
 *
 * The token is read from .dev.vars and never leaves this machine.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readToken() {
  // An explicit env var wins, so this works in CI or a one-off shell too.
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN.trim();

  let content;
  try {
    content = readFileSync(join(root, ".dev.vars"), "utf8");
  } catch {
    fail(
      "No .dev.vars found and BOT_TOKEN is not set.\n\n" +
        "  cp .dev.vars.example .dev.vars\n" +
        "  # then put your bot token in it\n\n" +
        "Or run:  BOT_TOKEN=123:abc npm run claim-code",
    );
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() === "BOT_TOKEN") {
      return trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }

  fail("BOT_TOKEN not found in .dev.vars");
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

const token = readToken();

if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
  fail(
    `BOT_TOKEN does not look like a Telegram bot token: ${token.slice(0, 12)}…\n` +
      "Expected the form 123456789:AA...",
  );
}

const code = createHmac("sha256", token)
  .update("pmbot:claim:v1")
  .digest("hex")
  .slice(0, 12);

console.log(`
Claim code: ${code}

Send this to your bot in a private chat:

    /claim ${code}

The bot deletes the message immediately afterwards, and the code stays valid
until you rotate the bot token. Re-running /claim later transfers ownership,
which is the recovery path if you lose access to your account.
`);
