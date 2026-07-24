import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Input, Text, Theme, useTheme } from '@rneui/themed'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Keyboard, StyleSheet } from 'react-native'

import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import {
    refreshUsdtBalance,
    selectPaymentFederation,
    selectUsdtBalanceMicros,
} from '@fedi/common/redux'
import { formatUsdtMicros, parseUsdtInput } from '@fedi/common/utils/usdt'

import { Column } from '../components/ui/Flex'
import { SafeAreaContainer } from '../components/ui/SafeArea'
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

    const federation = useAppSelector(selectPaymentFederation)
    const federationId = federation?.id ?? ''
    const balanceMicros = useAppSelector(s =>
        selectUsdtBalanceMicros(s, federationId),
    )

    const [amountInput, setAmountInput] = useState('')
    const [isGenerating, setIsGenerating] = useState(false)

    const amountMicros = parseUsdtInput(amountInput)
    const hasInsufficientBalance =
        amountMicros !== null && amountMicros > balanceMicros
    const isAmountValid =
        amountMicros !== null && amountMicros > 0 && !hasInsufficientBalance

    const handleNext = async () => {
        if (!federationId || !isAmountValid || isGenerating) return

        setIsGenerating(true)
        Keyboard.dismiss()
        try {
            const { ecash } = await fedimint.usdtGenerateEcash(
                federationId,
                amountMicros,
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
            <Column grow gap="sm" style={style.container}>
                <Input
                    label={
                        <Text caption medium>
                            {t('words.amount')}
                        </Text>
                    }
                    value={amountInput}
                    onChangeText={setAmountInput}
                    placeholder="0.00"
                    keyboardType="decimal-pad"
                    autoCapitalize="none"
                    autoCorrect={false}
                    rightIcon={<Text medium>USDT</Text>}
                    errorMessage={
                        hasInsufficientBalance
                            ? t('feature.usdt.insufficient-balance')
                            : amountInput.length > 0 && amountMicros === null
                              ? t('feature.usdt.invalid-amount')
                              : undefined
                    }
                />
                <Text caption color={theme.colors.darkGrey}>
                    {t('feature.wallet.available-balance-amount', {
                        amount: formatUsdtMicros(balanceMicros),
                    })}
                </Text>
                <Column grow justify="end">
                    <Button
                        title={t('words.next')}
                        onPress={handleNext}
                        loading={isGenerating}
                        disabled={!isAmountValid || isGenerating}
                    />
                </Column>
            </Column>
        </SafeAreaContainer>
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        container: {
            paddingTop: theme.spacing.lg,
        },
    })

export default UsdtSendOfflineAmount
