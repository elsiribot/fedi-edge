import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Text, Theme, useTheme } from '@rneui/themed'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    ActivityIndicator,
    FlatList,
    ListRenderItem,
    Pressable,
    RefreshControl,
    StyleSheet,
} from 'react-native'

import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import { useFormatUsdtMicros } from '@fedi/common/hooks/usdt'
import { TransactionStatusBadge } from '@fedi/common/types'
import type { RpcUsdtWithdrawalStatus } from '@fedi/common/types/bindings'
import dateUtils from '@fedi/common/utils/DateUtils'
import stringUtils from '@fedi/common/utils/StringUtils'
import type { RpcUsdtTransaction } from '@fedi/common/utils/fedimint'
import { makeLog } from '@fedi/common/utils/log'

import { HistoryIcon } from '../components/feature/transaction-history/HistoryIcon'
import UsdtHistoryDetailOverlay, {
    getUsdtTxnKindText,
} from '../components/feature/transaction-history/UsdtHistoryDetailOverlay'
import { Column, Row } from '../components/ui/Flex'
import { SafeAreaContainer } from '../components/ui/SafeArea'
import SvgImage from '../components/ui/SvgImage'
import type { RootStackParamList } from '../types/navigation'

const log = makeLog('UsdtHistory')

export type Props = NativeStackScreenProps<RootStackParamList, 'UsdtHistory'>

const TRANSACTIONS_LIMIT = 100

const getKindAddress = (txn: RpcUsdtTransaction): string | null => {
    switch (txn.kind.type) {
        case 'deposit':
            return txn.kind.address
        case 'withdrawal':
            return txn.kind.recipient
        default:
            return null
    }
}

const getKindTxid = (txn: RpcUsdtTransaction): string | null =>
    txn.kind.type === 'withdrawal' ? (txn.kind.txid ?? null) : null

const getStatusBadge = (
    txn: RpcUsdtTransaction,
    status: RpcUsdtWithdrawalStatus | undefined,
): TransactionStatusBadge => {
    if (status) {
        if (status.type === 'failed') return 'failed'
        if (
            status.type === 'queued' ||
            status.type === 'signing' ||
            status.type === 'submitted'
        )
            return 'pending'
    }
    return txn.incoming ? 'incoming' : 'outgoing'
}

/**
 * Transaction history for the USDT wallet, modeled visually on the
 * stability pool history (StabilityHistory / HistoryRow). Tapping a row
 * opens a detail overlay; withdrawal statuses are fetched once per txid
 * for the row badge and polled live while the detail overlay is open.
 */
const UsdtHistory: React.FC<Props> = ({ route }: Props) => {
    const { federationId } = route.params
    const { t } = useTranslation()
    const { theme } = useTheme()
    const toast = useToast()
    const fedimint = useFedimint()
    const formatUsdt = useFormatUsdtMicros()

    const [transactions, setTransactions] = useState<RpcUsdtTransaction[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [selectedTxn, setSelectedTxn] = useState<RpcUsdtTransaction | null>(
        null,
    )
    // Withdrawal statuses, cached per txid
    const [statusByTxid, setStatusByTxid] = useState<
        Record<string, RpcUsdtWithdrawalStatus>
    >({})
    const fetchedTxidsRef = useRef(new Set<string>())

    const fetchTransactions = useCallback(async () => {
        const txns = await fedimint.usdtListTransactions(
            federationId,
            TRANSACTIONS_LIMIT,
        )
        setTransactions(txns)
    }, [federationId, fedimint])

    useEffect(() => {
        fetchTransactions()
            .catch(e => toast.error(t, e))
            .finally(() => setIsLoading(false))
    }, [fetchTransactions, t, toast])

    const handleRefresh = useCallback(async () => {
        setIsRefreshing(true)
        try {
            await fetchTransactions()
        } catch (e) {
            toast.error(t, e)
        } finally {
            setIsRefreshing(false)
        }
    }, [fetchTransactions, t, toast])

    const checkWithdrawalStatus = useCallback(
        async (txid: string) => {
            try {
                const status = await fedimint.usdtWithdrawalStatus(
                    federationId,
                    txid,
                )
                setStatusByTxid(prev => ({ ...prev, [txid]: status }))
            } catch (e) {
                log.warn('Failed to check USDT withdrawal status', e)
            }
        },
        [federationId, fedimint],
    )

    // Fetch each withdrawal's status once for the inline row badge
    useEffect(() => {
        for (const txn of transactions) {
            const txid = getKindTxid(txn)
            if (!txid || fetchedTxidsRef.current.has(txid)) continue
            fetchedTxidsRef.current.add(txid)
            checkWithdrawalStatus(txid)
        }
    }, [transactions, checkWithdrawalStatus])

    // Poll the selected withdrawal's status while the detail overlay is open
    const selectedTxid = selectedTxn ? getKindTxid(selectedTxn) : null
    const selectedStatus = selectedTxid
        ? (statusByTxid[selectedTxid] ?? null)
        : null
    const isSelectedFinal =
        selectedStatus?.type === 'confirmed' ||
        selectedStatus?.type === 'failed'

    useEffect(() => {
        if (!selectedTxid || isSelectedFinal) return

        checkWithdrawalStatus(selectedTxid)
        const statusMonitor = setInterval(
            () => checkWithdrawalStatus(selectedTxid),
            5000,
        )

        return () => clearInterval(statusMonitor)
    }, [selectedTxid, isSelectedFinal, checkWithdrawalStatus])

    const style = styles(theme)

    const renderTransaction: ListRenderItem<RpcUsdtTransaction> = useCallback(
        ({ item: txn }) => {
            const address = getKindAddress(txn)
            const txid = getKindTxid(txn)
            const status = txid ? statusByTxid[txid] : undefined
            const signedAmount = `${txn.incoming ? '+' : '-'}${formatUsdt(
                txn.amount,
            )}`
            return (
                <Pressable onPress={() => setSelectedTxn(txn)}>
                    <Row align="center" gap="md" style={style.row}>
                        <HistoryIcon badge={getStatusBadge(txn, status)}>
                            {/* Official Tether mark carries its own colors, no tint */}
                            <SvgImage
                                name="UsdtCircle"
                                size={theme.sizes.historyIcon}
                            />
                        </HistoryIcon>
                        <Column grow gap="xs" fullWidth basis={false}>
                            <Text caption medium>
                                {getUsdtTxnKindText(t, txn)}
                            </Text>
                            {address && (
                                <Text
                                    small
                                    numberOfLines={1}
                                    style={style.subText}>
                                    {stringUtils.truncateMiddleOfString(
                                        address,
                                        6,
                                    )}
                                </Text>
                            )}
                        </Column>
                        <Column shrink={false} justify="end" gap="xs">
                            <Text
                                medium
                                caption
                                style={style.rightAlignedText}
                                color={
                                    txn.incoming
                                        ? theme.colors.green
                                        : theme.colors.night
                                }>
                                {signedAmount}
                            </Text>
                            <Text
                                small
                                style={[style.rightAlignedText, style.subText]}
                                maxFontSizeMultiplier={1.4}>
                                {dateUtils.formatTxnTileTimestamp(
                                    txn.createdAt,
                                )}
                            </Text>
                        </Column>
                    </Row>
                </Pressable>
            )
        },
        [statusByTxid, style, t, theme, formatUsdt],
    )

    return (
        <SafeAreaContainer edges="notop">
            {isLoading ? (
                <Column center grow>
                    <ActivityIndicator />
                </Column>
            ) : (
                <FlatList
                    style={style.list}
                    contentContainerStyle={style.listContent}
                    data={transactions}
                    renderItem={renderTransaction}
                    keyExtractor={(txn, index) =>
                        `${txn.createdAt}-${txn.kind.type}-${index}`
                    }
                    refreshControl={
                        <RefreshControl
                            refreshing={isRefreshing}
                            onRefresh={handleRefresh}
                        />
                    }
                    ListEmptyComponent={
                        <Column center grow style={style.empty}>
                            <Text color={theme.colors.darkGrey}>
                                {t('phrases.no-transactions')}
                            </Text>
                        </Column>
                    }
                />
            )}
            <UsdtHistoryDetailOverlay
                show={selectedTxn !== null}
                txn={selectedTxn}
                status={selectedStatus}
                onClose={() => setSelectedTxn(null)}
            />
        </SafeAreaContainer>
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        list: {
            flex: 1,
        },
        listContent: {
            flexGrow: 1,
            paddingTop: theme.spacing.lg,
        },
        row: {
            width: '100%',
            paddingHorizontal: theme.spacing.sm,
            marginBottom: theme.spacing.xl,
        },
        rightAlignedText: {
            textAlign: 'right',
        },
        subText: {
            color: theme.colors.primaryLight,
        },
        empty: {
            paddingVertical: theme.spacing.xl,
        },
    })

export default UsdtHistory
