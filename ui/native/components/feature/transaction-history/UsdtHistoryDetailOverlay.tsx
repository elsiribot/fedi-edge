import { Text, Theme, useTheme } from '@rneui/themed'
import { TFunction } from 'i18next'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Linking, StyleSheet, TouchableOpacity, View } from 'react-native'

import { useFormatUsdtMicros } from '@fedi/common/hooks/usdt'
import {
    RpcUsdtTransaction,
    RpcUsdtWithdrawalStatus,
} from '@fedi/common/types/bindings'
import dateUtils from '@fedi/common/utils/DateUtils'
import { hexToRgba } from '@fedi/common/utils/color'

import CenterOverlay from '../../ui/CenterOverlay'
import { Column } from '../../ui/Flex'
import SvgImage from '../../ui/SvgImage'
import { HistoryDetailItem, HistoryDetailItemProps } from './HistoryDetailItem'
import { HistoryIcon } from './HistoryIcon'

export const getUsdtTxnKindText = (
    t: TFunction,
    txn: RpcUsdtTransaction,
): string => {
    switch (txn.kind.type) {
        case 'deposit':
            return t('feature.usdt.deposit')
        case 'withdrawal':
            return t('feature.usdt.withdrawal')
        case 'ecashSend':
            return t('feature.usdt.ecash-sent')
        case 'ecashReceive':
            return t('feature.usdt.ecash-received')
    }
}

const getStatusBadgeText = (
    t: TFunction,
    status: RpcUsdtWithdrawalStatus,
): string => {
    switch (status.type) {
        case 'queued':
            return t('feature.usdt.status-queued')
        case 'signing':
            return t('feature.usdt.status-signing')
        case 'submitted':
            return t('feature.usdt.status-submitted')
        case 'confirmed':
            return t('feature.usdt.status-confirmed')
        case 'failed':
            return t('feature.usdt.status-failed')
        case 'unknown':
            return t('feature.usdt.status-pending')
    }
}

/**
 * Colored status badge for a USDT withdrawal, shown in the history
 * detail overlay once the status has been fetched.
 */
const UsdtWithdrawalStatusBadge: React.FC<{
    status: RpcUsdtWithdrawalStatus
}> = ({ status }) => {
    const { t } = useTranslation()
    const { theme } = useTheme()

    const color =
        status.type === 'confirmed'
            ? theme.colors.moneyGreen
            : status.type === 'failed'
              ? theme.colors.red
              : theme.colors.orange

    const style = styles(theme)

    return (
        <View style={[style.badge, { backgroundColor: hexToRgba(color, 0.1) }]}>
            <Text small medium style={{ color }}>
                {getStatusBadgeText(t, status)}
            </Text>
        </View>
    )
}

type Props = {
    show: boolean
    txn: RpcUsdtTransaction | null
    /** Live withdrawal status, polled by the parent while the overlay is open */
    status: RpcUsdtWithdrawalStatus | null
    onClose: () => void
}

/**
 * Detail overlay for a USDT transaction, styled like the Bitcoin
 * transaction detail (HistoryDetailOverlay / HistoryDetail). Withdrawals
 * show a live status badge; deposits show the deposit address; ecash
 * rows just show kind + amount.
 */
const UsdtHistoryDetailOverlay: React.FC<Props> = ({
    show,
    txn,
    status,
    onClose,
}) => {
    const { t } = useTranslation()
    const { theme } = useTheme()
    const formatUsdt = useFormatUsdtMicros()

    const style = styles(theme)

    if (!txn) return <></>

    const items: HistoryDetailItemProps[] = []
    if (txn.kind.type === 'withdrawal' && txn.kind.txid && status) {
        items.push({
            label: t('words.status'),
            value: <UsdtWithdrawalStatusBadge status={status} />,
        })
        if (status.type === 'confirmed') {
            items.push({
                label: t('feature.usdt.block'),
                value: `#${status.block}`,
            })
        } else if (status.type === 'failed') {
            items.push({
                label: t('words.reason'),
                value: status.reason,
            })
        }
    }
    items.push({
        label: t('words.time'),
        value: dateUtils.formatTimestamp(txn.createdAt, 'MMM dd yyyy, h:mmaaa'),
    })
    if (txn.kind.type === 'withdrawal') {
        items.push({
            label: t('words.to'),
            value: txn.kind.recipient,
            copyable: true,
            truncated: true,
        })
        // The federation-internal fedimint txid is deliberately not shown:
        // users paste it into block explorers and conclude the withdrawal
        // is fake. The ERC-4337 user-op hash below is what explorers can
        // actually resolve. Known once the withdrawal reaches Signing;
        // absent for withdrawals confirmed before the app persisted it.
        const opHash =
            status?.type === 'signing' || status?.type === 'submitted'
                ? status.opHash
                : status?.type === 'confirmed'
                  ? status.opHash
                  : null
        if (opHash) {
            items.push({
                label: t('feature.usdt.user-operation'),
                value: opHash,
                copyable: true,
                truncated: true,
            })
            items.push({
                label: t('feature.usdt.view-on-explorer'),
                value: 'jiffyscan.xyz',
                onPress: () =>
                    Linking.openURL(
                        `https://jiffyscan.xyz/userOpHash/${opHash}?network=mainnet`,
                    ),
            })
        }
    } else if (txn.kind.type === 'deposit') {
        items.push({
            label: t('feature.usdt.deposit-address'),
            value: txn.kind.address,
            copyable: true,
            truncated: true,
        })
    }

    return (
        <CenterOverlay
            key="usdt-detail-overlay"
            show={show}
            onBackdropPress={onClose}
            overlayStyle={style.overlayStyle}>
            <View style={style.container}>
                <TouchableOpacity
                    style={style.closeIconContainer}
                    onPress={onClose}>
                    <SvgImage name="Close" size="md" />
                </TouchableOpacity>
                <HistoryIcon badge={txn.incoming ? 'incoming' : 'outgoing'}>
                    {/* Official Tether mark carries its own colors, no tint */}
                    <SvgImage
                        name="UsdtCircle"
                        size={theme.sizes.historyIcon}
                    />
                </HistoryIcon>
                <Text style={style.detailTitle}>
                    {getUsdtTxnKindText(t, txn)}
                </Text>
                <Text h2 medium>
                    {`${txn.incoming ? '+' : '-'}${formatUsdt(txn.amount)}`}
                </Text>
                <Column gap="xs" fullWidth style={style.detailItemsContainer}>
                    {items.map((item, idx) => (
                        <HistoryDetailItem
                            key={idx}
                            {...item}
                            noBorder={idx === items.length - 1}
                        />
                    ))}
                </Column>
            </View>
        </CenterOverlay>
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        overlayStyle: {
            maxWidth: 340,
            alignItems: 'stretch',
        },
        container: {
            alignItems: 'center',
            width: '100%',
        },
        closeIconContainer: {
            alignSelf: 'flex-end',
        },
        detailTitle: {
            marginTop: theme.spacing.sm,
            marginBottom: theme.spacing.xxs,
        },
        detailItemsContainer: {
            marginTop: theme.spacing.xl,
        },
        badge: {
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: theme.spacing.xxs,
            borderRadius: 8,
        },
    })

export default UsdtHistoryDetailOverlay
