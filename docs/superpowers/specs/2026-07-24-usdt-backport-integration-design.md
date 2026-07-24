# USDt support in Fedi: fedimint backport + app integration

Date: 2026-07-24
Status: approved-for-implementation (autonomous session; user gave full task spec up front)

## Goal

Bring the experimental USDt-on-EVM wallet module (fedimint branch `2026-07-usdt-wallet`,
based on upstream master) to the fedimint version Fedi ships (`fedibtc/fedimint` tag
`v0.11.0-fedi7`), publish it as a branch on the `elsiribot/fedimint` fork, and integrate
it into the Fedi app (bridge + native UI) using the stability pool "Stable Balance"
design language. USDt must work both alongside BTC and standalone (USDt-only
federations, e.g. the provided test federation).

## Background (from exploration)

- The USDt module: threshold-ECDSA (cggmp21) custodied ERC-4337 USDT wallet. New crates
  `modules/fedimint-usdt-{common,client,server,tests}` + `crypto/threshold-ecdsa`.
  USDT balance is *not* held in the usdt module: it is USDT-denominated ecash in a
  second `mintv2` instance with `AmountUnit::new_custom(1)` (`USDT_UNIT`). The client
  reads balance via `Client::get_balance_for_unit(USDT_UNIT)`.
- Backport gap (`v0.11.0-fedi7` vs USDt base `be854220fcc`): core module traits are
  byte-identical (dummy module unchanged); edition/toolchain/tokio identical;
  `mintv2.amount_unit` multi-asset support already exists in fedi7. Friction points:
  (1) the USDt branch re-introduces a typed config-gen params system (breaking
  `ServerModuleInit` change), (2) `EnvVarDoc`/`get_documented_env_vars` doesn't exist in
  v0.11, (3) `Amounts` lacks `Encodable/Decodable` + `checked_sub` in v0.11,
  (4) devimint diverged substantially, (5) client `spawn_cancellable`/`client_span`
  helpers missing in v0.11.
- Fedi bridge: modules registered in `crates/federations/src/federation_v2/mod.rs`
  `build_client_builder()`; typed accessors in `client.rs` (`ClientExt`); RPCs in
  `bridge/fedi-ffi/src/rpc.rs` via `federation_rpc_method!` + `rpc_methods!`; TS
  bindings via `just generate-bridge-bindings`; events in `crates/rpc-types/src/event.rs`.
- Fedi UI: Wallet tab uses a `paymentType` switcher (`'bitcoin' | 'stable-balance'`) and
  one `BalanceCard`; stability pool screens `Stability*.tsx`; module availability
  detected from client config module kinds (`useIsStabilityPoolSupported`).

## Design decisions

### D1. Backport strategy: squash-apply, minimal core churn

New branch `v0.11.0-fedi7-usdt` on `elsiribot/fedimint`, based on tag `v0.11.0-fedi7`.

- Copy the self-contained new crates wholesale (usdt-common/client/server/tests,
  threshold-ecdsa) and hand-port shared-file hunks (workspace Cargo.toml, envs,
  fedimintd/cli registration, nix dev shell foundry+m4, devimint anvil support).
- **Do not port the typed config-gen-params refactor.** Instead adapt the USDt server
  module (and the mintv2 `amount_unit` second instance) to v0.11's existing config-gen
  flow with env-var-driven parameters (`FM_USDT_*`, `FM_MINTV2_AMOUNT_UNIT`,
  `FM_ENABLE_MODULE_USDT`), matching how fedi's fedimintd already env-gates modules.
  This keeps `ServerModuleInit` ABI unchanged, so fedi's vendored server modules
  (stability-pool v1/v2, fedi-social) compile untouched, and dramatically shrinks the
  fedi-side upgrade. Cost: divergence from the master-based branch for future rebases —
  acceptable for an experimental backport.
- Micro-backports into core crates where genuinely needed, additive only:
  per-unit primary-output await (`await_primary_module_outputs_for_unit`),
  `Amounts: Encodable/Decodable` (+`checked_sub`) if USDt encodes them, new
  `FM_USDT_*` env constants. Drop `get_documented_env_vars` usage.
- Rewrite USDt crate versions to the fedi7 workspace version (0.11.0-rc.1),
  regenerate Cargo.lock.
- Structure as a small number of logical commits (core micro-backports; new crates;
  server/cli/devimint wiring; nix/scripts/docs).

### D2. Fedimint verification

In the fedimint nix dev shell: `cargo build` workspace, run the hermetic
`fedimint-usdt-tests` suite (MockEvmRpc, no anvil), the live-anvil e2e tests, and the
devimint `anvil-smoke-test`. Then push to `elsiribot/fedimint`.

### D3. Fedi dependency switch

Fedi workspace `Cargo.toml`: repoint all fedimint git deps from
`fedibtc/fedimint tag v0.11.0-fedi7` to `elsiribot/fedimint branch v0.11.0-fedi7-usdt`
(pinned by rev at the end), add `fedimint-usdt-client`/`-common` deps. During
development, use the commented-out local-path override workflow against
`../fedimint`. Update fedi's vendored `fedimintd`/`fedimint-cli`/`devi` to register the
USDt server/client modules env-gated (`FM_ENABLE_MODULE_USDT`), so devfed can run
USDt federations locally.

### D4. Bridge integration (mirrors stability pool patterns)

- Register `UsdtClientInit` in `build_client_builder()`; add `ClientExt::usdt()`.
- `FederationV2` methods + RPCs (all federation-scoped, ts-rs exported):
  - `usdtBalance(federation) -> RpcAmount` (from `get_balance_for_unit(USDT_UNIT)`) and
    `usdtSubscribeBalance` stream (balance events on the USDT unit).
  - `usdtGenerateAddress(federation) -> String` — `allocate_deposit()`, spawn
    background `check_and_claim` watcher; re-arm watchers on startup for unclaimed keys.
  - `usdtDepositStatus(federation, address) -> RpcUsdtDepositStatus`.
  - `usdtWithdrawFeeQuote(federation, amount) -> RpcAmount`.
  - `usdtWithdraw(federation, recipient, amount, maxFee) -> RpcOperationId`, with
    operation-log metadata + `UsdtWithdrawal` event on confirmation.
  - `usdtRecoverDeposits(federation)` for seed recovery.
  - Deposit claims emit a `UsdtDeposit` event and appear in the transaction list
    (operation-log meta like SPv2's `frontend_meta`).
- USDT ecash send/receive rides the existing mintv2 ops (unit-aware); verify
  `receiveEcash`/`generateEcash` paths handle the custom unit; extend if needed
  (needed to redeem the provided test ecash).
- Availability: UI detects kind `"usdt"` in the federation client config (same as
  stability pool detection); no new remote feature flag.

### D5. UI (stability pool design language)

- Extend `paymentType` union with `'usdt'` (`common/redux/environment.ts`).
- `Wallet.tsx`: switcher gains a "USDT" option when the federation has the usdt module;
  for USDt-only federations (no wallet/ln modules) the switcher hides and paymentType is
  forced to `'usdt'` (mirror of today's BTC-only behavior).
- `BalanceCard.tsx`: third branch — icon `UsdCircleFilled` in Tether teal, title
  "USDT balance" (i18n `feature.usdt.*`), primary amount formatted as USD-style fiat
  from the 10^-6 USDT unit.
- New screens mirroring stability pool: `UsdtReceive` (on-chain deposit address QR +
  copy; ecash receive already global), `UsdtSend` (recipient EVM address + amount +
  fee quote), `UsdtConfirmWithdraw`, `UsdtHistory` (transactions list filtered to USDT
  unit + usdt operations). Components under
  `native/components/feature/usdt/` modeled on `stabilitypool/` equivalents.
- Hooks `common/hooks/usdt.ts` (`useUsdtBalance`, `useUsdtForm`s), redux additions in
  `common/redux/wallet.ts`, module detection `useIsUsdtSupported` in
  `common/hooks/federation.ts`, strings in `common/localization/en/common.json`
  (`feature.usdt`), `SelectWalletOverlay`/`SelectFederationOverlay` gain a USDT
  `BalanceItem`.
- Native app only (Android emulator screenshots); web PWA out of scope.

### D6. Testing

- fedimint backport branch: existing USDt hermetic + live-anvil test suites must pass
  in the nix dev shell.
- fedi bridge integration tests (`bridge/fedi-ffi`): extend devi/devfed to start anvil
  and a USDt-enabled federation (env-driven); tests for: join USDt-only fed, deposit →
  claim → balance, withdraw → confirmed, ecash round-trip in USDT unit.
- Manual/e2e: Android emulator via the running-local-android skill — join the provided
  test federation invite code, redeem the provided USDT ecash, exercise
  receive/send/history screens; capture screenshots of the main interactions.

## Out of scope

- Fedi fee schedule for USDt operations (zero-fee initially).
- Web PWA UI, iOS build, guardian setup UI for USDt params.
- Production EVM deployment concerns (Sepolia runbook stays in fedimint docs).

## Risks

- The provided test federation was presumably created by fedimintd built from the
  master-based USDt branch; the backport keeps consensus encodings identical (same
  common crate), so a v0.11-based client should interoperate — verified empirically by
  joining it in tests/emulator. Any mismatch in core consensus encoding between v0.11
  and master would surface at join time; mitigation: test early with the invite code
  right after the bridge integration compiles.
- cggmp21/alloy dependency tree must resolve against the fedi7 lockfile (no known
  conflicts; secp256k1 versions match).
- The "fediminte..." ecash string suggests a unit-tagged mintv2 note encoding; if the
  bridge's ecash receive path is v1-mint-only, mintv2-unit receive support must be added
  to the bridge (covered in D4).
