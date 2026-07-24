import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Text, Theme, useTheme } from '@rneui/themed'
import { TFunction } from 'i18next'
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    ActivityIndicator,
    FlatList,
    ListRenderItem,
    RefreshControl,
    StyleSheet,
} from 'react-native'

import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import dateUtils from '@fedi/common/utils/DateUtils'
import stringUtils from '@fedi/common/utils/StringUtils'
import type { RpcUsdtTransaction } from '@fedi/common/utils/fedimint'
import { formatUsdtMicros } from '@fedi/common/utils/usdt'

import { HistoryIcon } from '../components/feature/transaction-history/HistoryIcon'
import { Column, Row } from '../components/ui/Flex'
import { SafeAreaContainer } from '../components/ui/SafeArea'
import SvgImage from '../components/ui/SvgImage'
import type { RootStackParamList } from '../types/navigation'

export type Props = NativeStackScreenProps<RootStackParamList, 'UsdtHistory'>

const TRANSACTIONS_LIMIT = 100

const getKindText = (t: TFunction, txn: RpcUsdtTransaction): string => {
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

/**
 * Transaction history for the USDT wallet, modeled visually on the
 * stability pool history (StabilityHistory / HistoryRow).
 */
const UsdtHistory: React.FC<Props> = ({ route }: Props) => {
    const { federationId } = route.params
    const { t } = useTranslation()
    const { theme } = useTheme()
    const toast = useToast()
    const fedimint = useFedimint()

    const [transactions, setTransactions] = useState<RpcUsdtTransaction[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isRefreshing, setIsRefreshing] = useState(false)

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

    const style = styles(theme)

    const renderTransaction: ListRenderItem<RpcUsdtTransaction> = useCallback(
        ({ item: txn }) => {
            const address = getKindAddress(txn)
            const signedAmount = `${txn.incoming ? '+' : '-'}${formatUsdtMicros(
                txn.amount,
            )}`
            return (
                <Row align="center" gap="md" style={style.row}>
                    <HistoryIcon badge={txn.incoming ? 'incoming' : 'outgoing'}>
                        {/* Official Tether mark carries its own colors, no tint */}
                        <SvgImage
                            name="UsdtCircle"
                            size={theme.sizes.historyIcon}
                        />
                    </HistoryIcon>
                    <Column grow gap="xs" fullWidth basis={false}>
                        <Text caption medium>
                            {getKindText(t, txn)}
                        </Text>
                        {address && (
                            <Text small numberOfLines={1} style={style.subText}>
                                {stringUtils.truncateMiddleOfString(address, 6)}
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
                            {dateUtils.formatTxnTileTimestamp(txn.createdAt)}
                        </Text>
                    </Column>
                </Row>
            )
        },
        [style, t, theme],
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
