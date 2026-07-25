use anyhow::Result;
use bug_report::reused_ecash_proofs::SerializedReusedEcashProofs;
use fedimint_client::module::oplog::OperationLogEntry;
use fedimint_core::base32::{FEDIMINT_PREFIX, decode_prefixed};
use fedimint_core::core::OperationId;
use fedimint_core::{Amount, apply, async_trait_maybe_send};
use fedimint_mintv2_client::ECash as MintV2ECash;
use rpc_types::{FrontendMetadata, RpcGenerateEcashResponse};
use runtime::constants::MINTV2_OPERATION_TYPE;

use super::{MintOps, MintOpsV1, MintOpsV2};
use crate::federation_v2::client::ClientExt;
use crate::federation_v2::{FederationTransactionParts, FederationV2};

/// Routes mint operations to the backend that actually holds the money for the
/// federation's shape, mirroring [`super::super::ln_ops::router::LnOpsRouter`].
///
/// A federation carries at most ONE `mintv2` instance per unit and never two
/// `mintv2` instances of the same kind, so config-gen produces exactly four
/// shapes:
///
/// - (a) kind-one Bitcoin: mintv1 (`"mint"`), no mintv2.
/// - (b) kind-two Bitcoin: mintv2(BITCOIN), no mintv1.
/// - (c) USDT-only: mintv2(USDT) only, no mintv1, no BITCOIN mintv2.
/// - (d) mixed: mintv1 + usdt module's mintv2(USDT).
///
/// The Bitcoin balance/e-cash lives in mintv1 whenever it is present (shapes a
/// and d) and in mintv2(BITCOIN) otherwise (shape b); shape (c) has no Bitcoin
/// mint at all. Note-driven ops (`receive_ecash`/`cancel_ecash`) route by the
/// note's own wire format, and operation-log-driven ops route by the entry's
/// module kind. This keeps a mixed federation's real mintv1 Bitcoin balance
/// visible while the usdt module's USDT mintv2 handles USDT e-cash.
pub struct MintOpsRouter;

impl MintOpsRouter {
    /// The mint backend that owns this federation's Bitcoin balance/e-cash:
    /// mintv1 when present (shapes a, d), else mintv2 (shape b, or shape c
    /// where the BITCOIN path is empty/errors cleanly).
    fn btc(&self, fed: &FederationV2) -> &'static dyn MintOps {
        if fed.client.mint().is_ok() {
            &MintOpsV1
        } else {
            &MintOpsV2
        }
    }

    /// Whether the operation was created by the `mintv2` module. Note-driven
    /// and balance ops are routed structurally; this is only for the two
    /// internal v1-subscription helpers whose caller has just an
    /// [`OperationId`].
    async fn is_mintv2_op(&self, fed: &FederationV2, operation_id: OperationId) -> bool {
        fed.client
            .operation_log()
            .get_operation(operation_id)
            .await
            .map(|op| op.operation_module_kind() == MINTV2_OPERATION_TYPE)
            // A missing op-log entry means "not a mintv2 op": callers fall back
            // to the v1 (mintv1) path, which is a safe no-op for an unknown id.
            .unwrap_or(false)
    }
}

#[apply(async_trait_maybe_send!)]
impl MintOps for MintOpsRouter {
    async fn get_raw_balance(&self, fed: &FederationV2) -> Amount {
        // Bitcoin balance only. mintv1 holds it in shapes (a)/(d); mintv2
        // (BITCOIN) in shape (b); shape (c) has none, so MintOpsV2 returns ZERO.
        self.btc(fed).get_raw_balance(fed).await
    }

    async fn receive_ecash(
        &self,
        fed: &FederationV2,
        ecash: String,
        frontend_meta: FrontendMetadata,
    ) -> Result<(Amount, OperationId)> {
        // Route by the note's own wire format: v2 `ECash` (base32,
        // FEDIMINT-prefixed) goes to the v2 mint, which further routes by the
        // note's `unit()`; everything else is legacy v1 `OOBNotes`.
        if decode_prefixed::<MintV2ECash>(FEDIMINT_PREFIX, &ecash).is_ok() {
            MintOpsV2.receive_ecash(fed, ecash, frontend_meta).await
        } else {
            MintOpsV1.receive_ecash(fed, ecash, frontend_meta).await
        }
    }

    async fn subscribe_to_ecash_reissue(
        &self,
        fed: &FederationV2,
        operation_id: OperationId,
        amount: Amount,
    ) -> Result<()> {
        // Reissue-subscription is a v1-mint concept (v2 resolves receives
        // inline). Dispatch by the operation's module so a v2 op no-ops
        // correctly in a mixed federation.
        if self.is_mintv2_op(fed, operation_id).await {
            MintOpsV2
                .subscribe_to_ecash_reissue(fed, operation_id, amount)
                .await
        } else {
            MintOpsV1
                .subscribe_to_ecash_reissue(fed, operation_id, amount)
                .await
        }
    }

    async fn generate_ecash(
        &self,
        fed: &FederationV2,
        amount: Amount,
        include_invite: bool,
        frontend_meta: FrontendMetadata,
    ) -> Result<RpcGenerateEcashResponse> {
        // Bitcoin-denominated send: draw from wherever the BTC balance lives.
        self.btc(fed)
            .generate_ecash(fed, amount, include_invite, frontend_meta)
            .await
    }

    async fn cancel_ecash(&self, fed: &FederationV2, ecash: String) -> Result<()> {
        // Same note-format dispatch as receive: the reclaim must go back to the
        // mint that issued the notes.
        if decode_prefixed::<MintV2ECash>(FEDIMINT_PREFIX, &ecash).is_ok() {
            MintOpsV2.cancel_ecash(fed, ecash).await
        } else {
            MintOpsV1.cancel_ecash(fed, ecash).await
        }
    }

    async fn subscribe_oob_spend(&self, fed: &FederationV2, op_id: OperationId) -> Result<()> {
        // Only v1 spends have an out-of-band spend state machine; v2 sends are
        // terminal at creation. Dispatch by the operation's module.
        if self.is_mintv2_op(fed, op_id).await {
            MintOpsV2.subscribe_oob_spend(fed, op_id).await
        } else {
            MintOpsV1.subscribe_oob_spend(fed, op_id).await
        }
    }

    async fn repair_wallet(&self, fed: &FederationV2) -> Result<()> {
        // Note repair is a v1-mint concept; v2's impl is a no-op.
        self.btc(fed).repair_wallet(fed).await
    }

    async fn had_reused_ecash(&self, fed: &FederationV2) -> bool {
        // Reused-note detection only exists for the v1 mint.
        self.btc(fed).had_reused_ecash(fed).await
    }

    async fn generate_reused_ecash_proofs(
        &self,
        fed: &FederationV2,
    ) -> anyhow::Result<SerializedReusedEcashProofs> {
        self.btc(fed).generate_reused_ecash_proofs(fed).await
    }

    async fn subscribe_operation(
        &self,
        fed: &FederationV2,
        operation_id: OperationId,
        operation: OperationLogEntry,
    ) {
        // Op-log driven: dispatch by the entry's own module kind.
        if operation.operation_module_kind() == MINTV2_OPERATION_TYPE {
            MintOpsV2
                .subscribe_operation(fed, operation_id, operation)
                .await
        } else {
            MintOpsV1
                .subscribe_operation(fed, operation_id, operation)
                .await
        }
    }

    async fn get_transaction(
        &self,
        fed: &FederationV2,
        operation_id: OperationId,
        entry: OperationLogEntry,
        fedi_fee_msats: u64,
    ) -> anyhow::Result<Option<FederationTransactionParts>> {
        // Op-log driven: dispatch by the entry's own module kind.
        if entry.operation_module_kind() == MINTV2_OPERATION_TYPE {
            MintOpsV2
                .get_transaction(fed, operation_id, entry, fedi_fee_msats)
                .await
        } else {
            MintOpsV1
                .get_transaction(fed, operation_id, entry, fedi_fee_msats)
                .await
        }
    }
}
