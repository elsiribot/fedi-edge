import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Text, Theme, useTheme } from '@rneui/themed'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, StyleSheet } from 'react-native'

import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import {
    useFormatUsdtMicros,
    useUsdtAmountInput,
} from '@fedi/common/hooks/usdt'
import {
    refreshUsdtBalance,
    selectPaymentFederation,
    selectUsdtBalanceMicros,
} from '@fedi/common/redux'
import { shouldShowInviteCode } from '@fedi/common/utils/FederationUtils'
import { hexToRgba } from '@fedi/common/utils/color'

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
    const formatUsdt = useFormatUsdtMicros()

    const federation = useAppSelector(selectPaymentFederation)
    const federationId = federation?.id ?? ''
    const balanceMicros = useAppSelector(s =>
        selectUsdtBalanceMicros(s, federationId),
    )

    const {
        amountInput,
        setAmountInput,
        amountMicros,
        isAmountValid,
        getErrorText,
    } = useUsdtAmountInput({ balanceMicros })
    const [isGenerating, setIsGenerating] = useState(false)

    const handleGenerate = async () => {
        if (
            !federationId ||
            !isAmountValid ||
            amountMicros === null ||
            isGenerating
        )
            return

        setIsGenerating(true)
        try {
            const { ecash } = await fedimint.usdtGenerateEcash(
                amountMicros,
                federationId,
                // embed an invite so non-members can join-then-claim,
                // unless the federation opted out
                federation?.meta
                    ? shouldShowInviteCode(federation.meta)
                    : false,
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

    // Same warning the BTC offline send shows (ConfirmSendEcash): once the
    // notes are generated they leave the balance until claimed or cancelled
    const handleNext = () => {
        if (!isAmountValid || amountMicros === null || isGenerating) return
        Alert.alert(
            t('phrases.please-confirm'),
            t('feature.send.offline-send-warning'),
            [
                {
                    text: t('phrases.go-back'),
                },
                {
                    text: t('words.continue'),
                    onPress: handleGenerate,
                },
            ],
        )
    }

    const style = styles(theme)

    return (
        <SafeAreaContainer edges="notop">
            <Column grow style={style.container}>
                <UsdtAmountInput
                    amountInput={amountInput}
                    onChangeAmountInput={setAmountInput}
                    isSubmitting={isGenerating}
                    error={getErrorText(
                        t,
                        amountInput.length > 0 && amountMicros === null,
                    )}
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
