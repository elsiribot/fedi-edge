import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Text, Theme, useTheme } from '@rneui/themed'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StyleSheet } from 'react-native'

import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import {
    useFormatUsdtMicros,
    useUsdtDecimalSeparator,
    useUsdtGroupingSeparator,
} from '@fedi/common/hooks/usdt'
import {
    refreshUsdtBalance,
    selectPaymentFederation,
    selectUsdtBalanceMicros,
} from '@fedi/common/redux'
import { shouldShowInviteCode } from '@fedi/common/utils/FederationUtils'
import { hexToRgba } from '@fedi/common/utils/color'
import { parseUsdtInput } from '@fedi/common/utils/usdt'

import { Column } from '../components/ui/Flex'
import { SafeAreaContainer } from '../components/ui/SafeArea'
import UsdtAmountInput from '../components/ui/UsdtAmountInput'
import { useAppDispatch, useAppSelector } from '../state/hooks'
import type { RootStackParamList } from '../types/navigation'

export type Props = NativeStackScreenProps<
    RootStackParamList,
    'UsdtSendOfflineAmount'
>

/**
 * Amount entry for an offline USDT ecash send. Generates the ecash notes
 * and hands them to UsdtSendOfflineQr for display.
 */
const UsdtSendOfflineAmount: React.FC<Props> = ({ navigation }) => {
    const { t } = useTranslation()
    const { theme } = useTheme()
    const toast = useToast()
    const fedimint = useFedimint()
    const dispatch = useAppDispatch()
    const decimalSeparator = useUsdtDecimalSeparator()
    const groupingSeparator = useUsdtGroupingSeparator()
    const formatUsdt = useFormatUsdtMicros()

    const federation = useAppSelector(selectPaymentFederation)
    const federationId = federation?.id ?? ''
    const balanceMicros = useAppSelector(s =>
        selectUsdtBalanceMicros(s, federationId),
    )

    const [amountInput, setAmountInput] = useState('')
    const [isGenerating, setIsGenerating] = useState(false)

    // `parseUsdtInput` tolerates a transient trailing decimal separator
    // mid-entry, e.g. "5."
    const amountMicros = parseUsdtInput(amountInput, {
        decimalSeparator,
        groupingSeparator,
    })
    const hasInsufficientBalance =
        amountMicros !== null && amountMicros > balanceMicros
    const isAmountValid =
        amountMicros !== null && amountMicros > 0 && !hasInsufficientBalance

    const handleNext = async () => {
        if (!federationId || !isAmountValid || isGenerating) return

        setIsGenerating(true)
        try {
            const { ecash } = await fedimint.usdtGenerateEcash(
                amountMicros,
                federationId,
                // embed an invite so non-members can join-then-claim,
                // unless the federation opted out
                federation?.meta ? shouldShowInviteCode(federation.meta) : false,
            )
            dispatch(refreshUsdtBalance({ fedimint, federationId }))
            navigation.replace('UsdtSendOfflineQr', {
                ecash,
                amountMicros,
            })
        } catch (e) {
            toast.error(t, e)
        } finally {
            setIsGenerating(false)
        }
    }

    const style = styles(theme)

    return (
        <SafeAreaContainer edges="notop">
            <Column grow style={style.container}>
                <UsdtAmountInput
                    amountInput={amountInput}
                    onChangeAmountInput={setAmountInput}
                    isSubmitting={isGenerating}
                    error={
                        hasInsufficientBalance
                            ? t('feature.usdt.insufficient-balance')
                            : amountInput.length > 0 && amountMicros === null
                              ? t('feature.usdt.invalid-amount')
                              : null
                    }
                    preHeader={
                        <Text
                            caption
                            style={style.balance}
                            numberOfLines={1}
                            adjustsFontSizeToFit>
                            {t('feature.wallet.available-balance-amount', {
                                amount: formatUsdt(balanceMicros),
                            })}
                        </Text>
                    }
                />
                <Button
                    title={t('words.next')}
                    onPress={handleNext}
                    loading={isGenerating}
                    disabled={!isAmountValid || isGenerating}
                    containerStyle={style.button}
                />
            </Column>
        </SafeAreaContainer>
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        container: {
            paddingTop: theme.spacing.lg,
        },
        balance: {
            color: hexToRgba(theme.colors.primary, 0.6),
            textAlign: 'center',
        },
        button: {
            marginTop: theme.spacing.md,
        },
    })

export default UsdtSendOfflineAmount
