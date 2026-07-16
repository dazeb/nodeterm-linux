# Plan: Unified Remote Access — Telegram Pairing + Team Access Invite System

## Current State (audited 2026-07-16)

### Telegram Bot (`src/core/telegram-bot.ts`)
- Standalone Telegraf bot, no auth — **anyone** with the bot token can access sessions
- Commands: `/start`, `/help`, `/status`, `/terminals`, `/attach N`, `/send N <text>`
- Started via Settings → Telegram with a bot token, or `NODETERM_TELEGRAM_BOT_TOKEN` env
- Status broadcast via `IPC.telegramBotStatus` to renderer
- No pairing, no user identity, no invite capability
- Deploys minimal session info (id only — titles/cwd are undefined)

### Relay Host (existing, core of Team Access)
- `initRelayHost` (`relay-host-service.ts`) — pool of `RelayHostSession`s
- Each session goes through mutual-SAS + ConsentNotice (`relay-trust.ts`)
- `relayHost.invite({email?, projectId?})` → mints pairing token → returns `{offer, id}`
- Seat cap from license (`licensedSeats()`), reserved synchronously
- `relayHost.revoke(id)` cuts one live session
- `approved-devices-core.ts` — pinning for phone auto-approve (not used on desktop relay)

### Team Access Section (`TeamAccessSection.tsx`)
- Invite with email → generates pairing code → share via copy or mailto
- Seat list (pending → connected), revoke button per seat
- **No Telegram integration** — sharing is copy/mailto only
- Uses `useTeamAccess` zustand store + `teamAccessCore.ts` pure reducer

### Settings Sections (already present)
- `RemoteSection` — start/stop hosting, connect to host
- `TeamAccessSection` — invite teammates, manage seats
- `TelegramSection` — bot token, start/stop, QR code
- **No cross-section wiring** — Telegram cannot send invites, Team Access cannot notify via Telegram

---

## Design: Unified Auth System

The three surfaces share a common pattern: **one-time pairing code → mutual approval → persistent access**. The relay already does this well. We extend it:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Unified Auth Registry                         │
│  ┌────────────────────┐  ┌──────────────────┐  ┌─────────────┐ │
│  │ Approved Devices   │  │ Telegram Users   │  │ Invite Codes│ │
│  │ (box pubkeys, PIN) │  │ (chat_id, paired)│  │ (one-time,  │ │
│  │                    │  │                  │  │  TTL-bound) │ │
│  └────────────────────┘  └──────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Flow 1: Telegram Pairing (new)**
1. User sends `/pair` to the bot
2. Bot generates 6-digit pairing code with TTL
3. Bot replies with code + instructions; **also pushes notification to the desktop** (IPC)
4. Desktop user sees notification, enters SAS-like approval dialog
5. Desktop user confirms → Telegram chat_id is pinned (persisted to `approved-telegram.json`)
6. Bot confirms to Telegram user: "You're paired. Try /terminals"

**Flow 2: Team Access Invite via Telegram (new)**
1. Desktop user goes to Settings → Team Access → enters email, clicks "Generate invite"
2. **New:** If Telegram bot is running, a "Send via Telegram" button appears
3. Bot sends inline keyboard to the specified contact: "You're invited to nodeterm [Accept/Decline]"
4. On Accept → the pairing code is consumed server-side, the invitee can connect
5. On Decline → the seat is freed, host can invite again

**Flow 3: Existing Relay Pairing (unchanged)**
- Desktop ↔ desktop: mutual SAS, unchanged
- Phone ↔ desktop: standing host, unchanged

---

## Implementation Phases

### Phase 1 — Telegram Bot Auth & Pairing (core)

**Files to create:**

| File | Purpose |
|---|---|
| `src/core/telegram-approved.ts` | Pure store for approved Telegram chat IDs (read/write `~/.nodeterm/telegram-approved.json`) |
| `src/core/telegram-pairing.ts` | 6-digit code generation, TTL expiry, pending pairings map |

**Files to modify:**

| File | Changes |
|---|---|
| `src/core/telegram-bot.ts` | Add `/pair` flow, gate commands on approval, add `/invite` command |
| `src/shared/ipc.ts` | Add `telegramBotPairingCode`, `telegramBotPairingAccepted` channels |
| `src/shared/types.ts` | Add `TelegramApprovedUser`, `TelegramPairingCode`, extend `TelegramBotStatus`, extend `TelegramApi` |
| `src/preload/index.ts` | Add pairing-related IPC bindings |
| `src/main/index.ts` | Wire Telegram pairing events to renderer notification, pass approved-users I/O to bot init |
| `src/renderer/state/telegramBot.ts` | Add pending pairing state |
| `src/renderer/bridge/stubs.ts` | Stub new Telegram API members |

---

### Phase 2 — Team Access Invite via Telegram

**Files to modify:**

| File | Changes |
|---|---|
| `src/core/telegram-bot.ts` | `/invite <email>` → calls `relayHost.invite()` IPC → sends code to chat; inline Accept/Decline keyboard |
| `src/renderer/components/settings/sections/TeamAccessSection.tsx` | "Send via Telegram" button when bot is running; shows outgoing invite sent to Telegram |
| `src/renderer/components/settings/sections/TelegramSection.tsx` | Show paired users list, allow revoke |
| `src/renderer/components/settings/teamAccessView.ts` | Add `inviteShareViaTelegram` helper |

---

### Phase 3 — Cross-Section Wiring & Notifications

**Files to modify:**

| File | Changes |
|---|---|
| `src/main/index.ts` | Receive pairing-code events, route to renderer as notification |
| `src/renderer/canvas/Canvas.tsx` | Show Telegram pairing notification as in-app toast/approve dialog |
| `src/renderer/state/telegramBot.ts` | Wire pairing-code listener to store |
| `src/renderer/components/settings/sections/TelegramSection.tsx` | Show pending pairing code; accept/reject UI |

---

### Phase 4 — Testing

**Files to create:**

| File | Purpose |
|---|---|
| `src/core/telegram-approved.test.ts` | Unit tests for load/save/isApproved/pin |
| `src/core/telegram-pairing.test.ts` | Unit tests for code generation, expiry, claim |

**Files to update:**

| File | Changes |
|---|---|
| `src/core/telegram-bot.test.ts` | **(create if none)** Unit tests for bot commands with mocked Telegraf |
| `src/renderer/state/telegramBot.test.ts` | **(create if none)** Test store hydration + pairing events |

---

## Detailed Design

### 1. `src/core/telegram-approved.ts` — Approved Telegram Users

```typescript
// ~/.nodeterm/telegram-approved.json persisted list of approved Telegram chat_ids.

export interface TelegramApprovedUser {
  chatId: number
  name: string          // Telegram display name (first_name or username)
  pairedAt: number      // epoch ms
}

export function isTelegramApproved(
  approved: TelegramApprovedUser[],
  chatId: number
): boolean

export function pinTelegramUser(
  approved: TelegramApprovedUser[],
  chatId: number,
  name: string
): TelegramApprovedUser[]
```

I/O wrappers (separate from pure core because they touch the filesystem):

```typescript
// In telegram-bot.ts or a sibling:
function loadTelegramApproved(filePath: string): Promise<TelegramApprovedUser[]>
function saveTelegramApproved(filePath: string, approved: TelegramApprovedUser[]): Promise<void>
```

The file path uses `app.getPath('userData')` → `telegram-approved.json` (like `approved-devices.ts`).

### 2. `src/core/telegram-pairing.ts` — Pairing Code Generator

```typescript
export interface TelegramPairingRequest {
  code: string          // 6-digit numeric code, like "482916"
  chatId: number
  name: string          // Telegram display name
  createdAt: number     // epoch ms
  expiresAt: number     // epoch ms
}

const PAIRING_TTL_MS = 120_000  // 2 minutes, matches relay token TTL

export function generatePairingCode(chatId: number, name: string): TelegramPairingRequest
export function isPairingExpired(request: TelegramPairingRequest): boolean
export function claimPairingCode(pending: Map<string, TelegramPairingRequest>, code: string): TelegramPairingRequest | null
```

### 3. `src/core/telegram-bot.ts` — Rewritten Commands

**New `/pair` command:**
```
/pair
→ Bot: "Generating a pairing code…"
→ Generates 6-digit code
→ Broadcasts IPC `telegramBotPairingCode` to the renderer
→ Bot: "Your pairing code: 482916\n\nThis code expires in 2 minutes.\nEnter it in the nodeterm app or wait for the in-app prompt."
```

**Gating logic on existing commands:**
```
/status → always public
/start → always public
/help → always public
/pair → always public (this IS the auth)

/terminals → requires isTelegramApproved(chatId)
/attach → requires isTelegramApproved(chatId)
/send → requires isTelegramApproved(chatId)
/invite → requires isTelegramApproved(chatId) + isPremium (or check relayAllowed)
```

**New `/invite` command:**
```
/invite <email> [optional]
→ Bot: "Generating a Team Access invite…"
→ Calls renderer IPC to relayHost.invite({ email })
→ Bot sends: "Invite for {email}: {pairingCode}"
  With inline keyboard: [Done] [Cancel]
```

**Desktop approval dialog flow:**
```
1. telegram-bot.ts generates pairing code
2. Broadcasts IPC.telegramBotPairingCode → { code, name }
3. Renderer TelegramSection or Canvas shows:
   "Telegram user @{name} wants to pair."
   "[Approve] [Reject]"
4. On Approve → IPC.telegramBotPairingAccepted → { code }
5. telegram-bot.ts receives the IPC, looks up pending code, pins chat_id
6. Bot sends: "✅ Paired! Try /terminals"
```

### 4. IPC Channels to Add

In `src/shared/ipc.ts`:
```typescript
telegramBotPairingCode: 'telegram:bot:pairing:code',
telegramBotPairingAccepted: 'telegram:bot:pairing:accepted',
telegramBotPairingRejected: 'telegram:bot:pairing:rejected',
telegramBotApprovedUsers: 'telegram:bot:approved-users',
telegramBotInvite: 'telegram:bot:invite',
```

### 5. API Surface to Add

In `src/shared/types.ts` `TelegramApi`:
```typescript
telegram: {
  // Existing:
  start(token?: string): Promise<TelegramBotStatus>
  stop(): Promise<TelegramBotStatus>
  getStatus(): Promise<TelegramBotStatus>
  onStatusChange(listener: (status: TelegramBotStatus) => void): () => void
  // New:
  onPairingCode(listener: (req: TelegramPairingRequest) => void): () => void
  acceptPairing(code: string): void
  rejectPairing(code: string): void
  getApprovedUsers(): Promise<TelegramApprovedUser[]>
  revokeUser(chatId: number): Promise<void>
  inviteViaTelegram(email?: string): Promise<{ success: boolean }>
}
```

`TelegramBotStatus`:
```typescript
export interface TelegramBotStatus {
  running: boolean
  botUsername: string | null
  error: string | null
  approvedUserCount: number  // NEW
}
```

---

## Schema — `telegram-approved.json`

```json
[
  {
    "chatId": 123456789,
    "name": "Alice",
    "pairedAt": 1721116800000
  },
  {
    "chatId": 987654321,
    "name": "Bob (via invite)",
    "pairedAt": 1721203200000
  }
]
```

Stored at `<userData>/telegram-approved.json`.

---

## Key Integration Points

### How Telegram bot connects to relay host for invites

```
Telegram /invite
  → telegram-bot.ts sends IPC to main process
  → main process invokes relayHostInvite handler (initRelayHost → addSeat)
  → addSeat mints pairing token → returns { offer, id }
  → main process replies to telegram-bot with the offer
  → telegram-bot sends offer code as Telegram message
```

This requires:
1. `telegram-bot.ts` to have access to the main process's IPC handlers (it runs in main)
2. Or: `initTelegramBot` gets a callback `inviteTeammate: (opts) => Promise<{offer, id}>`

### How the desktop app displays pairing requests

```
telegram-bot.ts generates pairing code
  → calls platform().broadcast(IPC.telegramBotPairingCode, { code, name })
  → preload receives on IPC channel
  → renderer zustand store updates
  → TelegramSection or Canvas renders notification
```

---

## Edge Cases & Gotchas

| Gotcha | Mitigation |
|---|---|
| Bot restarts, pending pairings lost | Codes have 2-min TTL; acceptable |
| User has multiple Telegram accounts | Each chat_id is independent; `/pair` per account |
| User wants to unpair a Telegram user | Settings → Telegram → Approved users → Revoke (like Team Access) |
| Bot token changes mid-session | Stop bot, start with new token; approved users survive (persisted) |
| Approve dialog left open, times out | 2-min TTL on code; expired codes silently ignored |
| `/invite` without Pro license | Gate on `isPremium()` — bot replies "Team Access requires nodeterm Pro" |
| Telegram user sends commands before pairing | Gated — bot replies "Use /pair first" |
| Race: two Telegram users pair simultaneously | Each code is unique per chat_id; separate approvals |

---

## Files to Create (in order)

| # | File | Description |
|---|---|---|
| 1 | `src/core/telegram-approved.ts` | Pure: TelegramApprovedUser, isTelegramApproved, pinTelegramUser |
| 2 | `src/core/telegram-pairing.ts` | Pure: generatePairingCode, isPairingExpired, claimPairingCode |
| 3 | `src/core/telegram-approved.test.ts` | Tests for #1 |
| 4 | `src/core/telegram-pairing.test.ts` | Tests for #2 |

## Files to Modify (in order)

| # | File | Changes |
|---|---|---|
| 1 | `src/shared/types.ts` | Add types + extend `TelegramApi` interface + extend `TelegramBotStatus` |
| 2 | `src/shared/ipc.ts` | Add new IPC channel names |
| 3 | `src/core/telegram-bot.ts` | Major rewrite: add `/pair`, gating, `/invite`, pairing IPC integration, preload I/O |
| 4 | `src/main/index.ts` | Pass approved-users I/O to initTelegramBot, wire pairing events, connect to relayHost |
| 5 | `src/preload/index.ts` | Add new IPC bindings for Telegram pairing/invite/revoke |
| 6 | `src/renderer/bridge/stubs.ts` | Stub new Telegram API members |
| 7 | `src/renderer/state/telegramBot.ts` | Add pairing state, approved users list |
| 8 | `src/renderer/components/settings/sections/TelegramSection.tsx` | Add pending pairing notification, approved users list, revoke |
| 9 | `src/renderer/components/settings/sections/TeamAccessSection.tsx` | "Send via Telegram" button when bot running |
| 10 | `src/renderer/components/settings/teamAccessView.ts` | Add `inviteShareViaTelegram` helper |
| 11 | `src/renderer/components/settings/sections/RemoteSection.tsx` | Optional: link to Telegram section |

---

## Test Plan

- **Unit tests** for `telegram-approved.ts` and `telegram-pairing.ts` pure functions
- **Integration test**: mock Telegraf, test bot command routing with approved/unauthorized chat IDs
- **Manual test**: run the app, start bot, send `/pair` from Telegram, approve in app, run `/terminals`
- **Regression**: existing relay-host, team-access, and relay-client tests must still pass
