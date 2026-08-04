"use strict";

// pmbot admin console.
// Plain ES modules-free script: no build step, no framework. The whole console
// is a handful of fetches against /api/* plus direct DOM updates.

const state = {
  overview: null,
  users: { rows: [], total: 0, limit: 50, offset: 0, q: "" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
function toast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = kind), 3200);
}

/**
 * Wrapper around fetch for the admin API.
 *
 * A 401 means the session is gone; reloading lets the server-rendered error
 * page explain how to get a new login link rather than leaving a dead UI.
 */
async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, {
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    ...options,
  });

  if (res.status === 401) {
    document.body.innerHTML =
      '<main style="padding:2rem;text-align:center">' +
      "<h1>会话已失效</h1><p>请在 Telegram 中向 bot 发送 <code>/login</code> 获取新的登录链接。</p>" +
      "</main>";
    throw new Error("unauthenticated");
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const msg = data.error || (data.errors && data.errors.join("; ")) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function relTime(unix) {
  if (!unix) return "-";
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function absTime(unix) {
  if (!unix) return "-";
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function initTabs() {
  $$('nav [role="tab"]').forEach((tab) => {
    tab.addEventListener("click", () => {
      $$('nav [role="tab"]').forEach((t) =>
        t.setAttribute("aria-selected", String(t === tab)),
      );
      $$(".panel").forEach((p) =>
        p.classList.toggle("active", p.id === `panel-${tab.dataset.panel}`),
      );

      // Load lazily so the initial page paint is not gated on every table.
      if (tab.dataset.panel === "users" && state.users.rows.length === 0) loadUsers();
      if (tab.dataset.panel === "bans") loadBans();
      if (tab.dataset.panel === "maintenance") checkWebhook();
    });
  });
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

async function loadOverview() {
  const data = await api("overview");
  state.overview = data;

  renderReadyBadge(data);
  renderSetupNotice(data);
  renderStats(data.stats);
  renderRelayStatus(data);
  fillSettingsForm(data.settings);
  await loadCandidates();
}

function renderReadyBadge(data) {
  const el = $("#ready-badge");
  if (data.ready) {
    el.className = "badge ok";
    el.textContent = "运行中";
  } else {
    el.className = "badge warn";
    el.textContent = "待配置";
  }
}

/** Show only the next actionable step, so the checklist is never noise. */
function renderSetupNotice(data) {
  const el = $("#setup-notice");

  if (data.ready) {
    el.innerHTML = "";
    return;
  }

  if (!data.settings.relayChatId) {
    el.innerHTML =
      '<div class="notice warn"><b>还需绑定中转群。</b> ' +
      "陌生人的消息需要一个开启了话题的群组作为落点。按下面的步骤准备好后绑定即可。</div>";
    $("#relay-help").open = true;
    return;
  }

  el.innerHTML = `<div class="notice err"><b>中转群不可用。</b> ${esc(
    data.relayCheck.detail,
  )}</div>`;
  $("#relay-help").open = true;
}

function renderStats(s) {
  const items = [
    ["用户总数", s.users],
    ["24 小时活跃", s.activeToday],
    ["会话话题", s.topics],
    ["消息总数", s.messagesTotal],
    ["黑名单", s.banned],
    ["消息映射", s.mappings],
  ];
  $("#stats").innerHTML = items
    .map(
      ([label, value]) =>
        `<div class="stat"><div class="value">${value}</div><div class="label">${label}</div></div>`,
    )
    .join("");
}

function renderRelayStatus(data) {
  const el = $("#relay-status");
  const id = data.settings.relayChatId;

  if (!id) {
    el.innerHTML = '<span class="badge warn">未绑定</span>';
    return;
  }

  const c = data.relayCheck;
  const badge = c.ok
    ? '<span class="badge ok">就绪</span>'
    : '<span class="badge err">异常</span>';

  el.innerHTML = `
    <div class="row" style="margin-bottom:0.5rem">
      ${badge}
      ${c.title ? `<b>${esc(c.title)}</b>` : ""}
      <code>${id}</code>
    </div>
    <div class="muted">${esc(c.detail)}</div>
    <div class="row" style="margin-top:0.6rem">
      <span class="badge ${c.isForum ? "ok" : "err"}">话题 ${c.isForum ? "已开启" : "未开启"}</span>
      <span class="badge ${c.canManageTopics ? "ok" : "err"}">管理话题权限 ${
        c.canManageTopics ? "已授予" : "缺失"
      }</span>
      <button class="btn secondary" id="btn-unbind">解除绑定</button>
    </div>`;

  $("#btn-unbind").addEventListener("click", async () => {
    if (!confirm("解除绑定后消息将无处投递，确定吗？")) return;
    try {
      await api("settings", {
        method: "PUT",
        body: JSON.stringify({ relay_chat_id: "" }),
      });
      toast("已解除绑定", "ok");
      await loadOverview();
    } catch (e) {
      toast(e.message, "err");
    }
  });
}

async function loadCandidates() {
  const el = $("#candidates");
  try {
    const { chats } = await api("chats");
    if (chats.length === 0) {
      el.innerHTML =
        '<div class="empty">尚未检测到任何群组。把 bot 加入群组后会自动出现在这里。</div>';
      return;
    }

    const bound = state.overview?.settings.relayChatId;

    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>群组</th><th>ID</th><th>话题</th><th>权限</th><th></th></tr></thead>
      <tbody>${chats
        .map((c) => {
          const isBound = String(c.chat_id) === String(bound);
          const eligible = c.is_forum && c.can_manage_topics;
          return `<tr>
            <td>${esc(c.title || "(无标题)")}</td>
            <td class="num"><code>${c.chat_id}</code></td>
            <td><span class="badge ${c.is_forum ? "ok" : "err"}">${
              c.is_forum ? "已开启" : "未开启"
            }</span></td>
            <td><span class="badge ${c.can_manage_topics ? "ok" : "err"}">${
              c.can_manage_topics ? "管理员" : "不足"
            }</span></td>
            <td>${
              isBound
                ? '<span class="badge ok">已绑定</span>'
                : `<button class="btn ${eligible ? "" : "secondary"}" data-bind="${
                    c.chat_id
                  }">绑定</button>`
            }</td>
          </tr>`;
        })
        .join("")}</tbody></table></div>`;

    el.querySelectorAll("[data-bind]").forEach((btn) => {
      btn.addEventListener("click", () => bindChat(btn.dataset.bind));
    });
  } catch (e) {
    el.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

async function bindChat(chatId) {
  try {
    // The server re-probes the group before accepting, so an ineligible group
    // is rejected with a specific reason rather than silently breaking relaying.
    await api("bind", { method: "POST", body: JSON.stringify({ chat_id: chatId }) });
    toast("绑定成功", "ok");
    await loadOverview();
  } catch (e) {
    toast(e.message, "err");
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function fillSettingsForm(s) {
  $("#s-welcome_text").value = s.welcomeText ?? "";
  $("#s-forward_mode").value = s.forwardMode ?? "forward";
  $("#s-media_group_enabled").checked = !!s.mediaGroupEnabled;
  $("#s-sync_edits").checked = !!s.syncEdits;
  $("#s-sync_reactions").checked = !!s.syncReactions;
  $("#s-rate_limit_enabled").checked = !!s.rateLimitEnabled;
  $("#s-rate_limit_max").value = s.rateLimitMax ?? 20;
  $("#s-rate_limit_window").value = s.rateLimitWindow ?? 60;
}

async function saveSettings() {
  const payload = {};
  $$("[data-key]").forEach((el) => {
    payload[el.dataset.key] = el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value;
  });

  const btn = $("#btn-save-settings");
  btn.disabled = true;
  try {
    // The server validates every field and rejects the whole request on any
    // error, so a partial configuration can never be persisted.
    await api("settings", { method: "PUT", body: JSON.stringify(payload) });
    toast("设置已保存", "ok");
    $("#settings-saved").textContent = `已保存 ${new Date().toLocaleTimeString()}`;
    await loadOverview();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function loadUsers() {
  const { q, limit, offset } = state.users;
  const params = new URLSearchParams({ limit, offset });
  if (q) params.set("q", q);

  try {
    const data = await api(`users?${params}`);
    state.users.rows = data.users;
    state.users.total = data.total;
    renderUsers();
  } catch (e) {
    $("#users-table").innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

function renderUsers() {
  const { rows, total, offset, limit } = state.users;
  const el = $("#users-table");

  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">没有匹配的用户。</div>';
    $("#users-range").textContent = "0 / 0";
    return;
  }

  el.innerHTML = `<table>
    <thead><tr>
      <th>姓名</th><th>ID</th><th>用户名</th><th>消息</th>
      <th>最近活动</th><th>状态</th><th></th>
    </tr></thead>
    <tbody>${rows
      .map((u) => {
        const flags = [];
        if (u.banned) flags.push('<span class="badge err">已拉黑</span>');
        if (u.blocked_bot) flags.push('<span class="badge warn">已屏蔽 bot</span>');
        if (!u.thread_id) flags.push('<span class="badge">无话题</span>');
        return `<tr>
          <td>${esc(u.display_name)}</td>
          <td class="num"><code>${u.user_id}</code></td>
          <td>${u.username ? "@" + esc(u.username) : '<span class="muted">-</span>'}</td>
          <td class="num">${u.msg_count}</td>
          <td title="${absTime(u.last_seen)}">${relTime(u.last_seen)}</td>
          <td>${flags.join(" ") || '<span class="badge ok">正常</span>'}</td>
          <td>${
            u.banned
              ? `<button class="btn secondary" data-unban="${u.user_id}">解除</button>`
              : `<button class="btn danger" data-ban="${u.user_id}">拉黑</button>`
          }</td>
        </tr>`;
      })
      .join("")}</tbody></table>`;

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  $("#users-range").textContent = `${from}–${to} / ${total}`;
  $("#btn-prev").disabled = offset === 0;
  $("#btn-next").disabled = to >= total;

  el.querySelectorAll("[data-ban]").forEach((b) =>
    b.addEventListener("click", () => banUser(b.dataset.ban, "")),
  );
  el.querySelectorAll("[data-unban]").forEach((b) =>
    b.addEventListener("click", () => unbanUser(b.dataset.unban)),
  );
}

// ---------------------------------------------------------------------------
// Bans
// ---------------------------------------------------------------------------

async function loadBans() {
  const el = $("#bans-table");
  try {
    const { bans } = await api("bans");
    if (bans.length === 0) {
      el.innerHTML = '<div class="empty">黑名单为空。</div>';
      return;
    }
    el.innerHTML = `<table>
      <thead><tr><th>姓名</th><th>ID</th><th>原因</th><th>时间</th><th></th></tr></thead>
      <tbody>${bans
        .map(
          (b) => `<tr>
            <td>${esc(b.first_name || "?")}${
              b.username ? ' <span class="muted">@' + esc(b.username) + "</span>" : ""
            }</td>
            <td class="num"><code>${b.user_id}</code></td>
            <td>${esc(b.reason) || '<span class="muted">-</span>'}</td>
            <td title="${absTime(b.banned_at)}">${relTime(b.banned_at)}</td>
            <td><button class="btn secondary" data-unban="${b.user_id}">解除</button></td>
          </tr>`,
        )
        .join("")}</tbody></table>`;

    el.querySelectorAll("[data-unban]").forEach((btn) =>
      btn.addEventListener("click", () => unbanUser(btn.dataset.unban)),
    );
  } catch (e) {
    el.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

async function banUser(userId, reason) {
  try {
    await api("bans", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, reason }),
    });
    toast(`已拉黑 ${userId}`, "ok");
    await Promise.all([loadUsers(), loadBans()]);
  } catch (e) {
    toast(e.message, "err");
  }
}

async function unbanUser(userId) {
  try {
    await api("bans", { method: "DELETE", body: JSON.stringify({ user_id: userId }) });
    toast(`已解除 ${userId}`, "ok");
    await Promise.all([loadUsers(), loadBans()]);
  } catch (e) {
    toast(e.message, "err");
  }
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

async function checkWebhook() {
  const el = $("#webhook-status");
  el.innerHTML = '<span class="muted">检查中…</span>';

  try {
    const data = await api("webhook");
    const info = data.info || {};
    const rows = [
      ["当前地址", info.url ? `<code>${esc(info.url)}</code>` : '<span class="badge err">未设置</span>'],
      ["期望地址", `<code>${esc(data.expected)}</code>`],
      [
        "状态",
        data.matches
          ? '<span class="badge ok">一致</span>'
          : '<span class="badge err">不一致，请重设</span>',
      ],
      ["待投递更新", String(info.pending_update_count ?? 0)],
    ];

    // last_error_message is the single most useful field for diagnosing a
    // broken deployment, so surface it prominently when present.
    if (info.last_error_message) {
      rows.push([
        "最近错误",
        `<span class="badge err">${esc(info.last_error_message)}</span> ` +
          `<span class="muted">${absTime(info.last_error_date)}</span>`,
      ]);
    }
    if (info.allowed_updates) {
      rows.push(["订阅类型", `<code>${esc(info.allowed_updates.join(", "))}</code>`]);
    }

    el.innerHTML = `<table><tbody>${rows
      .map(([k, v]) => `<tr><th style="width:9rem">${k}</th><td>${v}</td></tr>`)
      .join("")}</tbody></table>`;

    // Reaction sync is silently inert unless message_reaction is subscribed,
    // and Telegram keeps the previous allowed_updates when the field is
    // omitted — so enabling the setting alone is not enough.
    const wantsReactions = state.overview?.settings.syncReactions;
    const subscribed = (info.allowed_updates ?? []).includes("message_reaction");
    if (wantsReactions && !subscribed) {
      el.insertAdjacentHTML(
        "beforeend",
        '<div class="notice warn" style="margin-top:0.9rem">' +
          "<b>表情同步已开启，但 Webhook 未订阅 <code>message_reaction</code>。</b> " +
          "点击下方「重设 Webhook」后生效。</div>",
      );
    } else if (wantsReactions && subscribed) {
      el.insertAdjacentHTML(
        "beforeend",
        '<div class="notice ok" style="margin-top:0.9rem">' +
          "<b>表情同步已启用。</b> Webhook 已订阅 <code>message_reaction</code>。" +
          "</div>",
      );
    }
  } catch (e) {
    el.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

async function setWebhook() {
  const btn = $("#btn-webhook-set");
  btn.disabled = true;
  try {
    await api("webhook", { method: "POST" });
    toast("Webhook 已重设", "ok");
    await checkWebhook();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function runCleanup() {
  const btn = $("#btn-cleanup");
  btn.disabled = true;
  try {
    const { deleted } = await api("cleanup", { method: "POST" });
    $("#cleanup-result").innerHTML =
      '<div class="notice ok">已删除 ' +
      Object.entries(deleted)
        .map(([k, v]) => `${k}: ${v}`)
        .join("，") +
      "</div>";
    toast("清理完成", "ok");
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function initEvents() {
  $("#btn-refresh").addEventListener("click", () => boot());

  $("#btn-logout").addEventListener("click", async () => {
    await api("logout", { method: "POST" }).catch(() => {});
    location.reload();
  });

  $("#btn-save-settings").addEventListener("click", saveSettings);

  $("#btn-bind-manual").addEventListener("click", () => {
    const v = $("#manual-chat-id").value.trim();
    if (v) bindChat(v);
  });

  $("#btn-search").addEventListener("click", () => {
    state.users.q = $("#user-search").value.trim();
    state.users.offset = 0;
    loadUsers();
  });

  $("#user-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-search").click();
  });

  $("#btn-prev").addEventListener("click", () => {
    state.users.offset = Math.max(0, state.users.offset - state.users.limit);
    loadUsers();
  });

  $("#btn-next").addEventListener("click", () => {
    state.users.offset += state.users.limit;
    loadUsers();
  });

  $("#btn-ban").addEventListener("click", () => {
    const id = $("#ban-id").value.trim();
    if (!id) return toast("请填写用户 ID", "err");
    banUser(id, $("#ban-reason").value.trim());
    $("#ban-id").value = "";
    $("#ban-reason").value = "";
  });

  $("#btn-webhook-check").addEventListener("click", checkWebhook);
  $("#btn-webhook-set").addEventListener("click", setWebhook);
  $("#btn-cleanup").addEventListener("click", runCleanup);

  $("#btn-revoke-all").addEventListener("click", async () => {
    if (!confirm("所有网页会话都会失效，包括当前这个。确定吗？")) return;
    try {
      await api("revoke-all", { method: "POST" });
      location.reload();
    } catch (e) {
      toast(e.message, "err");
    }
  });
}

async function boot() {
  try {
    await loadOverview();
  } catch (e) {
    if (e.message !== "unauthenticated") toast(e.message, "err");
  }
}

initTabs();
initEvents();
boot();
