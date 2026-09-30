# Tests

```sh
npm test              # all suites
node tests/run-all.mjs 03   # only suites matching "03"
```

## How this works

`tests/prepare.mjs` compiles `src/**/*.ts` to plain ESM and rewrites three
module specifiers:

| Specifier | Replacement |
|---|---|
| `grammy` | `tests/shims/grammy.js` — a recording fake Bot API client |
| `cloudflare:workers` | `tests/shims/cf.js` — a minimal `DurableObject` base |
| relative imports | same paths with `.js` added, for Node ESM |

`D1Database` and the Durable Object namespace are injected as `env` bindings
by the tests: `tests/shims/d1.js` implements the D1 surface over
`node:sqlite` (the engine D1 is built on), and `tests/shims/do.js` provides an
in-process namespace whose alarm the tests fire explicitly.

The suites then call the **real** `processUpdate`, `handleApi` and
`worker.fetch`. Only the outermost I/O boundaries are faked.

## Why not vitest-pool-workers

The official test runner starts the real `workerd` binary, which cannot launch
in some sandboxed environments. This harness trades runtime fidelity for
portability while still exercising the code where the logic actually lives:
routing, ordering, error recovery, and SQL.

What it therefore does **not** cover: real `workerd` semantics, actual Durable
Object placement and hibernation, and D1's network behaviour. Those are
verified by `npm run dry-run` plus a real deployment.

## Suites

| File | Covers |
|---|---|
| `00-units.mjs` | settings validation, text formatting, HTML escaping |
| `00b-crypto.mjs` | key derivation parity with `scripts/`, constant-time compare, token format |
| `00c-schema.mjs` | migration idempotency, constraints, indexes, every SQL shape in `db.ts`, full migration chain |
| `01-inbound.mjs` | topic creation, info card, forwarding, dedup, `/start`, ban drop |
| `02-outbound.mjs` | `copyMessage` (never forward), reply quoting, stale-reply fallback, blocked users |
| `03-commands.mjs` | `/claim` `/login` `/revoke` `/ban` `/unban` `/info` `/del` `/id`, authorisation |
| `04-media-ratelimit.mjs` | album buffering and flush, dedup, partial-send safety, rate limiting |
| `05-edits-membership.mjs` | edit mirroring both ways, block/unblock, group candidates, topic recovery |
| `06-auth.mjs` | webhook secret checks, nonce redemption and replay, session forgery, cookie flags |
| `07-api.mjs` | every `/api/*` route, auth gate, settings validation, bind probing, CSRF origin check |
| `08-reactions.mjs` | private-chat reaction updates, mirrored reactions, allowed_updates, auth, fallback rules |
| `09-human-verify.mjs` | typed arithmetic challenge flow, full-width answers, too-fast rejection, `/start` refreshes, escalating cooldown, verification gate in private chats |

## Notable invariants under test

- **Outbound never forwards.** `forwardMessage` would show "Forwarded from
  &lt;relay group&gt;" to the correspondent, leaking the group name and the
  architecture. `02-outbound.mjs` asserts `forwardMessage` is never called.
- **The webhook always answers 2xx.** A non-2xx makes Telegram redeliver an
  update that may have been partly handled. Asserted for malformed JSON and for
  a failing Bot API call.
- **`owner_id` is not writable through the API.** It is the trust root that
  authorises the console; letting the console edit it would be circular.
- **Settings apply atomically.** A batch containing any invalid value is
  rejected whole, so a half-applied configuration is impossible.
- **Cookies are host-only.** `workers.dev` is on the Public Suffix List, so a
  `Domain` attribute would share the session with every other Worker on the
  same subdomain.
- **Login nonces redeem exactly once.** The `DELETE` is the atomic claim.
- **Album grouping survives.** Items are buffered by `media_group_id` and
  re-emitted through `forwardMessages`/`copyMessages` with strictly increasing
  ids; a length mismatch in the response records no mappings rather than wrong
  ones.
- **Reaction sync is opt-in.** `message_reaction` is not in Telegram's default
  webhook subscription set, so enabling the feature requires re-registering the
  webhook with that update type included. The tests assert the request list and
  the mirror rules.
- **Human verification blocks first contact.** An unverified user never reaches
  the relay path: `/start` yields a typed challenge, ordinary messages are
  reminded rather than charged, two wrong answers trigger a temporary cooldown,
  and that cooldown doubles on every repeat failure cycle.
- **The challenge cannot be guessed or reset.** No inline keyboard is sent, so
  there is no one-in-four blind guess, and `/start` refreshes the question
  without clearing the failure count or the rounds already passed.
