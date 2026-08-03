# pmbot

Telegram 私信中转机器人。陌生人和 bot 私聊，消息落到你的中转群里、每人一个话题；你在话题内直接回复即可回信。

跑在 Cloudflare Workers 免费版，配套一个网页控制台。

## 特性

- **陌生人侧完全正常**——就是一个普通的 bot 私聊，看不出任何中转痕迹
- 每个联系人一个 forum 话题，会话天然隔离
- 首次联系发一张信息卡（ID、用户名、首次联系时间、拉黑/详情按钮）
- 全部消息类型；媒体组保持成组
- 回复带引用，对方能看到你在回哪条
- 双向编辑同步
- 拉黑、限流、用户查询
- 网页控制台管理全部配置
- **零自定义环境变量**：只有一个 `BOT_TOKEN` secret

## 前置条件

- Node.js 18+
- Cloudflare 账号（免费版即可）
- 一个 Telegram bot（向 [@BotFather](https://t.me/botfather) 发 `/newbot`）

---

## 部署

### 1. 安装依赖

```sh
npm install
npx wrangler login
```

### 2. 配置本地 token

```sh
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，填入 BotFather 给你的 token。此文件已被 gitignore。

### 3. 创建数据库

```sh
npx wrangler d1 create pmbot-db
```

把输出的 `database_id` 填进 `wrangler.jsonc` 里替换 `PLACEHOLDER_RUN_WRANGLER_D1_CREATE`，然后建表：

```sh
npm run db:migrate
```

### 4. 上传 token 并部署

```sh
npx wrangler secret put BOT_TOKEN   # 粘贴同一个 token
npm run deploy
```

记下输出的地址，形如 `https://pmbot.<你的子域>.workers.dev`。

### 5. 注册 webhook

```sh
npm run set-webhook -- https://pmbot.<你的子域>.workers.dev
```

### 6. 认领所有权

```sh
npm run claim-code
```

把打印出的命令发给你的 bot：

```
/claim <认领码>
```

Bot 会立刻删掉这条消息。认领码是 `HMAC(BOT_TOKEN, "pmbot:claim:v1")` 的前 12 位——算得出它就等于持有 token，而持有 token 本来就能重新部署整个 Worker，所以这不引入新的攻击面。同时它避免了「谁先发 `/start` 谁是主人」的抢注问题。

### 7. 准备中转群

Bot API 无法创建群组，这步必须手动：

1. 新建一个群组
2. 群组设置里**开启话题**（Topics）——开启后会升级为超级群
3. 把 bot 加入该群，设为**管理员**
4. 管理员权限中勾选**「管理话题」**（Manage topics）

Bot 会自动检测到这个群。

### 8. 绑定

给 bot 发 `/login`，点开链接进入控制台，在候选群列表里点「绑定」。

绑定时服务端会重新探测该群是否真的开启了话题、bot 是否真的有权限，不合格会明确拒绝并说明原因——避免绑定后才发现消息转发不了。

完成。

---

## 使用

### 你的私聊（控制台）

| 命令 | 作用 |
|---|---|
| `/login` | 一次性网页控制台链接（2 分钟有效，单次使用） |
| `/status` | 当前配置 |
| `/revoke` | 失效所有网页会话 |
| `/claim <码>` | （重新）认领所有权 |
| `/help` | 命令列表 |

`/login` 可无限次重发。因为 nonce 单次有效，在 Telegram 内置浏览器打开后桌面上就用不了同一条链接——桌面上再发一次 `/login` 即可。

### 中转群话题内

| 命令 | 作用 |
|---|---|
| `/ban [id] [原因]` | 拉黑（话题内可省略 id） |
| `/unban [id]` | 解除拉黑 |
| `/bans` | 黑名单列表 |
| `/info [id]` | 身份与统计 |
| `/del` | 回复某条消息后发送，双侧删除 |
| `/id` | 显示当前群组与话题 ID |

直接在话题里发消息即回复对应的陌生人。回复某条转发消息时，对方会看到引用。

---

## 已知限制

这些是 Telegram Bot API 的硬限制，不是实现取舍：

- **删除无法自动同步。** `Update` 里只有 `deleted_business_messages`，仅限 Business 账号连接，普通私聊和群组都没有删除事件。任一方撤回消息，bot 都收不到通知。用 `/del` 代替。
- **删除限 48 小时内。** Telegram 拒绝删除更早的消息。
- **发送者始终显示为 bot**，无法伪装成你的账号。
- **无已读回执。** Bot 既不能标记已读，也不能让对方看到已读状态。
- **你发的相册无法作为引用回复。** `copyMessages` 不接受 `reply_parameters`。
- **话题无法关闭归档。** `closeForumTopic` 对私聊话题不可用；中转群方案可以关闭，但重开后消息仍会落回原话题。
- **无法列出话题。** Bot API 没有这个方法，D1 里的映射表是唯一真相来源。

---

## 运维

### 日常

```sh
npm test                # 全部测试（305 项）
npm run check           # 类型检查 + 测试 + 构建检查
npm run tail            # 实时日志
npm run webhook-info    # webhook 健康检查
```

控制台的「运维」页有 webhook 状态、待投递更新数、最近错误，以及重设按钮。

测试的设计与覆盖范围见 [tests/README.md](tests/README.md)。

### 数据库迁移

新增 schema 变更时，在 `migrations/` 下新建 `000N_描述.sql`，然后：

```sh
npm run db:migrate
```

### 备份与恢复

D1 Time Travel 始终开启，免费版可回溯 **7 天**，无需配置：

```sh
npx wrangler d1 time-travel info pmbot-db
npx wrangler d1 time-travel restore pmbot-db --timestamp=2026-08-04T10:00:00Z
```

恢复是**破坏性**操作，会原地覆盖数据库。它会返回一个 bookmark 供你撤销。

### 丢失控制台访问

重新执行第 6 步的认领流程。这是设计好的恢复路径。

### 更换 bot token

Webhook 密钥、session 密钥、认领码全部由 token 派生，所以换 token 会自动失效这三者。换完需要：

```sh
npx wrangler secret put BOT_TOKEN
npm run set-webhook -- https://pmbot.<你的子域>.workers.dev
```

### 免费额度

| 资源 | 免费额度 | 本项目消耗 |
|---|---|---|
| Worker 请求 | 100,000/天 | 每条消息约 1 次；静态资源不计入 |
| Worker CPU | 10ms/请求 | 约 2-3ms（等待网络不计入 CPU） |
| D1 行写入 | 100,000/天 | 每条消息约 3 行 → 约 33,000 条/天 |
| D1 行读取 | 5,000,000/天 | 远超所需 |
| D1 存储 | 5 GB | 每条消息约 100 字节 |
| DO 请求 | 100,000/天 | 仅媒体组用到 |
| DO 时长 | 13,000 GB-s/天 | 每个相册约 1.2 秒 |

每日 cron 会清理过期的去重记录、会话、登录令牌，以及 60 天前的消息映射。

---

## 安全设计

- 唯一 secret 是 `BOT_TOKEN`。webhook 密钥、session 密钥、认领码全部由它按不同标签 HMAC 派生，互不共享密钥材料
- Webhook 双重校验：路径段不可猜 + `X-Telegram-Bot-Api-Secret-Token` 头，均为常量时间比较
- Session token 形如 `<随机>.<HMAC>`。HMAC 让伪造 token 无需查库即被拒；数据库行使吊销成为可能。两者都必须通过
- 数据库只存 session token 和登录 nonce 的 SHA-256，泄库无法直接换取会话
- Cookie 为 host-only（不带 `Domain` 属性）。`workers.dev` 在 Public Suffix List 上，带 `Domain` 会把 cookie 泄露给你账号下其他 Worker
- 登录 nonce 的兑现即 `DELETE`，用原子性关掉并发重放窗口
- 所有 `/api/*` 路由都要求会话，包括只读路由
- 非 GET 请求校验 `Origin` 同源，补上 `SameSite=Lax` 覆盖不到的缺口
- 所有权转移会吊销全部会话，并通知原所有者
- 内联按钮的授权只看 `callback_query.from.id`，不信 payload

## 项目结构

```
src/
  index.ts              入口：webhook / auth / api / 静态资源 路由
  bot/
    index.ts            update 分发、去重、my_chat_member
    inbound.ts          陌生人 -> 话题（建话题、信息卡、限流）
    outbound.ts         话题 -> 陌生人（copyMessage + 引用）
    commands.ts         全部命令与内联按钮
    edits.ts            编辑同步
    context.ts          共享上下文
  api/index.ts          管理 API
  lib/
    crypto.ts           密钥派生、常量时间比较
    db.ts               D1 数据访问
    settings.ts         配置加载与校验
    auth.ts             nonce、session、cookie
    media-group.ts      媒体组聚合 Durable Object
    format.ts           文本格式化
    types.ts            类型定义
public/                 网页控制台（原生 HTML/JS，无构建步骤）
migrations/             D1 schema
scripts/                claim-code / webhook 命令行工具
tests/                  测试套件（见 tests/README.md）
```
