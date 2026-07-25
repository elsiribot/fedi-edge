use anyhow::{Context, Result, anyhow, bail};
use bug_report::reused_ecash_proofs::SerializedReusedEcashProofs;
use fedimint_client::module::oplog::OperationLogEntry;
use fedimint_core::base32::{FEDIMINT_PREFIX, decode_prefixed};
use fedimint_core::core::OperationId;
use fedimint_core::{Amount, apply, async_trait_maybe_send};
use fedimint_mintv2_client::{
    ECash as MintV2ECash, FinalReceiveOperationState as MintV2FinalReceiveOperationState,
    MintOperationMeta as MintV2OperationMeta,
};
use rpc_types::error::ErrorCode;
use rpc_types::{
    EcashReceiveMetadata, EcashReceiveReason, EcashSendMetadata, FrontendMetadata, RpcAmount,
    RpcEcashUnit, RpcGenerateEcashResponse, RpcOOBReissueState, RpcOOBSpendState, RpcOperationId,
    RpcTransactionDirection, RpcTransactionKind,
};
use tracing::warn;

use super::super::client::ClientExt;
use super::super::{FederationTransactionParts, FederationV2, get_max_spendable_amount};
use super::MintOps;

pub struct MintOpsV2;

#[apply(async_trait_maybe_send!)]
impl MintOps for MintOpsV2 {
    async fn get_raw_balance(&self, fed: &FederationV2) -> Amount {
        // Only the BITCOIN-denominated mint contributes to the Bitcoin
        // balance. A USDT-only federation has no such instance, so its
        // Bitcoin balance is zero; USDT notes are surfaced through the
        // dedicated account (usdtBalance) instead.
        let Ok(mintv2) = fed
            .client
            .mintv2_of_unit(fedimint_core::module::AmountUnit::BITCOIN)
            .await
        else {
            return Amount::ZERO;
        };
        mintv2
            .get_count_by_denomination()
            .await
            .into_iter()
            .map(|(denom, count)| Amount::from_msats(denom.amount().msats * count))
            .fold(Amount::ZERO, |acc, amount| acc + amount)
    }

    async fn receive_ecash(
        &self,
        fed: &FederationV2,
        ecash: String,
        frontend_meta: FrontendMetadata,
    ) -> Result<(Amount, OperationId)> {
        let ecash: MintV2ECash = decode_prefixed(FEDIMINT_PREFIX, &ecash)?;
        let amount = ecash.amount();
        // Route by the note's own unit so a USDT note claimed through the
        // generic path lands in the USDT-denominated mint; legacy unitless
        // notes default to the Bitcoin mint.
        let note_unit = ecash
            .unit()
            .unwrap_or(fedimint_core::module::AmountUnit::BITCOIN);
        let mintv2 = fed.client.mintv2_of_unit(note_unit).await?;
        let fee_ppms = fed
            .get_fee_ppms_by_stream(fedimint_mint_client::KIND, RpcTransactionDirection::Receive)
            .await?;
        let custom_meta = serde_json::to_value(EcashReceiveMetadata {
            internal: false,
            reason: EcashReceiveReason::Receive,
            frontend_metadata: Some(frontend_meta),
            // Stamp the note's own unit so USDT notes claimed through this
            // generic receive path are attributed to USDT history.
            unit: super::super::usdt::rpc_ecash_unit(note_unit),
        })?;
        let operation_id = mintv2.receive(ecash, custom_meta).await?;
        fed.write_pending_receive_fedi_fee_ppms(operation_id, &fee_ppms)
            .await?;
        let _ = fed.record_tx_date_fiat_info(operation_id, amount).await;
        fed.subscribe_to_operation(operation_id).await?;
        Ok((amount, operation_id))
    }

    async fn subscribe_to_ecash_reissue(
        &self,
        _fed: &FederationV2,
        _operation_id: OperationId,
        _amount: Amount,
    ) -> Result<()> {
        Ok(())
    }

    async fn generate_ecash(
        &self,
        fed: &FederationV2,
        amount: Amount,
        include_invite: bool,
        frontend_meta: FrontendMetadata,
    ) -> Result<RpcGenerateEcashResponse> {
        let _guard = fed.generate_ecash_lock.lock().await;
        let mintv2 = fed
            .client
            .mintv2_of_unit(fedimint_core::module::AmountUnit::BITCOIN)
            .await?;
        let fees_by_stream = fed
            .get_fee_amounts_by_stream(
                fedimint_mint_client::KIND,
                RpcTransactionDirection::Send,
                amount,
            )
            .await?;
        let total_fedi_fee_ppm = FederationV2::total_fedi_fee_ppm(
            &fed.get_fee_ppms_by_stream(fedimint_mint_client::KIND, RpcTransactionDirection::Send)
                .await?,
        );
        let fedi_fee = FederationV2::total_fedi_fee_amount(&fees_by_stream);
        let spend_guard = fed.spend_guard.lock().await;
        let virtual_balance = fed.get_balance().await;
        if amount + fedi_fee > virtual_balance {
            bail!(ErrorCode::InsufficientBalance(RpcAmount(
                get_max_spendable_amount(virtual_balance, total_fedi_fee_ppm, None, None)
            )));
        }
        let custom_meta = serde_json::to_value(EcashSendMetadata {
            internal: false,
            frontend_metadata: Some(frontend_meta),
            // This path always selects the BITCOIN-unit mint.
            unit: RpcEcashUnit::Bitcoin,
        })?;
        let (operation_id, ecash) = mintv2.send(amount, custom_meta).await?;
        let sent_amount = ecash.amount();
        let ecash = fed
            .stamp_and_encode_generated_ecash(
                ecash,
                fedimint_core::module::AmountUnit::BITCOIN,
                include_invite,
            )
            .await;
        let settled_fees_by_stream = fed
            .get_fee_amounts_by_stream(
                fedimint_mint_client::KIND,
                RpcTransactionDirection::Send,
                sent_amount,
            )
            .await?;
        let settled_fedi_fee = FederationV2::total_fedi_fee_amount(&settled_fees_by_stream);
        fed.write_pending_send_fedi_fees(operation_id, &settled_fees_by_stream)
            .await?;
        fed.write_success_send_fedi_fees(operation_id).await?;
        // Virtual balance only reflects the send once its fees are written.
        drop(spend_guard);
        let _ = fed
            .record_tx_date_fiat_info(operation_id, sent_amount + settled_fedi_fee)
            .await;
        Ok(RpcGenerateEcashResponse {
            ecash,
            operation_id: RpcOperationId(operation_id),
        })
    }

    async fn cancel_ecash(&self, fed: &FederationV2, ecash: String) -> Result<()> {
        let decoded: MintV2ECash = decode_prefixed(FEDIMINT_PREFIX, &ecash)?;
        let amount = decoded.amount();
        // Cancel reissues the notes back to their own mint, keyed on the
        // note's unit (legacy unitless notes default to Bitcoin).
        let note_unit = decoded
            .unit()
            .unwrap_or(fedimint_core::module::AmountUnit::BITCOIN);
        let mintv2 = fed.client.mintv2_of_unit(note_unit).await?;
        let custom_meta = serde_json::to_value(EcashReceiveMetadata {
            internal: false,
            reason: EcashReceiveReason::Cancel,
            frontend_metadata: None,
            unit: super::super::usdt::rpc_ecash_unit(note_unit),
        })?;
        let operation_id = mintv2
            .receive(decoded, custom_meta)
            .await
            .context(ErrorCode::EcashCancelFailed)?;
        let _ = fed.record_tx_date_fiat_info(operation_id, amount).await;
        let final_state = mintv2
            .await_final_receive_operation_state(operation_id)
            .await
            .context(ErrorCode::EcashCancelFailed)?;
        fed.send_transaction_event(operation_id).await;
        match final_state {
            MintV2FinalReceiveOperationState::Success => {}
            MintV2FinalReceiveOperationState::Rejected => {
                return Err(anyhow!(ErrorCode::EcashCancelFailed));
            }
        }
        Ok(())
    }

    async fn subscribe_oob_spend(&self, _fed: &FederationV2, _op_id: OperationId) -> Result<()> {
        Ok(())
    }

    async fn repair_wallet(&self, _fed: &FederationV2) -> Result<()> {
        // v2 mint has no repair concept; nothing to do.
        Ok(())
    }

    async fn had_reused_ecash(&self, _fed: &FederationV2) -> bool {
        false
    }

    async fn generate_reused_ecash_proofs(
        &self,
        _fed: &FederationV2,
    ) -> anyhow::Result<SerializedReusedEcashProofs> {
        // v2 mint has no reused-note concept.
        Ok(SerializedReusedEcashProofs {
            total_amount_msats: Amount::ZERO,
            reused_ecash_proofs: Vec::new(),
        })
    }

    async fn subscribe_operation(
        &self,
        fed: &FederationV2,
        operation_id: OperationId,
        operation: OperationLogEntry,
    ) {
        match operation.meta::<MintV2OperationMeta>() {
            MintV2OperationMeta::Receive {
                ecash, custom_meta, ..
            } => {
                if let Ok(decoded) = decode_prefixed::<MintV2ECash>(FEDIMINT_PREFIX, &ecash) {
                    let amount = decoded.amount();
                    let note_unit = decoded
                        .unit()
                        .unwrap_or(fedimint_core::module::AmountUnit::BITCOIN);
                    let receive_meta = serde_json::from_value::<EcashReceiveMetadata>(custom_meta)
                        .unwrap_or(EcashReceiveMetadata {
                            internal: false,
                            reason: EcashReceiveReason::Receive,
                            frontend_metadata: None,
                            unit: super::super::usdt::rpc_ecash_unit(note_unit),
                        });
                    let is_fee_exempt =
                        receive_meta.internal || receive_meta.reason == EcashReceiveReason::Cancel;
                    fed.spawn_cancellable("subscribe mintv2 receive", move |fed| async move {
                        let Ok(mintv2) = fed.client.mintv2_of_unit(note_unit).await else {
                            warn!("no mintv2 instance for unit {note_unit:?}");
                            return;
                        };
                        let final_state = mintv2
                            .await_final_receive_operation_state(operation_id)
                            .await;
                        match final_state {
                            Ok(MintV2FinalReceiveOperationState::Success) => {
                                if !is_fee_exempt {
                                    let _ = fed
                                        .write_success_receive_fedi_fees(operation_id, amount)
                                        .await;
                                }
                            }
                            Ok(MintV2FinalReceiveOperationState::Rejected) => {
                                if !is_fee_exempt {
                                    let _ = fed.write_failed_receive_fedi_fees(operation_id).await;
                                }
                            }
                            Err(e) => {
                                warn!("mintv2 await_final_receive failed: {e:?}");
                                return;
                            }
                        }
                        // Outcome is now persisted to the operation log by
                        // outcome_or_updates inside await_final_receive_operation_state,
                        // so we don't need to also stash it in the in-memory map.
                        fed.send_transaction_event(operation_id).await;
                    });
                }
            }
            // Send is terminal at creation time — notes are already
            // gone from the local db and the ECash blob is in the
            // user's hands. No state machine to subscribe to.
            MintV2OperationMeta::Send { .. } => {}
            // Reissue is the internal change-making path of Send;
            // it has no user-facing terminal state we expose today.
            MintV2OperationMeta::Reissue { .. } => {}
        }
    }

    async fn get_transaction(
        &self,
        _fed: &FederationV2,
        _operation_id: OperationId,
        entry: OperationLogEntry,
        fedi_fee_msats: u64,
    ) -> anyhow::Result<Option<FederationTransactionParts>> {
        let mintv2_meta: MintV2OperationMeta = entry.meta();
        match mintv2_meta {
            MintV2OperationMeta::Send { ecash, custom_meta } => {
                let extra_meta = serde_json::from_value::<EcashSendMetadata>(custom_meta)
                    .unwrap_or(EcashSendMetadata {
                        internal: false,
                        frontend_metadata: None,
                        unit: RpcEcashUnit::Bitcoin,
                    });
                if extra_meta.internal {
                    return Ok(None);
                }
                let amount = decode_prefixed::<MintV2ECash>(FEDIMINT_PREFIX, &ecash)
                    .map(|ecash| ecash.amount())
                    .unwrap_or(Amount::ZERO);
                // v2 Send is atomic: notes leave the local db immediately, so there is
                // no spend state machine to map onto. Report the send as Success and
                // surface the ecash string so the tx detail can reclaim or re-share it.
                Ok(Some(FederationTransactionParts {
                    amount: RpcAmount(amount + Amount::from_msats(fedi_fee_msats)),
                    kind: RpcTransactionKind::OobSend {
                        state: Some(RpcOOBSpendState::Success),
                        oob_notes: Some(ecash),
                    },
                    frontend_metadata: extra_meta.frontend_metadata,
                    // Unit stamped on the op's own custom_meta at send time
                    // (see `generate_ecash`/usdt send), not an instance
                    // lookup — that can't distinguish historical ops in a
                    // mixed BTC+USDT federation.
                    unit: extra_meta.unit,
                }))
            }
            MintV2OperationMeta::Receive {
                ecash, custom_meta, ..
            } => {
                let extra_meta = serde_json::from_value::<EcashReceiveMetadata>(custom_meta)
                    .unwrap_or(EcashReceiveMetadata {
                        internal: false,
                        reason: EcashReceiveReason::Receive,
                        frontend_metadata: None,
                        unit: RpcEcashUnit::Bitcoin,
                    });
                if extra_meta.internal {
                    return Ok(None);
                }
                let amount = decode_prefixed::<MintV2ECash>(FEDIMINT_PREFIX, &ecash)
                    .map(|ecash| ecash.amount())
                    .unwrap_or(Amount::ZERO);
                let state = entry
                    .try_outcome::<MintV2FinalReceiveOperationState>()
                    .ok()
                    .flatten()
                    .map(|state| match state {
                        MintV2FinalReceiveOperationState::Success => RpcOOBReissueState::Done,
                        MintV2FinalReceiveOperationState::Rejected => RpcOOBReissueState::Failed {
                            error: "rejected by federation".into(),
                        },
                    });
                Ok(Some(FederationTransactionParts {
                    amount: RpcAmount(amount),
                    kind: if extra_meta.reason == EcashReceiveReason::Cancel {
                        RpcTransactionKind::OobCancel { state }
                    } else {
                        RpcTransactionKind::OobReceive { state }
                    },
                    frontend_metadata: extra_meta.frontend_metadata,
                    // Unit stamped on the op's own custom_meta at receive
                    // time — same rationale as the Send arm above.
                    unit: extra_meta.unit,
                }))
            }
            // Internal change-making op — hide from the tx list.
            MintV2OperationMeta::Reissue { .. } => Ok(None),
        }
    }
}
