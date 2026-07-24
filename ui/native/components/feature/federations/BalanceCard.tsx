import { useNavigation } from '@react-navigation/native'
import { Text, Theme, useTheme } from '@rneui/themed'
import { useTranslation } from 'react-i18next'
import { Pressable, StyleSheet } from 'react-native'

import { HIDDEN_AMOUNT_MASK } from '@fedi/common/constants/currency'
import { useBalance } from '@fedi/common/hooks/amount'
import { useRecoveryProgress } from '@fedi/common/hooks/recovery'
import {
    selectBalanceDisplay,
    selectCurrency,
    selectPaymentType,
    selectStableBalancePending,
    selectUsdtBalanceMicros,
} from '@fedi/common/redux'
import { getCurrencyCode } from '@fedi/common/utils/currency'
import { formatUsdtMicros } from '@fedi/common/utils/usdt'

import { useAppSelector, useStabilityPool } from '../../../state/hooks'
import { Column, Row } from '../../ui/Flex'
import GradientView from '../../ui/GradientView'
import SvgImage, { SvgImageName } from '../../ui/SvgImage'
import RecoveryInProgress from '../recovery/RecoveryInProgress'

export default function WalletBalanceCard({
    federationId,
}: {
    federationId: string
}) {
    const { t } = useTranslation()
    const { theme } = useTheme()
    const { formattedBalanceSats, formattedBalanceFiat } = useBalance(
        t,
        federationId,
    )
    const { formattedStableBalance, formattedStableBalancePending } =
        useStabilityPool(federationId)
    const { recoveryInProgress } = useRecoveryProgress(federationId)

    const navigation = useNavigation()
    const paymentType = useAppSelector(selectPaymentType)
    const selectedCurrency = useAppSelector(s =>
        selectCurrency(s, federationId),
    )
    const stableBalancePending = useAppSelector(s =>
        selectStableBalancePending(s, federationId),
    )
    const usdtBalanceMicros = useAppSelector(s =>
        selectUsdtBalanceMicros(s, federationId),
    )
    const balanceDisplay = useAppSelector(selectBalanceDisplay)

    const onPressTransactions = () => {
        if (recoveryInProgress) return
        if (paymentType === 'usdt') {
            navigation.navigate('UsdtHistory', { federationId })
            return
        }
        navigation.navigate(
            paymentType === 'bitcoin' ? 'Transactions' : 'StabilityHistory',
            { federationId },
        )
    }

    let iconName: SvgImageName = 'BitcoinCircle'
    // The Tether logo carries its own colors, so leave it untinted
    let iconColor: string | undefined = theme.colors.orange
    let headerTitle = t('words.bitcoin')
    let primaryAmount = formattedBalanceFiat
    let secondaryAmount: string | null = formattedBalanceSats

    if (paymentType === 'stable-balance') {
        iconName = 'UsdCircleFilled'
        iconColor = theme.colors.moneyGreen
        headerTitle = getCurrencyCode(selectedCurrency)
        primaryAmount = formattedStableBalance
        secondaryAmount =
            stableBalancePending !== 0
                ? `${formattedStableBalancePending} ${t('words.pending')}`
                : null
    } else if (paymentType === 'usdt') {
        iconName = 'UsdtCircle'
        iconColor = undefined
        headerTitle = t('feature.usdt.usdt-balance')
        primaryAmount = formatUsdtMicros(usdtBalanceMicros)
        secondaryAmount = null
    }

    const style = styles(theme)

    return (
        <GradientView style={style.card} variant="white">
            <Pressable
                onPress={onPressTransactions}
                style={style.header}
                hitSlop={12}
                testID="BalanceCard__TransactionHistory">
                <Row gap="sm" align="center">
                    <SvgImage name={iconName} color={iconColor} />
                    <Text bold>{headerTitle}</Text>
                </Row>

                <SvgImage
                    name="TxnHistory"
                    color={
                        recoveryInProgress
                            ? theme.colors.lightGrey
                            : theme.colors.primary
                    }
                />
            </Pressable>
            <Column center gap="xs" grow>
                {recoveryInProgress ? (
                    <RecoveryInProgress federationId={federationId} size={40} />
                ) : (
                    <>
                        <Text bold h1>
                            {balanceDisplay === 'hidden'
                                ? HIDDEN_AMOUNT_MASK
                                : primaryAmount}
                        </Text>
                        {secondaryAmount && (
                            <Text
                                testID="WalletBalanceSats"
                                color={theme.colors.grey}>
                                {balanceDisplay === 'hidden'
                                    ? HIDDEN_AMOUNT_MASK
                                    : secondaryAmount}
                            </Text>
                        )}
                    </>
                )}
            </Column>
        </GradientView>
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
        },
        card: {
            backgroundColor: theme.colors.white,
            flexDirection: 'column',
            flexGrow: 1,
            padding: theme.spacing.md,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: theme.colors.extraLightGrey,
        },
    })
