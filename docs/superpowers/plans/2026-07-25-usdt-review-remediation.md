# USDT Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every open HIGH, MEDIUM, and ARCHITECTURE finding from the 2026-07-25 USDT integration code review, across the fedimint backport, the fedi bridge, the shared TS layer, native UI, and web.

**Architecture:** Three principles drive the fixes: (1) the e-cash **note format** becomes the source of truth for its own unit (new `ECashField::Unit`), so every consumer — joined or not, chat or scan, bridge or UI — displays and routes by what the note actually is, never by what a sender claims; (2) mintv2 access becomes **unit-keyed** end-to-end (instance selection by `AmountUnit`, note-unit routing on receive), which is what makes BTC+USDT-in-one-federation work; (3) USDT UI/redux surfaces stop being copies and become **unit-parameterized shared code** (one offline-QR screen, one numpad frame, one push thunk, locale-aware formatting through the existing `AmountUtils` conventions).

**Tech Stack:** Rust (fedimint v0.11 backport at `~/projects/fedimint-backport`, fedi bridge crates), TypeScript (React Native + React web, redux-toolkit, ts-rs generated bindings), nix dev shells.

## Global Constraints

- Repos: fedi work happens in `/home/user/projects/fedi` on branch `usdt-integration` (commit locally, do NOT push — no fork remote). Backport work happens in `/home/user/projects/fedimint-backport` on branch `v0.11.0-fedi7-usdt` (push to `elsiribot/fedimint` at the end of each backport task).
- All cargo/just commands run inside the nix shell: `nix develop --command <cmd>`, from the repo root. Always `cd` with absolute paths; the shell's cwd drifts between compound commands.
- After any change to `crates/rpc-types` or `bridge/fedi-ffi/src/rpc.rs`, regenerate TS bindings: `nix develop --command just generate-bridge-bindings` and commit the resulting `ui/common/types/bindings.ts` in the same commit.
- USDT amounts are integer **micros** (10⁻⁶ USDT) carried in the fedimint `Amount` msats field. `USDT_UNIT = AmountUnit::new_custom(1)`. Never convert through floats.
- Rust formatting: `.rustfmt.toml` uses `group_imports = "StdExternalCrate"`, `imports_granularity = "Module"`. Run `cargo fmt` before every commit.
- TS checks: `cd ui && yarn workspace @fedi/common run tsc --noEmit && yarn workspace @fedi/native run tsc --noEmit`. Unit tests: `yarn workspace @fedi/common test` (and `@fedi/native test` where native tests are touched).
- Commit messages: conventional-commit style matching `git log --oneline -15`. End every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01XDVPik6vWuyoayqBXyjV8E`
- Backport pre-commit hooks sometimes fail on unrelated cargo-sort noise; precedent on the branch is `--no-verify` after manually verifying `cargo fmt --check` and clippy on the touched packages.
- The `RUN_USDT_TESTS`-gated e2e (`just test-usdt-bridge`) needs a devfed and takes ~5 min after compile; run it only where a task says to (it is the integration gate, not a per-step check). Background it with `nohup … &` — plain background Bash gets killed at ~600s.
- i18n: every new user-visible string goes through `t()` with a key added to `ui/common/localization/en/common.json` (the review verified 1:1 key hygiene; keep it that way).
- Line numbers in this plan are as of fedi commit `dfc68e09` and backport commit `cc29568d7e5`; re-locate with grep if drifted.

**Explicitly out of scope (from the review, user has not requested):** full web send/receive UI for USDT, mini-app browser USDT payment APIs, LOW-severity findings not folded into a task below, upstreaming to fedimint master.

---

## Phase 1 — Note format: self-describing unit (backport)

### Task 1: `ECashField::Unit` in mintv2 notes

**Files:**
- Modify: `/home/user/projects/fedimint-backport/modules/fedimint-mintv2-client/src/ecash.rs`
- Test: same file, `#[cfg(test)]` module (follow the existing encode/decode tests around the `Invite` variant added in `fd09e6c3e28` — `git -C /home/user/projects/fedimint-backport show fd09e6c3e28` shows the exact shape to mirror)

**Interfaces:**
- Produces: `ECashField::Unit(AmountUnit)` variant; `pub fn with_unit(mut self, unit: AmountUnit) -> Self`; `pub fn unit(&self) -> Option<AmountUnit>` on the ECash struct. Old clients skip the field via the existing `#[encodable_default]` forward-compat mechanism; notes without the field return `None`.

- [ ] **Step 1: Write the failing test** — in the ecash.rs test module:

```rust
#[test]
fn unit_field_roundtrips_and_defaults_to_none() {
    let ecash = test_ecash(); // reuse the existing test constructor used by the invite tests
    assert_eq!(ecash.unit(), None);
    let with_unit = ecash.clone().with_unit(AmountUnit::new_custom(1));
    let decoded = ECash::consensus_decode_whole(
        &with_unit.consensus_encode_to_vec(),
        &ModuleDecoderRegistry::default(),
    )
    .unwrap();
    assert_eq!(decoded.unit(), Some(AmountUnit::new_custom(1)));
}
```

Adapt constructor/encode-helper names to whatever the existing `Invite` tests in the file actually use — copy their harness verbatim.

- [ ] **Step 2: Run it, expect compile failure** (`with_unit` undefined): `nix develop --command cargo test -p fedimint-mintv2-client unit_field`
- [ ] **Step 3: Implement** — add `Unit(AmountUnit)` to the `ECashField` enum exactly parallel to `Invite(InviteCode)` (same encodable derive position, default-skip on unknown), plus `with_unit` / `unit()` accessors mirroring `with_invite` / `invite()`.
- [ ] **Step 4: Test passes**; also `cargo test -p fedimint-mintv2-client` (whole crate — the forward-compat/default tests must still pass).
- [ ] **Step 5: fmt, clippy the package, commit** `feat(mintv2): self-describing unit field in v2 ecash notes`, **push** to `elsiribot/fedimint` `v0.11.0-fedi7-usdt`. Record the new rev — later fedi tasks `cargo update` onto it.

### Task 2: per-instance mintv2 access by unit (backport, only if needed)

**Files:**
- Investigate first: `/home/user/projects/fedimint-backport/fedimint-client/src/client.rs` (~line 910, `get_first_module`)
- Possibly modify: same file

**Interfaces:**
- Produces (contract for Task 3): a public way to obtain `ClientModuleInstance<'_, M>` for a **specific instance id**, e.g. `pub fn get_module_by_instance<M: ClientModule>(&self, instance: ModuleInstanceId) -> anyhow::Result<ClientModuleInstance<'_, M>>`, plus the already-public config iteration (`client.config().modules` keyed by instance id with `.is_kind(...)`).

- [ ] **Step 1: Check whether v0.11 `fedimint-client` already exposes a per-instance typed accessor** (grep `fn get_module` in fedimint-client/src/client.rs). If a public one exists, record its exact name/signature in the task-completion report for Task 3 and skip to Step 4.
- [ ] **Step 2: If not, add `get_module_by_instance<M>`** as a thin variant of `get_first_module` that looks up the given instance id instead of scanning for the first of the kind, with the same error style ("Module kind mismatch for instance {id}").
- [ ] **Step 3: Compile + test:** `cargo check -p fedimint-client`, run the crate's existing tests.
- [ ] **Step 4: fmt/clippy/commit** (`feat(client): typed per-instance module accessor`) and **push**. If Step 1 short-circuited, no commit — just report the existing API.

---

## Phase 2 — Bridge: unit-keyed mint routing + surfaced units (fedi, Rust)

### Task 3: unit-aware mintv2 selection — fixes BTC+USDT coexistence

**Files:**
- Modify: `/home/user/projects/fedi/crates/federations/src/federation_v2/client.rs:75-82` (`ClientExt`)
- Modify: `/home/user/projects/fedi/crates/federations/src/federation_v2/mod.rs:471-489` (ops selection)
- Modify: `/home/user/projects/fedi/crates/federations/src/federation_v2/mint_ops/v2.rs` (all methods)
- Modify: `/home/user/projects/fedi/crates/federations/src/federation_v2/usdt.rs` (`ecash_unit`, `usdt_generate_ecash`, `usdt_receive_ecash` — switch to the unit-keyed accessor)
- Modify: `/home/user/projects/fedi/crates/federations/src/lib.rs:271-297` (`validate_ecash`)

**Interfaces:**
- Consumes: Task 1 (`ecash.unit()`, `with_unit`), Task 2 (per-instance accessor — exact name from Task 2's report).
- Produces on `ClientExt`:
  - `fn mintv2_of_unit(&self, unit: AmountUnit) -> anyhow::Result<ClientModuleInstance<'_, MintV2ClientModule>>` — iterate `self.config().modules`, filter `is_kind(mintv2)`, resolve each via the per-instance accessor, return the one whose `amount_unit() == unit`; error "no mintv2 instance with unit {unit:?}".
  - `fn mintv2_instances(&self) -> Vec<ClientModuleInstance<'_, MintV2ClientModule>>` (async where the config read requires it — match the existing `ClientExt` signatures).
  - Keep `fn usdt()` unchanged.

Behavior changes (each has a matching assertion in Task 4's mixed-fed e2e):
1. `MintOpsV2::get_raw_balance` → balance of the **BITCOIN-unit** instance, or `Amount::ZERO` if the federation has none (USDT-only). Delete the current "first instance + guard" shape.
2. `MintOpsV2::generate_ecash` (BTC path) → BITCOIN-unit instance; stamp the note with `.with_unit(AmountUnit::BITCOIN)` (plus existing invite logic).
3. `MintOpsV2::receive_ecash` → decode the note, read `ecash.unit()`; route to `mintv2_of_unit(note_unit.unwrap_or(BITCOIN))`. A USDT note claimed through the generic path must land in the USDT instance and continue emitting the same operation-log/meta shape it does today (`ClaimEcash` flow depends on it).
4. `usdt_generate_ecash` / `usdt_receive_ecash` / `usdt_balance` in usdt.rs → `mintv2_of_unit(USDT_UNIT)` instead of `client.mintv2()`; `usdt_generate_ecash` stamps `.with_unit(USDT_UNIT)`.
5. `validate_ecash` in lib.rs: derive `unit` from `ecash.unit()` (note field) FIRST; fall back to the joined-federation instance lookup only for legacy unitless notes. This fixes both mislabels: `NotJoined` and `Loading`-state federations (get_federation() failing no longer forces `Bitcoin`).
6. Ops selection in mod.rs: keep `has_mintv2 → MintOpsV2` (correct — kind-two feds have no mintv1), but the methods no longer assume "the" instance.

- [ ] **Step 1:** `cd /home/user/projects/fedi && nix develop --command cargo update -p fedimint-mintv2-client` onto Task 1's rev; verify the rev in Cargo.lock.
- [ ] **Step 2:** Implement `mintv2_of_unit`/`mintv2_instances` in client.rs.
- [ ] **Step 3:** Apply behavior changes 1–6. In `validate_ecash`, the `NotJoined` arm gains nothing here (Task 5 adds the field); just compute the unit for the `Joined` arm from the note field with instance fallback.
- [ ] **Step 4:** `cargo check -p federations -p fedi-ffi --tests` green; `cargo clippy -p federations` clean; existing `cargo nextest run -p federations` (non-devfed unit tests) green.
- [ ] **Step 5: Commit** `fix(bridge): unit-keyed mintv2 selection so BTC and USDT mints coexist`.

### Task 4: mixed BTC+USDT federation e2e

**Files:**
- Modify: `/home/user/projects/fedi/bridge/fedi-ffi/src/rpc/tests/usdt_tests.rs`
- Reference: the existing `test_usdt_bridge_end_to_end` in the same file shows devfed setup with `FM_MINTV2_AMOUNT_UNIT`; the backport's per-instance config-gen params (`ServerModuleConfigGenParamsRegistry`) support one fed carrying mintv1(BTC) + usdt + mintv2(USDT).

**Interfaces:**
- Consumes: Task 3's routing behavior.

- [ ] **Step 1: Write the test** `test_mixed_btc_usdt_federation` (RUN_USDT_TESTS-gated like its sibling): spin a devfed whose module set is mintv1 + lnv1/lnv2 + walletv1 + usdt + mintv2(USDT) (reuse the sibling test's env/config plumbing; the delta is including the v1 BTC modules the sibling omits). Assertions:
  - `usdtSupported == true`, `usdtBalance == 0` initially;
  - BTC side works: fund via devfed faucet/LN, `get_raw_balance > 0` (proves finding H-A's ZERO bug is gone);
  - `usdtGenerateEcash` then `usdtReceiveEcash` round-trip moves the USDT balance and does NOT move the BTC balance;
  - generic `receiveEcash` on a USDT note (the ClaimEcash path) credits USDT, not BTC;
  - BTC `generateEcash` note decodes with `unit == BITCOIN` via `parseEcash`.
- [ ] **Step 2: Run it:** `nohup env RUN_USDT_TESTS=1 nix develop --command cargo nextest run -p fedi-ffi test_mixed_btc_usdt -- --nocapture > <scratchpad>/mixed-e2e.log 2>&1 &`, watch to completion. Expected: PASS. If devfed refuses the mixed module set, fix the test-side config (the server supports it — that was the point of the config-gen params backport); report loudly if a backport change turns out to be required rather than working around it.
- [ ] **Step 3: Commit** `test(bridge): mixed BTC+USDT federation end-to-end coverage`.

### Task 5: surface units on `RpcEcashInfo::NotJoined` and `RpcTransaction`

**Files:**
- Modify: `/home/user/projects/fedi/crates/rpc-types/src/lib.rs` (`RpcEcashInfo`, `RpcTransaction`)
- Modify: `/home/user/projects/fedi/crates/federations/src/lib.rs` (`validate_ecash` NotJoined arm)
- Modify: `/home/user/projects/fedi/crates/federations/src/federation_v2/mint_ops/v2.rs` (`get_transaction` / transaction-event emission)
- Modify: `ui/common/types/bindings.ts` (generated)
- Test: extend the validate-ecash coverage in `bridge/fedi-ffi/src/rpc/tests.rs` (grep `validateEcash` for the existing case)

**Interfaces:**
- Produces: `RpcEcashInfo::NotJoined { …, unit: Option<RpcEcashUnit> }` (from the note's `unit()` field; `None` for legacy notes — the UI must render "unknown", never assume sats); `RpcTransaction.unit: RpcEcashUnit` with `#[serde(default)]` where default = `Bitcoin` (old bindings tolerate it; new UI branches on it). Populate `unit` in mintv2 `get_transaction` from the operation's instance unit.

- [ ] **Step 1: Write the failing bridge test:** generate USDT ecash with invite in a joined fed, `validateEcash` from a **fresh unjoined** bridge instance, assert `federation_type == "notJoined"` and `unit == Some(Usdt)` (extend the existing invite-flow test which already builds exactly this two-bridge setup).
- [ ] **Step 2:** Run → fails (field missing).
- [ ] **Step 3:** Add the fields + population; `just generate-bridge-bindings`; fix any TS compile fallout mechanically (`unit` additions are additive).
- [ ] **Step 4:** Test passes; `tsc --noEmit` for common+native clean.
- [ ] **Step 5: Commit** `feat(bridge): ecash unit on not-joined validation and transactions`.

### Task 6: `usdt_list_transactions` — filter before limit, add cursor

**Files:**
- Modify: `/home/user/projects/fedi/crates/federations/src/federation_v2/usdt.rs:319-400`
- Modify: `bridge/fedi-ffi/src/rpc.rs` (`usdtListTransactions` — add `start_time: Option<u64>` param, same convention as `listTransactions` at rpc.rs:591-603)
- Modify: `ui/common/utils/fedimint.ts` (wrapper), `ui/common/types/bindings.ts` (generated)
- Test: unit-testable mapping already exercised in usdt_tests.rs — extend with a "many reissues" scenario

**Interfaces:**
- Produces: `usdt_list_transactions(limit: usize, start_time: Option<...>) -> Vec<RpcUsdtTransaction>` that internally pages `paginate_operations_rev` in chunks (chunk size 100) until it has accumulated `limit` **USDT-relevant** entries or exhausted the log; returns entries strictly older than `start_time` when given. `RpcUsdtTransaction` keeps its shape (its `createdAt` is the cursor callers pass back).

- [ ] **Step 1: Failing e2e assertion:** in the existing usdt e2e after the send/receive round-trips, perform 3 USDT sends (each creates a Reissue), then `usdtListTransactions(fed, limit=2)` must return 2 **non-Reissue** entries (today the newest-2 window can be all reissues → fewer/zero rows).
- [ ] **Step 2:** Implement the accumulate-loop; wire `start_time` through RPC + wrapper (wrapper signature: `usdtListTransactions(federationId, limit, startTime?)`); regenerate bindings.
- [ ] **Step 3:** `cargo check`/clippy; run the usdt e2e (this task's assertions ride along the full run — fine to defer the actual run to Task 18 if compile+unit level is clean, but note it in the report).
- [ ] **Step 4: Commit** `fix(bridge): usdt history filters before limit and supports paging`.

### Task 7: bridge dedup — shared invite/unit stamping, aligned wrapper arg order

**Files:**
- Modify: `/home/user/projects/fedi/crates/federations/src/federation_v2/mint_ops/v2.rs:114-120`, `/home/user/projects/fedi/crates/federations/src/federation_v2/usdt.rs:281-287` (extract one helper)
- Modify: `/home/user/projects/fedi/ui/common/utils/fedimint.ts:390,408` (arg order)

**Interfaces:**
- Produces: `impl FederationV2 { async fn ecash_with_common_fields(&self, ecash: ECash, include_invite: bool, unit: AmountUnit) -> ECash }` (name flexible; one place that stamps invite + unit) used by both generate paths. TS wrappers renamed args to BTC order: `usdtGenerateEcash(amountMicros, federationId, includeInvite, frontendMetadata)`, `usdtReceiveEcash(ecash, federationId)` — update all call sites (grep `usdtGenerateEcash\|usdtReceiveEcash` under `ui/`; the review counted 4).

- [ ] **Step 1:** Extract the Rust helper; both call sites use it (the `.with_unit` stamping from Task 3 moves in here).
- [ ] **Step 2:** Flip the TS wrapper arg order + call sites; `tsc --noEmit` both workspaces; `yarn workspace @fedi/common test` (pay/payment suites exercise the call sites).
- [ ] **Step 3:** `cargo check -p federations`; commit `refactor(bridge): shared ecash field stamping; align usdt wrapper arg order`.

---

## Phase 3 — Shared TS layer (fedi, `ui/common`)

### Task 8: stop trusting sender-declared USDT amounts (chat)

**Files:**
- Modify: `/home/user/projects/fedi/ui/common/hooks/matrix.ts:1460-1490` (`useMatrixPaymentTransaction`) and the display path (`makeMatrixPaymentText` callers)
- Modify: `/home/user/projects/fedi/ui/common/redux/matrix.ts:1800-1830` (`claimMatrixPayment`)
- Modify: `/home/user/projects/fedi/ui/common/utils/matrix.ts:496-532` (`makeMatrixPaymentText` USDT branch)
- Test: `/home/user/projects/fedi/ui/common/tests/unit/matrix/payment.test.ts`

**Interfaces:**
- Consumes: `fedimint.validateEcash(ecash)` → `RpcEcashInfo` with `amount` + `unit` (exists; Task 5 extends NotJoined but Joined already carries both).
- Produces: for USDT payment events **with an attached `ecash` token**, the displayed amount comes from `validateEcash(ecash).amount` (micros), NOT `event.content.amount`; on mismatch render the validated amount. `claimMatrixPayment` captures the `RpcUsdtAmount` return of `usdtReceiveEcash` and passes it into the status update so post-claim display uses the redeemed amount. Requests (no ecash attached yet) keep using the declared amount — nothing to verify.

- [ ] **Step 1: Failing test:** in payment.test.ts, mock `validateEcash` to return `{ amount: 1 }` (1 micro) for an event whose content declares `amount: 1_000_000_000`; assert the rendered payment text/amount uses `0.000001`, not `1,000.00`. Second case: claim resolves with redeemed amount ≠ declared → status/display reflects redeemed.
- [ ] **Step 2:** Run → fails.
- [ ] **Step 3:** Implement: in `useMatrixPaymentTransaction`'s USDT early-return branch, instead of `setTransaction(null)` immediately, call `fedimint.validateEcash(event.content.ecash)` when `ecash` is present and store `{ verifiedAmountMicros }`; thread it to `makeMatrixPaymentText`'s USDT branch (new optional arg, mirroring how the BTC branch prefers txn amounts per the comment at hooks/matrix.ts:717). In `claimMatrixPayment`, `const redeemed = await fedimint.usdtReceiveEcash(...)` and include it in the dispatched claim-status update.
- [ ] **Step 4:** Tests pass; `tsc --noEmit` clean.
- [ ] **Step 5: Commit** `fix(chat): verify usdt payment amounts against the actual ecash`.

### Task 9: USDT reclaim guard (no endless retry after restart)

**Files:**
- Modify: `/home/user/projects/fedi/ui/common/redux/matrix.ts:1863-1880` (USDT branch of the reclaim thunk)
- Test: `/home/user/projects/fedi/ui/common/tests/unit/matrix/payment.test.ts`

**Interfaces:**
- Produces: reclaim semantics matching BTC's tolerance: if `usdtReceiveEcash` rejects with an already-spent error, treat as success (the notes were reclaimed in a previous session) — do NOT rethrow, so `checkForReceivablePayments`'s catch doesn't free the paymentId and the debounced listener stops re-attempting. Match the error by the bridge's message (`"rejected"`/`"already spent"` — confirm the exact string from `mint_ops/v2.rs`'s receive error or the bridge ErrorCode and match on that).

- [ ] **Step 1: Failing test:** mock `usdtReceiveEcash` to reject with the already-spent error; dispatch the reclaim; assert it resolves (no throw) and the payment stays marked handled; assert a second dispatch performs **zero** additional `usdtReceiveEcash` calls.
- [ ] **Step 2:** Run → fails (currently rethrows).
- [ ] **Step 3:** Implement the catch-and-absorb (log at info), keeping genuine transport errors rethrown.
- [ ] **Step 4:** Pass; commit `fix(chat): usdt reclaim tolerates already-reclaimed notes`.

### Task 10: defensive handling for unknown ecash units

**Files:**
- Modify: `/home/user/projects/fedi/ui/common/utils/matrix.ts` (add helper + use in `makeMatrixPaymentText`)
- Modify: `/home/user/projects/fedi/ui/common/redux/matrix.ts` (auto-claim gate in `checkForReceivablePayments`/claim thunk), `ui/common/hooks/matrix.ts` (accept/claim guards)
- Modify: `/home/user/projects/fedi/ui/common/localization/en/common.json` (key `feature.chat.unsupported-payment-unit`: "This payment uses an asset this app version doesn't support yet.")
- Test: `ui/common/tests/unit/matrix/payment.test.ts`

**Interfaces:**
- Produces: `export function getPaymentUnit(content: { unit?: RpcEcashUnit | string | null }): 'bitcoin' | 'usdt' | 'unsupported'` — `undefined`/`null`/`'bitcoin'` → `'bitcoin'`; `'usdt'` → `'usdt'`; anything else → `'unsupported'`. EVERY existing `unit === 'usdt'` branch in matrix.ts / hooks/matrix.ts / utils/matrix.ts switches to this helper (grep `'usdt'` in those three files; the review counted branches at redux/matrix.ts:1814,2025,2083, utils/matrix.ts:496, hooks/matrix.ts:1471,2048). `'unsupported'` → no auto-claim, no accept button, bubble text = the new i18n string, never sats-formatted.

- [ ] **Step 1: Failing test:** payment event with `unit: 'other'` → `makeMatrixPaymentText` returns the unsupported string (not "1,000 SATS"); auto-claim dispatch performs no `receiveEcash`/`usdtReceiveEcash` call.
- [ ] **Step 2:** Run → fails. **Step 3:** implement helper + sweep the branches. **Step 4:** all payment tests pass; tsc clean.
- [ ] **Step 5: Commit** `fix(chat): unknown ecash units render as unsupported instead of sats`.

### Task 11: locale-aware USDT amount formatting and parsing

**Files:**
- Modify: `/home/user/projects/fedi/ui/common/utils/usdt.ts` (`formatUsdtMicros`, `parseUsdtInput`, merge `microsToDecimalString`)
- Modify: callers: `ui/native/screens/UsdtSendAmount.tsx` (delete local `microsToAmountInput`), `UsdtReceive.tsx` (delete local `microsToDecimalString`), `ui/native/components/ui/UsdtAmountInput.tsx` (locale decimal key)
- Reference conventions: `ui/common/utils/AmountUtils.ts:186,256` (`toLocaleString`, `getDecimalSeparator`), `ui/common/hooks/amount/useAmountInput.ts:196-232` (numpad decimal-symbol remap)
- Test: `/home/user/projects/fedi/ui/common/tests/unit/utils/usdt.test.ts`

**Interfaces:**
- Produces:
  - `formatUsdtMicros(micros: number, opts?: { symbol?: boolean; locale?: string }): string` — grouping/decimal via `Intl.NumberFormat(locale)` exactly as `AmountUtils.toLocaleString` does (integer-math split into whole/frac first; no float path). Default locale = the same source `AmountUtils` uses.
  - `parseUsdtInput(input: string, opts?: { decimalSeparator?: string }): number | null` — rules: strip whitespace and the currency symbol; strip **grouping** separators (the non-decimal one for the locale); a trailing decimal separator is tolerated (returns the integer part — deletes the 4× `replace(/\.$/,'')` caller workaround, review L11); `"1,000"` with en decimal separator `.` parses as **1000 USDT** (comma = grouping), `"1,5"` with de decimal separator `,` parses as 1.5; ambiguous forms that survive neither rule → null. Still integer math + `Number.isSafeInteger` guard.
  - `microsToDecimalString(micros: number): string` exported from usdt.ts (plain `.`-decimal machine format for URIs/inputs — NOT locale-formatted; document the distinction).

- [ ] **Step 1: Failing tests** (extend usdt.test.ts):

```ts
expect(parseUsdtInput('1,000', { decimalSeparator: '.' })).toBe(1_000_000_000) // 1000 USDT in micros
expect(parseUsdtInput('1,5', { decimalSeparator: ',' })).toBe(1_500_000)
expect(parseUsdtInput('1.', { decimalSeparator: '.' })).toBe(1_000_000)
expect(formatUsdtMicros(1_234_560_000, { locale: 'de-DE' })).toBe('1.234,56 USDT')
expect(formatUsdtMicros(1_234_560_000, { locale: 'en-US' })).toBe('1,234.56 USDT')
```

- [ ] **Step 2:** Run → fails. **Step 3:** implement; update `UsdtAmountInput` so the numpad's decimal key inserts the locale separator (mirror useAmountInput.ts:196-232) and callers pass the separator into `parseUsdtInput`. Remove the four `.replace(/\.$/, '')` call-site hacks (UsdtSendAmount.tsx:66, UsdtReceive.tsx:110, UsdtSendOfflineAmount.tsx:50, ChatWalletUsdt.tsx:37).
- [ ] **Step 4:** usdt.test.ts + native tsc pass. **Step 5: Commit** `fix(usdt): locale-aware amount formatting and parsing`.

### Task 12: unify chat payment thunks/hooks on a unit parameter

**Files:**
- Modify: `/home/user/projects/fedi/ui/common/redux/matrix.ts` — `sendMatrixPaymentPush` (:1574) and `sendMatrixPaymentRequest` (:1644) gain `unit?: RpcEcashUnit`; DELETE `sendMatrixUsdtPaymentPush`/`sendMatrixUsdtPaymentRequest` (:1684-1795)
- Modify: `/home/user/projects/fedi/ui/common/hooks/chat.ts` — fold `useChatUsdtPayment` (:185) into `useChatPaymentPush` (:136) via a unit arg
- Modify callers: grep `sendMatrixUsdtPaymentPush\|sendMatrixUsdtPaymentRequest\|useChatUsdtPayment` under `ui/` (native ChatWallet/ChatWalletUsdt/ConfirmSendChatPayment)
- Modify: `/home/user/projects/fedi/ui/native/screens/ConfirmSendChatPayment.tsx` — merge the duplicated USDT layout block (:214-334) into the BTC component's send-to/notes/layout (:115-209), branching only on amount rendering + dispatch args
- Test: `ui/common/tests/unit/matrix/payment.test.ts`, `ui/common/tests/unit/hooks/pay.test.ts`

**Interfaces:**
- Produces: `sendMatrixPaymentPush({ fedimint, federationId, recipientId, amount, unit? /* default bitcoin */, notes? })` — when `unit === 'usdt'`: amount is micros, ecash from `usdtGenerateEcash`, zero-fee path, message stamps `unit` + `inviteCode` (behavior identical to the deleted clone; the message wire format MUST NOT change — assert in tests). Same pattern for request.

- [ ] **Step 1:** Snapshot the current message `content` produced by both USDT thunks in a test (wire-format lock), using existing test harness mocks.
- [ ] **Step 2:** Merge thunks behind the unit param; delete clones; update hooks + call sites.
- [ ] **Step 3:** Wire-format tests pass unchanged; full `yarn workspace @fedi/common test`; native tsc.
- [ ] **Step 4: Commit** `refactor(chat): single unit-parameterized payment thunk pair`.

---

## Phase 4 — Native UI (fedi, `ui/native`)

### Task 13: EVM addresses in the omni parser + one scanner to rule them all

**Files:**
- Modify: `/home/user/projects/fedi/ui/common/types/parser.ts:5-28` (add `ParserDataType.EvmAddress`), `ui/common/utils/parser.ts:88-152` (offline parser)
- Modify: `/home/user/projects/fedi/ui/native/components/feature/omni/OmniConfirmation.tsx` (route case)
- Modify: `/home/user/projects/fedi/ui/native/screens/UsdtSend.tsx` (replace private scanner with `OmniInput`, delete the bespoke handler at :41-73)
- Modify: `/home/user/projects/fedi/ui/native/utils/linking.ts:58-67` (`SUPPORTED_PREFIXES` += `ethereum:`), `ui/native/android/app/src/main/AndroidManifest.xml` intent filters, `ui/native/ios/FediReactNative/Info.plist` `CFBundleURLSchemes`
- Modify: `/home/user/projects/fedi/ui/common/utils/usdt.ts` (`parseUsdtRecipientInput` — wrap `decodeURIComponent` in try/catch returning null, review L10)
- Test: `ui/common/tests/unit/utils/parser.test.ts` (create if absent — check for an existing parser test first), `ui/common/tests/unit/utils/usdt.test.ts`

**Interfaces:**
- Produces: `ParserDataType.EvmAddress` with data `{ address: string, amountMicros?: number }`, produced by an **offline** parser wrapping `parseUsdtRecipientInput` (bare `0x…` 40-hex and `ethereum:` URIs, custom `amount` param). Add to `BLOCKED_PARSER_TYPES_BEFORE_FEDERATION` (parser.ts:47-65 region). OmniConfirmation routes it to `UsdtSendAmount` with the prefilled address/amount, gated on `selectPaymentFederation` supporting USDT — if no USDT federation, show the existing "can't handle this" copy with a distinct i18n key `feature.omni.unsupported-no-usdt-federation` ("Scan this from a wallet that has a USDT account."). `UsdtSend` becomes `OmniInput` with `expectedInputTypes={[EvmAddress, FedimintEcash, …]}` — its custom ecash-probe and toasts are deleted; cross-QR types now route wherever omni routes them.

- [ ] **Step 1: Failing parser tests:** `parseUserInput('0x' + '11'.repeat(20))` → EvmAddress; `parseUserInput('ethereum:0xAbC…?amount=5.00')` → EvmAddress with `amountMicros === 5_000_000`; `parseUsdtRecipientInput('ethereum:0x…?amount=%')` → null (no throw).
- [ ] **Step 2:** Run → fail. **Step 3:** implement parser + type + blocked-list + confirmation route + UsdtSend conversion + scheme registration (grep how `bitcoin:` appears in BOTH manifests and mirror every occurrence).
- [ ] **Step 4:** parser/usdt tests pass; native tsc; manual emulator smoke deferred to Task 18.
- [ ] **Step 5: Commit** `feat(omni): recognize EVM addresses and ethereum: URIs everywhere`.

### Task 14: unit-aware notifications

**Files:**
- Modify: `/home/user/projects/fedi/ui/native/utils/notifications.ts:150-191`
- Modify: `/home/user/projects/fedi/ui/common/components/FediBridgeInitializer.tsx:92-105` region (add `usdtDeposit` listener → notification dispatch, mirroring the `transaction` listener)
- Test: `ui/native/tests/unit/` — follow whatever harness exists for notifications; if none, cover the pure formatting split in a new small util with a test in common.

**Interfaces:**
- Consumes: Task 5's `RpcTransaction.unit`.
- Produces: `displayPaymentReceivedNotification` branches on `transaction.unit`: `usdt` → `formatUsdtMicros(amount)` (Task 11), else existing sats path. New: a `usdtDeposit` event in `Claimed` state triggers the same notification path with the net amount and i18n key `feature.usdt.deposit-received-notification` ("USDT deposit received: {{amount}}").

- [ ] **Step 1:** Extract the amount-line formatting into a pure `formatNotificationAmount(tx: { amount, unit })` in `ui/common/utils` with failing tests (micros→"5.00 USDT", msats→"5,000 SATS").
- [ ] **Step 2:** Implement + wire both listeners. **Step 3:** tests + tsc pass. **Step 4: Commit** `fix(native): notifications show USDT amounts and fire on deposits`.

### Task 15: native UX mediums — copy address, offline routing, history refresh

**Files:**
- Modify: `/home/user/projects/fedi/ui/native/screens/UsdtReceive.tsx:117-120` — `body` = bare address always; the `ethereum:…?amount=` URI only in the QR value/`fullString` (mirror `OnchainReceiveQr.tsx:80-83`).
- Modify: `/home/user/projects/fedi/ui/native/screens/Wallet.tsx:91-94` — when `isOffline && usdt`, navigate to `UsdtSendOfflineAmount` (mirror the BTC branch right below).
- Modify: `/home/user/projects/fedi/ui/native/screens/UsdtHistory.tsx:92,108-142` — pull-to-refresh clears `fetchedTxidsRef` so pending withdrawal badges re-poll; cap the mount-time status fan-out to pending-state rows only.
- Test: extend `ui/native/tests/unit/screens/` only if a harness for these screens exists (check); otherwise verify via tsc + Task 18 emulator pass, and say so in the commit body.

- [ ] **Step 1:** Apply the three changes. **Step 2:** native tsc + existing native tests green. **Step 3: Commit** `fix(native): usdt receive copies bare address, offline send routing, history refresh`.

### Task 16: native component dedup

**Files:**
- Modify: `/home/user/projects/fedi/ui/native/components/feature/receive/ReceiveBitcoinHeader.tsx` → generalize to accept a `title` i18n key prop (or extract `ReceiveHeader`); `UsdtReceiveHeader.tsx` and `ReceiveCashuHeader` become 3-line wrappers or direct usages. DELETE dead copies.
- Modify: `/home/user/projects/fedi/ui/native/screens/SendOfflineQr.tsx` + `UsdtSendOfflineQr.tsx` → one `OfflineQrScreen` component (props: `amountText: string`, `onCancel: () => Promise<void>`, `qrValue: string`, `shareUrl?: string`, `longPressTarget?`) rendered by two thin screens. The share-link prop matters: **omit `shareUrl` for USDT** until the web claim page is unit-aware (Task 17) — until then the Share button hid a wrong-asset page (review H1).
- Modify: `/home/user/projects/fedi/ui/native/components/ui/UsdtAmountInput.tsx` + `AmountInput.tsx` → extract the verbatim ~120 lines (shake animation :112-123/AmountInput:167-178, numpad loop :155-173/:257-275, styles :178-199) into `ui/native/components/ui/NumpadFrame.tsx`; both inputs render it with their own value models.
- Create: `ui/common/hooks/useUsdtAmountInput.ts` — owns `amountInput` state, locale-aware parse (Task 11), `hasInsufficientBalance`, `errorText`; adopt in `UsdtSendAmount`, `UsdtSendOfflineAmount`, `ChatWalletUsdt`, `UsdtReceive` (the 4× trio from review M4).
- Test: existing native unit tests must stay green; `ClaimEcash.test.tsx` and any snapshot tests will show renames — update them.

- [ ] **Step 1:** Header dedup + tsc. **Step 2:** OfflineQr dedup + tsc. **Step 3:** NumpadFrame extraction + tsc + `yarn workspace @fedi/native test`. **Step 4:** `useUsdtAmountInput` + adopt + common tests. **Step 5: Commit** (one commit per step is fine, or one `refactor(native): dedupe usdt screens into shared components` — keep steps separable for review).

---

## Phase 5 — Web (fedi, `ui/web`)

### Task 17: minimal honest USDT support on web

**Files:**
- Modify: `/home/user/projects/fedi/ui/web/src/pages/ecash.tsx:100-140` — use `validateEcash`'s `unit` (+ Task 5's NotJoined unit): `usdt` → `formatUsdtMicros(amount)`; `unit` null/unknown on a v2 note → render the amount with i18n `words.unknown`-style unit copy, never "SATS". Claim path routes by unit (`usdtReceiveEcash` vs `receiveEcash`) — the redux/units work from Phase 3 is shared, so this is wiring, not new logic.
- Modify: web's provider root (grep where web mounts common managers, e.g. `ui/web/src/pages/_app.tsx` or equivalent) — mount `UsdtMonitorManager` so auto-claimed USDT refreshes a balance the shared selectors can see.
- Modify: the chat request-accept path's misleading toast (hooks/matrix.ts:663 `errors.please-join-a-federation` case): when the block reason is USDT-on-web-without-balance-surface, show new key `errors.usdt-not-supported-on-web` ("USDT payments aren't fully supported on web yet — use the mobile app.") — honest failure beats wrong instruction.
- Test: web tsc (`yarn workspace @fedi/web run tsc --noEmit` — confirm the workspace name from ui/package.json); web unit-test harness if present for ecash page.

- [ ] **Step 1:** ecash page unit-awareness (failing test if the page has a test file; otherwise tsc-driven). **Step 2:** monitor mount + toast fix. **Step 3:** tsc clean. Re-enable the USDT `shareUrl` in Task 16's `OfflineQrScreen` (remove the omission) in this task's commit.
- [ ] **Step 4: Commit** `fix(web): unit-aware ecash claim page and honest usdt messaging`.

---

## Phase 6 — Release engineering

### Task 18: pin, full verification, artifact

**Files:**
- Modify: `/home/user/projects/fedi/Cargo.toml:255-319` — convert every `branch = "v0.11.0-fedi7-usdt"` patch entry to `rev = "<final backport sha>"` (tag the backport rev `v0.11.0-fedi7-usdt.1` on elsiribot/fedimint first and reference the rev; fix the stale "sibling worktree" comment above the patch block).

- [ ] **Step 1:** Tag + pin + `cargo update` + verify Cargo.lock rev == pin.
- [ ] **Step 2: Full gate:** `cargo check --workspace --tests`, `cargo clippy -p federations -p fedi-ffi`, `just generate-bridge-bindings` (must be a no-op diff), `tsc --noEmit` (common, native, web), `yarn workspace @fedi/common test`, `yarn workspace @fedi/native test`, then BOTH e2e runs (existing usdt e2e + Task 4's mixed-fed test) via nohup+monitor.
- [ ] **Step 3: Emulator smoke** (running-local-android skill): scan an `ethereum:` QR from the global scanner → lands on UsdtSendAmount; scan USDT ecash from global scanner → unit-aware claim; USDT receive → copy → clipboard is bare `0x…`; history pull-to-refresh updates a pending withdrawal badge. Screenshots of each.
- [ ] **Step 4:** Rebuild `/home/user/erics-fedi.apk` (dev flavor `-PdevId=eric -PdevName="Eric's Fedi"`; force `:app:createBundle<Variant>JsAndAssets --rerun-tasks`; verify feature markers inside the APK bundle — e.g. grep the bundle for `unsupported-no-usdt-federation` — before shipping).
- [ ] **Step 5: Commit** `build: pin fedimint patch to immutable rev` + final summary report with screenshots.

---

## Review-finding → task traceability

| Finding (review ID) | Task |
|---|---|
| H: mixed BTC+USDT breaks BTC mint path | 2, 3, 4 |
| H: chat trusts sender-declared amount | 8 |
| H: web claim link shows SATS / web blind spots | 17 (+16 interim guard) |
| H: no EVM input in omni parser / private scanner / `ethereum:` scheme | 13 |
| H: notifications micros-as-SATS, silent deposits | 5, 14 |
| H: not-joined/loading USDT ecash shows SATS | 1, 3, 5 |
| M: reclaim retry-loop | 9 |
| M: history truncation + stuck badges + hand-rolled list | 6, 15, 16 |
| M: `unit==='usdt'` fallthrough | 10 |
| M: "1,000" comma parse | 11 |
| M: en-US-only formatting | 11 |
| M: copy button copies URI | 15 |
| M: offline send routing | 15 |
| M: Cargo patch on mutable branch | 18 |
| ARCH: unit-keyed mintv2 accessor | 2, 3 |
| ARCH: UI copy-paste inventory | 16 |
| ARCH: cloned-vs-extended thunk split | 12 |
| ARCH: bridge generate_ecash/invite dup, wrapper arg order | 7 |
| (fixed pre-plan: one-shot deposit watch, watcher death, claim race, gross/net events) | — done in dfc68e09/cc29568 |
