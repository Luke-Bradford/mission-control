# Agent Comms Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two machines on different subscriptions (the home Mac and the work PC) join one invite-only room through a relay, and their agents exchange signed, end-to-end encrypted messages. A Claude or Codex session takes part through MCP tools, and an always-on communicator keeps each side connected.

**Architecture:** There is one new workspace package, `@mc/agentcomms`, holding:
- the crypto, envelopes and membership logic;
- a transport-free relay core;
- a Node WebSocket relay, used for local and LAN tests;
- the communicator daemon, which keeps the connection, an inbox in `node:sqlite`, the guards and a loopback API;
- a stdio MCP server;
- a CLI.

A thin Cloudflare Worker with one Durable Object per room, in `apps/relay`, wraps the same relay core for the internet relay. The relay stores and forwards only signed ciphertext.

**Tech Stack:**
- Node 25 with `--experimental-strip-types` (erasable TypeScript only);
- `libsodium-wrappers-sumo` for Ed25519 signing, X25519 sealed boxes and XChaCha20-Poly1305;
- `ws`;
- `zod`;
- `node:sqlite`;
- Cloudflare Workers with Durable Objects (`@cloudflare/workers-types` for typecheck only);
- vitest and biome, as in the rest of the repo.

**Spec:** `docs/superpowers/specs/2026-10-24-agent-comms-design.md`. Phase 1 is "Core module and relay". Phases 2 to 4 (behaviour, HUD and organisations) are out of scope here.

## Global Constraints

- **TypeScript:** erasable syntax only. No `enum`, no parameter properties, no namespaces (the repo sets `erasableSyntaxOnly`). Imports carry `.ts` extensions.
- **Package:** `packages/agentcomms`, named `@mc/agentcomms`, with `"type": "module"` and `exports: { ".": "./src/index.ts" }`, like `@mc/core`.
- **The relay is ciphertext only.** It never holds a room key, and never sees a message body in plain text.
- **Invites never carry the room key.** The key is sent only after owner approval, wrapped to the new member's X25519 public key.
- **Who signs what.** Only member (human) keys sign `sender.kind: "human"` envelopes. Agent keys sign only `sender.kind: "agent"` envelopes, under a delegation signed by their member key. Agent tools (MCP and the communicator) never load the member key for signing.
- **Private keys** live only in `~/.local/share/agentcomms/keys/` (or `$AGENTCOMMS_HOME/keys/`) with file mode `0600`. They are never in the repo or the config, and never sent anywhere.
- **Message body limit:** at most `BODY_MAX = 32_000` UTF-8 bytes before encryption. A longer message is refused whole, never cut.
- **Outgoing check.** Every outgoing body passes `scanText` from `@mc/core`. A finding holds the message (`held: true`) and it is not sent.
- **Order** is by the relay's per-room sequence number, never by the sender's clock.
- **No Cloudflare credentials** in the repo or CI. The operator deploys the relay by hand.

## Review Focus

1. **A relay restart, or a client reconnect mid-conversation,** must not lose or duplicate messages. The client resumes from its last sequence number. Pinned in Tasks 4 and 6.
2. **Clock skew between machines** must not reorder the conversation. Display and threading follow the relay's sequence number. Pinned in Task 4.
3. **A member removed while another member is offline.** The offline member gets the rotated key on reconnect, and the removed member can't read anything posted after the rotation. Pinned in Task 3.
4. **A body over `BODY_MAX`** is refused with a clear error and nothing is sent. It is never truncated. Pinned in Task 2.
5. **Two communicators with automatic answering** must not ping-pong. A reply to an automatic message is never automatic, and outgoing rate limits hold. Pinned in Task 6.

---

### Task 1: Package skeleton, keys and identity

**Files:**
- Create: `packages/agentcomms/package.json`, `packages/agentcomms/tsconfig.json`, `packages/agentcomms/src/index.ts`, `packages/agentcomms/src/sodium.ts`, `packages/agentcomms/src/keys.ts`
- Test: `packages/agentcomms/test/keys.test.ts`
- Modify: `pnpm-lock.yaml`, by `pnpm add -F @mc/agentcomms libsodium-wrappers-sumo ws zod` and `pnpm add -F @mc/agentcomms -D @types/libsodium-wrappers-sumo @types/ws`

**Interfaces:**
- Produces:
  - `ready(): Promise<Sodium>`, which awaits libsodium once.
  - `type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array }`.
  - `type Identity = { id: string; kind: "human" | "agent"; label: string; sign: KeyPair; box: KeyPair }`, where `id` is the base64url of the sign public key.
  - `newIdentity(kind, label): Promise<Identity>`.
  - `saveIdentity(dir, identity): Promise<void>`, which writes `<dir>/keys/<id>.json` with mode `0o600`.
  - `loadIdentity(dir, id): Promise<Identity>`.
  - `type Delegation = { agentId: string; memberId: string; subscription: string; agentName: string; sig: string }`.
  - `delegate(member: Identity, agent: Identity, subscription: string, agentName: string): Promise<Delegation>`.
  - `verifyDelegation(d: Delegation, memberPublicKey: Uint8Array): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**
  - `newIdentity` makes distinct sign and box key pairs, and `id` equals base64url(sign.publicKey).
  - `saveIdentity` then `loadIdentity` round-trips. The file mode is `0o600` (`statSync(...).mode & 0o777`).
  - A delegation verifies with the member's public key. It fails when any field (`agentName`, `subscription`) is changed, and fails with another member's key.
- [ ] **Step 2: Run** `npx vitest run packages/agentcomms/test/keys.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `sodium.ts` and `keys.ts`. The delegation signs the canonical JSON of `{agentId, memberId, subscription, agentName}` with `crypto_sign_detached`. `index.ts` re-exports.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also run `pnpm -s typecheck` and `pnpm -s exec biome check packages/agentcomms`, both exiting 0.
- [ ] **Step 5: Commit** with `feat(agentcomms): identities, key files and agent delegation`.

### Task 2: Signed, encrypted envelopes

**Files:**
- Create: `packages/agentcomms/src/envelope.ts`
- Test: `packages/agentcomms/test/envelope.test.ts`

**Interfaces:**
- Consumes: from Task 1, `Identity`, `Delegation`, `ready`.
- Produces:
  - `BODY_MAX = 32_000`.
  - `type Kind = "question" | "answer" | "fyi" | "request" | "decision"`.
  - `type Knowledge = { kind: "checked"; source: string; asOf: string } | { kind: "from-notes"; asOf: string } | { kind: "cannot-confirm" }`.
  - `type Message = { id: string; room: string; thread: string; inReplyTo?: string; kind: Kind; body: string; refs?: string[]; knowledge?: Knowledge; urgency?: "low" | "normal" | "high"; replyBy?: string; needsHuman?: boolean; auto: boolean; reason?: string; requestedBy?: { kind: "human" | "agent"; name: string }; sentAt: string }`.
  - `type Sender = { id: string; kind: "human" | "agent"; delegation?: Delegation }`.
  - `type Sealed = { room: string; sender: Sender; keyEpoch: number; nonce: string; ciphertext: string; sig: string }`.
  - `seal(msg: Message, from: Identity, roomKey: Uint8Array, keyEpoch: number, delegation?: Delegation): Promise<Sealed>`, which throws `BodyTooLarge`.
  - `open(s: Sealed, roomKey: Uint8Array, publicKeyOf: (id: string) => Uint8Array | undefined): Promise<Message>`, which throws `BadSignature`, `WrongSender` or `BadCiphertext`.
  - `verifySealed(s: Sealed, publicKeyOf): Promise<boolean>`. It checks only the signature, so the relay can use it without the key.

- [ ] **Step 1: Write the failing tests**
  - A seal and open round trip returns an equal `Message`.
  - A body of `BODY_MAX + 1` bytes throws `BodyTooLarge`, and nothing is produced.
  - Flipping one ciphertext byte makes `open` throw `BadCiphertext`, and `verifySealed` returns false.
  - Opening with a different room key throws `BadCiphertext`.
  - An agent identity sealing with `sender.kind: "human"` throws `WrongSender` on `open`. So does a human key sealing as `"agent"`.
  - An agent sender without a delegation that verifies against its member's key throws `WrongSender`.
  - `verifySealed` works with no room key.
- [ ] **Step 2: Run** `npx vitest run packages/agentcomms/test/envelope.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
  - Encrypt the canonical JSON of the message with `crypto_aead_xchacha20poly1305_ietf_encrypt`. Use a random 24-byte nonce, and bind `room`, `sender.id` and `keyEpoch` as associated data.
  - Sign `room | sender.id | keyEpoch | nonce | ciphertext` with `crypto_sign_detached`.
  - `open` verifies the signature, checks that `sender.kind` matches the identity (an agent needs a valid delegation), and then decrypts.
- [ ] **Step 4: Run** the tests, typecheck and biome. Expected: PASS and exit 0.
- [ ] **Step 5: Commit** with `feat(agentcomms): signed XChaCha20 envelopes, human and agent senders apart`.

### Task 3: Invites, approval, key wrap and rotation

**Files:**
- Create: `packages/agentcomms/src/membership.ts`
- Test: `packages/agentcomms/test/membership.test.ts`

**Interfaces:**
- Consumes: from Task 1, `Identity` and `Delegation`.
- Produces:
  - `type Invite = { relay: string; room: string; token: string }`.
  - `encodeInvite(i: Invite): string`, which returns `ac1.` plus base64url JSON.
  - `decodeInvite(code: string): Invite`, which throws `BadInvite`.
  - `newRoomKey(): Promise<Uint8Array>`.
  - `type Member = { id: string; kind: "human"; label: string; boxPublicKey: string; signPublicKey: string; agents: { id: string; name: string; subscription: string; signPublicKey: string; delegation: Delegation }[] }`.
  - `type KeyGrant = { memberId: string; keyEpoch: number; wrapped: string }`.
  - `wrapRoomKey(roomKey, keyEpoch, member: Member): Promise<KeyGrant>`, using `crypto_box_seal` to `boxPublicKey`.
  - `unwrapRoomKey(g: KeyGrant, me: Identity): Promise<Uint8Array>`.
  - `rotate(members: Member[], removedId: string, nextEpoch: number): Promise<{ roomKey: Uint8Array; grants: KeyGrant[] }>`.

- [ ] **Step 1: Write the failing tests**
  - An invite round-trips. `decodeInvite("x")` throws `BadInvite`.
  - The encoded invite contains no key material: its JSON keys are exactly `relay`, `room` and `token`.
  - A wrapped key unwraps only with the member's identity. Another identity throws.
  - `rotate` gives grants to every member except the removed one, for `nextEpoch`.
  - A message sealed under the new key can't be opened with the old one.
  - A member who was offline unwraps their epoch-`n+1` grant afterwards and opens the new message.
- [ ] **Step 2: Run** `npx vitest run packages/agentcomms/test/membership.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.** The `token` is 32 random bytes in base64url.
- [ ] **Step 4: Run** the tests, typecheck and biome. Expected: PASS and exit 0.
- [ ] **Step 5: Commit** with `feat(agentcomms): invites without keys, approval-time key wrap, rotation on removal`.

### Task 4: Relay core (transport-free)

**Files:**
- Create: `packages/agentcomms/src/relay-core.ts`
- Test: `packages/agentcomms/test/relay-core.test.ts`

**Interfaces:**
- Consumes: from Task 2, `Sealed` and `verifySealed`. From Task 3, `Member` and `KeyGrant`.
- Produces: `createRoomCore(opts: { room: string; owner: Member; now: () => number; maxPerMinute?: number /* 30 */; storage?: RoomStorage })` returning `RoomCore`, with these methods:
  - `issueToken(by: string): string`, owner only;
  - `requestJoin(token: string, member: Member): "pending" | "used" | "unknown"`. Tokens are single use;
  - `approve(by: string, memberId: string, grants: KeyGrant[]): void`, owner only;
  - `remove(by: string, memberId: string, grants: KeyGrant[]): void`, owner only. It bumps `keyEpoch`;
  - `post(s: Sealed): { seq: number } | { refused: "unknown-sender" | "bad-signature" | "rate-limited" | "stale-epoch" }`;
  - `since(memberId: string, seq: number): { seq: number; sealed: Sealed }[]`;
  - `grantsFor(memberId: string): KeyGrant[]`;
  - `members(): Member[]`;
  - `pending(): Member[]`;
  - `setPresence(id: string, status: "online" | "busy" | "away"): void`;
  - `presence(): Record<string, { status: string; seenAt: number }>`. Anyone silent for over 90 s reads as `"gone"`.
- Also produces: `interface RoomStorage { load(): RoomState | undefined; save(s: RoomState): void }` and the type `RoomState`. Storage is in memory by default.

- [ ] **Step 1: Write the failing tests**
  - An unapproved member's post is refused `unknown-sender`.
  - A used token returns `"used"`.
  - A tampered `Sealed` is refused `bad-signature`.
  - The 31st post inside a minute is refused `rate-limited` (fake clock).
  - After `remove`, a post at the old `keyEpoch` is refused `stale-epoch`.
  - `since(m, 5)` returns only seq above 5, in order, whatever each message's `sentAt` says (out-of-order clocks).
  - A core rebuilt from saved storage keeps its seq counter and its log, so there are no duplicates or gaps after a restart.
  - Presence reads `"gone"` after 91 s of silence.
- [ ] **Step 2: Run** `npx vitest run packages/agentcomms/test/relay-core.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.** `RoomState` is `{ room, keyEpoch, seq, owner, members, pending, tokens, grants, log, presence }`. Save after every change. Keep the last 5000 messages; older history is a later phase.
- [ ] **Step 4: Run** the tests, typecheck and biome. Expected: PASS and exit 0.
- [ ] **Step 5: Commit** with `feat(agentcomms): relay core holding ciphertext, tokens, grants, order and presence`.

### Task 5: Relay transports: Node WebSocket and Cloudflare Worker

**Files:**
- Create: `packages/agentcomms/src/protocol.ts`, `packages/agentcomms/src/relay-node.ts`, `apps/relay/package.json`, `apps/relay/tsconfig.json`, `apps/relay/wrangler.toml`, `apps/relay/src/worker.ts`
- Test: `packages/agentcomms/test/relay-node.test.ts`
- Modify: `docs/runbook.md` (add a section, "Agent comms relay")

**Interfaces:**
- Consumes: from Task 4, `createRoomCore` and `RoomStorage`.
- Produces:
  - The wire protocol in `protocol.ts`: zod schemas for client to relay `{t:"hello", room, memberId, sig, at}`, `{t:"post", sealed}`, `{t:"since", seq}`, `{t:"presence", status}`, `{t:"join", token, member}`, `{t:"approve"|"remove", memberId, grants}`, and for relay to client `{t:"msg", seq, sealed}`, `{t:"grants", grants}`, `{t:"refused", reason}`, `{t:"presence", map}`.
  - `hello.sig` is the member's signature over `room|memberId|at`. The relay rejects an `at` more than 120 s off its clock.
  - `startNodeRelay(opts: { port: number; dataDir: string }): Promise<{ url: string; close(): Promise<void> }>`. One `RoomCore` per room, with storage as a JSON file per room under `dataDir`.
  - `apps/relay/src/worker.ts`: a `RoomDO` Durable Object that holds a `RoomCore` with `ctx.storage` as `RoomStorage` and serves the same protocol over WebSocket at `/rooms/:room`.

- [ ] **Step 1: Write the failing test** in `relay-node.test.ts`, with two clients over real sockets on a random port:
  - A posts, and B receives it with seq 1.
  - B disconnects, A posts seq 2 and 3, B reconnects with `since 1` and receives exactly 2 and 3, once each.
  - A `hello` with a bad signature is closed with `refused`.
  - The relay is restarted on the same `dataDir`, and a reconnecting client resumes without gaps.
- [ ] **Step 2: Run** `npx vitest run packages/agentcomms/test/relay-node.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `relay-node.ts`** with `ws`.
- [ ] **Step 4: Implement `apps/relay`.**
  - `wrangler.toml` binds a Durable Object `ROOMS` with class `RoomDO`, and sets `compatibility_date = "2026-10-01"`.
  - `package.json` has `"typecheck": "tsc --noEmit"` and devDependency `@cloudflare/workers-types` only. Don't add `wrangler` as a dependency; the runbook uses `npx wrangler@4 deploy`.
- [ ] **Step 5: Write the runbook section.** Deploying with `npx wrangler@4 login` and then `npx wrangler@4 deploy` in `apps/relay`, on the operator's own account. Running a LAN relay with `agentcomms relay --port 7480`. Note that no credentials are ever committed.
- [ ] **Step 6: Run** the test, `pnpm -s typecheck` (including `apps/relay`) and biome. Expected: PASS and exit 0.
- [ ] **Step 7: Commit** with `feat(agentcomms): node relay and Cloudflare Durable Object relay on one core`.

### Task 6: The communicator daemon: connection, inbox, guards and outgoing check

**Files:**
- Create: `packages/agentcomms/src/inbox.ts`, `packages/agentcomms/src/guards.ts`, `packages/agentcomms/src/daemon.ts`
- Test: `packages/agentcomms/test/guards.test.ts`, `packages/agentcomms/test/daemon.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 5. `scanText(where, text, known)` from `@mc/core`, where `known` is the empty list in phase 1.
- Produces:
  - `openInbox(path): Inbox`, on `node:sqlite`, with the methods `add(seq, room, msg, sender)`, `list(room, sinceSeq?)`, `lastSeq(room)`, `threads(room)` (open and closed) and `close(thread)`.
  - `guards`:
    - `mayAutoReply(to: Message): boolean`, false when `to.auto`;
    - `outgoingRate(now): { allow(): boolean }`, allowing 10 per minute per agent;
    - `similarOpen(room, body, inbox): string | undefined`, which returns the thread id of an open question whose normalised body (lowercase, whitespace collapsed) is equal.
  - `startDaemon(opts: { home: string; agent: Identity; delegation: Delegation; member: Member; rooms: { invite: Invite; roomKey?: Uint8Array }[]; answer?: string /* shell command */ }): Promise<Daemon>`.
  - `Daemon` has these methods:
    - `send(room, draft: Omit<Message, "id" | "sentAt" | "auto">): Promise<{ seq: number } | { held: string } | { merged: string }>`;
    - `read(room, sinceSeq?)`;
    - `presence(room)`;
    - `stop()`.

    It reconnects with backoff (1 s doubling to 30 s), resuming from `inbox.lastSeq`, and sends presence `online` every 30 s.
  - **The `answer` hook.** For an incoming `question` or `request` that mentions the daemon's agent name (or arrives in a one-to-one chat), the daemon runs `answer` with the message JSON on stdin. A non-empty stdout is sent as `kind: "answer"`, `auto: true`, `inReplyTo` the message. It is skipped when `mayAutoReply` is false.

- [ ] **Step 1: Write the failing tests**
  - In `guards.test.ts`:
    - `mayAutoReply({auto:true})` is false;
    - the 11th send inside a minute is refused;
    - `similarOpen` finds `"Is #506 yours?"` against `"is   #506 YOURS?"`.
  - In `daemon.test.ts`, two daemons over a Node relay (Task 5) in temp dirs:
    - A sends, and B's inbox has it, verified and decrypted.
    - A body containing `ghp_` followed by 36 characters is held: `{held}` comes back and B receives nothing.
    - A body of `BODY_MAX + 1` bytes is refused, and B receives nothing.
    - With `answer: "cat >/dev/null; echo ok"` on both sides, A's question gets exactly one automatic answer from B, and B's automatic answer gets no automatic answer back from A.
    - Killing B's socket mid-stream loses nothing: B has every seq after it reconnects.
- [ ] **Step 2: Run** `npx vitest run packages/agentcomms/test/guards.test.ts packages/agentcomms/test/daemon.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `inbox.ts`, `guards.ts` and `daemon.ts`.** The daemon holds only the agent identity. It never loads the member key (Global Constraints).
- [ ] **Step 4: Run** the tests, typecheck and biome. Expected: PASS and exit 0.
- [ ] **Step 5: Commit** with `feat(agentcomms): communicator daemon with inbox, guards, outgoing check and answer hook`.

### Task 7: Loopback API, stdio MCP server and CLI

**Files:**
- Create: `packages/agentcomms/src/api.ts`, `packages/agentcomms/src/mcp.ts`, `packages/agentcomms/src/cli.ts`, `packages/agentcomms/bin/agentcomms` (a shell shim: `exec node --experimental-strip-types "$(dirname "$0")/../src/cli.ts" "$@"`)
- Test: `packages/agentcomms/test/mcp.test.ts`, `packages/agentcomms/test/cli.test.ts`

**Interfaces:**
- Consumes: from Task 6, `startDaemon` and `Daemon`.
- Produces:
  - **The daemon's loopback API** (`api.ts`): HTTP on `127.0.0.1:<port>`, needing `Authorization: Bearer <token>`. The token is written to `<home>/api-token` with mode `0600`. Routes:
    - `GET /rooms`;
    - `GET /rooms/:room/messages?since=`;
    - `POST /rooms/:room/messages`;
    - `GET /rooms/:room/presence`;
    - `GET /rooms/:room/threads`.
  - **The MCP server** (`mcp.ts`): minimal JSON-RPC over stdio, following the hand-rolled style of `apps/server/src/mcp/server.ts`, with `initialize`, `tools/list` and `tools/call`. Tools:
    - `comms_rooms`;
    - `comms_read { room, since? }`;
    - `comms_send { room, kind, body, thread?, inReplyTo?, refs?, knowledge?, needsHuman?, reason?, requestedBy? }`;
    - `comms_presence { room }`;
    - `comms_threads { room }`.

    It calls the loopback API, and returns `held` or `merged` results as text the agent can act on.
  - **The CLI** (`cli.ts`):
    - `agentcomms init --member <label> [--github <handle>]` creates the member identity;
    - `agentcomms agent add <name> --subscription <label>` creates the agent identity and delegation;
    - `agentcomms room create <relayUrl> <room>`;
    - `agentcomms invite <room>` prints an `ac1.` code;
    - `agentcomms join <code>`;
    - `agentcomms approve <room> <memberId>`, which wraps and sends the key;
    - `agentcomms remove <room> <memberId>`, which rotates;
    - `agentcomms daemon [--answer <cmd>]`;
    - `agentcomms mcp`;
    - `agentcomms relay --port <n> --data <dir>`.

    `approve` and `remove` are the only commands that load the member key, and they run interactively from the human's terminal.

- [ ] **Step 1: Write the failing tests**
  - In `mcp.test.ts`, spawn `agentcomms mcp` against a daemon:
    - `tools/list` names the five tools;
    - `comms_send` then `comms_read` round-trips;
    - a send containing a secret returns text starting `Held:`.
  - In `cli.test.ts`, run the whole lifecycle in temp homes against a Node relay:
    - `init` and `agent add` on two homes, `room create` on A, then `invite`, `join` on B and `approve` on A;
    - both daemons exchange a message;
    - `remove` B, and B can't read a message posted afterwards.
  - `api-token` and the key files are mode `0600`, and a request without the token gets 401.
  - `agent add` refuses a second agent with the same name on the same subscription (names are unique within a subscription).
- [ ] **Step 2: Run** `npx vitest run packages/agentcomms/test/mcp.test.ts packages/agentcomms/test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `api.ts`, `mcp.ts`, `cli.ts` and the shim.** Add `"bin": { "agentcomms": "bin/agentcomms" }` to `package.json`.
- [ ] **Step 4: Run** the tests, typecheck and biome. Expected: PASS and exit 0.
- [ ] **Step 5: Commit** with `feat(agentcomms): loopback API, MCP tools and CLI`.

### Task 8: Two-machine setup and the first-test runbook

**Files:**
- Modify: `docs/runbook.md` (the section "Agent comms: home and work")
- Create: `packages/agentcomms/test/two-sides.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 7.

- [ ] **Step 1: Write the failing end-to-end test.** Two homes ("home" with member Luke home, agent `FLIGHT-comms`, subscription `Claude · home`; "work" with member Luke work, agent `work-comms`, subscription `Claude · work`) share one room over a Node relay. Assert:
  - work asks a `question` naming `FLIGHT-comms`, and home's answer hook replies once, with `knowledge: {kind:"cannot-confirm"}` passed through from the hook's JSON output;
  - work sees the sender as agent `FLIGHT-comms`, subscription `Claude · home`, member `Luke home`;
  - a `request` without `reason` is refused by the sender's `comms_send` with `"a request needs a reason"`.
- [ ] **Step 2: Run** `npx vitest run packages/agentcomms/test/two-sides.test.ts`. Expected: FAIL on the reason check.
- [ ] **Step 3: Make it pass.** `comms_send` refuses a `request` without `reason`. The answer hook may print JSON `{body, knowledge?}` or plain text.
- [ ] **Step 4: Write the runbook section.**
  - Deploy the relay (Task 5).
  - On each machine, run `init`, `agent add` and create or join the room.
  - Run `agentcomms daemon` under launchd on the Mac (plist example), and as a background service on the work PC.
  - Add `agentcomms mcp` to the Claude session's MCP config.
  - Phase 1 limit: the home side runs a standalone communicator. FLIGHT and HUD integration come in phases 2 and 3.
- [ ] **Step 5: Run** the full agentcomms test folder, typecheck and biome. Expected: PASS and exit 0.
- [ ] **Step 6: Commit** with `docs(agentcomms): two-machine setup and first-test runbook`.
