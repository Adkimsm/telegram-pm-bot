#!/usr/bin/env node
/**
 * Manage the Telegram webhook from the command line.
 *
 *   node scripts/webhook.mjs info
 *   node scripts/webhook.mjs set <https://your-worker.workers.dev>
 *   node scripts/webhook.mjs delete
 *
 * The web console can do the same thing, but that requires a working session —
 * and getting one requires a working webhook. This script breaks that cycle
 * during first deployment.
 *
 * Both the URL path segment and the secret_token are derived from BOT_TOKEN, so
 * they always match what the Worker computes; nothing needs configuring.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Must stay in sync with src/bot/index.ts ALLOWED_UPDATES.
// Telegram keeps the previous setting when the field is omitted, so it is
// always sent explicitly.
const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "my_chat_member",
];

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function readToken() {
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN.trim();

  let content;
  try {
    content = readFileSync(join(root, ".dev.vars"), "utf8");
  } catch {
    fail("No .dev.vars and BOT_TOKEN is not set. See README step 2.");
  }

  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0 && t.slice(0, eq).trim() === "BOT_TOKEN") {
      return t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  fail("BOT_TOKEN not found in .dev.vars");
}

const [command, arg] = process.argv.slice(2);

// Print usage before touching .dev.vars, so `webhook.mjs` with no arguments is
// helpful rather than complaining about a missing token.
if (command !== "info" && command !== "set" && command !== "delete") {
  console.log(`
Usage:
  node scripts/webhook.mjs info
  node scripts/webhook.mjs set <https://your-worker.workers.dev>
  node scripts/webhook.mjs delete

Or via npm:
  npm run webhook-info
  npm run set-webhook -- <url>
  npm run del-webhook
`);
  process.exit(command ? 1 : 0);
}

const token = readToken();
const secret = createHmac("sha256", token)
  .update("pmbot:webhook:v1")
  .digest("hex");

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!data.ok) fail(`${method} failed: ${data.description}`);
  return data.result;
}

switch (command) {
  case "info": {
    const me = await call("getMe");
    const info = await call("getWebhookInfo");
    console.log(`\nBot: @${me.username} (id ${me.id})`);
    console.log(`Webhook URL:      ${info.url || "(not set)"}`);
    console.log(`Pending updates:  ${info.pending_update_count ?? 0}`);
    console.log(`Allowed updates:  ${(info.allowed_updates ?? ["(default)"]).join(", ")}`);
    if (info.last_error_message) {
      console.log(
        `Last error:       ${info.last_error_message} ` +
          `(${new Date((info.last_error_date ?? 0) * 1000).toISOString()})`,
      );
    }
    console.log(`\nExpected path:    /tg/${secret}\n`);
    break;
  }

  case "set": {
    if (!arg) {
      fail(
        "Usage: node scripts/webhook.mjs set https://pmbot.<subdomain>.workers.dev\n" +
          "(the URL printed by `wrangler deploy`)",
      );
    }
    let base;
    try {
      base = new URL(arg);
    } catch {
      fail(`Not a valid URL: ${arg}`);
    }
    if (base.protocol !== "https:") fail("Telegram requires an HTTPS webhook URL.");

    const url = `${base.origin}/tg/${secret}`;
    await call("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ALLOWED_UPDATES,
    });

    const me = await call("getMe");
    console.log(`\n✓ Webhook set for @${me.username}`);
    console.log(`  ${url}\n`);
    console.log("Next: send /claim <code> to the bot (npm run claim-code).\n");
    break;
  }

  case "delete": {
    await call("deleteWebhook", { drop_pending_updates: false });
    console.log("\n✓ Webhook deleted. The bot will not receive updates.\n");
    break;
  }
}
