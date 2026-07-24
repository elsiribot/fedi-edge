import Clipboard from '@react-native-clipboard/clipboard'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Input, Text, Theme, useTheme } from '@rneui/themed'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Keyboard, ScrollView, StyleSheet } from 'react-native'

import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import {
    selectPaymentFederation,
    selectUsdtBalanceMicros,
} from '@fedi/common/redux'
import { makeLog } from '@fedi/common/utils/log'
import {
    formatUsdtMicros,
    isValidEvmAddress,
    parseUsdtInput,
} from '@fedi/common/utils/usdt'

import { Column, Row } from '../components/ui/Flex'
import { PressableIcon } from '../components/ui/PressableIcon'
import { SafeAreaContainer } from '../components/ui/SafeArea'
import { useAppSelector } from '../state/hooks'
import type { RootStackParamList } from '../types/navigation'

const log = makeLog('UsdtSend')

export type Props = NativeStackScreenProps<RootStackParamList, 'UsdtSend'>

const UsdtSend: React.FC<Props> = ({ navigation }) => {
    const { t } = useTranslation()
    const { theme } = useTheme()
    const toast = useToast()
    const fedimint = useFedimint()

    const federation = useAppSelector(selectPaymentFederation)
    const federationId = federation?.id ?? ''
    const balanceMicros = useAppSelector(s =>
        selectUsdtBalanceMicros(s, federationId),
    )

    const [recipient, setRecipient] = useState('')
    const [amountInput, setAmountInput] = useState('')
    const [feeMicros, setFeeMicros] = useState<number | null>(null)
    const [isSubmitting, setIsSubmitting] = useState(false)

    const trimmedRecipient = recipient.trim()
    const isRecipientValid = isValidEvmAddress(trimmedRecipient)
    const amountMicros = parseUsdtInput(amountInput)
    const hasInsufficientBalance =
        amountMicros !== null && amountMicros > balanceMicros
    const isAmountValid =
        amountMicros !== null && amountMicros > 0 && !hasInsufficientBalance

    // Quote the network fee whenever a valid amount is entered
    useEffect(() => {
        setFeeMicros(null)
        if (!federationId || amountMicros === null || amountMicros <= 0) return
        let cancelled = false

        const timeout = setTimeout(() => {
            fedimint
                .usdtWithdrawFeeQuote(federationId, amountMicros)
                .then(fee => {
                    if (!cancelled) setFeeMicros(fee)
                })
                .catch(e => log.warn('Failed to quote USDT withdrawal fee', e))
        }, 300)

        return () => {
            cancelled = true
            clearTimeout(timeout)
        }
    }, [amountMicros, federationId, fedimint])

    const handlePasteRecipient = async () => {
        const pasted = await Clipboard.getString()
        if (pasted) setRecipient(pasted.trim())
    }

    // The network fee is deducted from the amount by the federation
    const receivedMicros =
        feeMicros !== null && amountMicros !== null
            ? amountMicros - feeMicros
            : null

    const canSend =
        isRecipientValid &&
        isAmountValid &&
        feeMicros !== null &&
        receivedMicros !== null &&
        receivedMicros > 0

    const handleSend = async () => {
        if (
            !federationId ||
            !canSend ||
            amountMicros === null ||
            feeMicros === null ||
            isSubmitting
        )
            return

        setIsSubmitting(true)
        Keyboard.dismiss()
        try {
            const txid = await fedimint.usdtWithdraw(
                federationId,
                trimmedRecipient,
                amountMicros,
                feeMicros,
            )
            navigation.replace('UsdtWithdrawInitiated', {
                txid,
                amountMicros,
                recipient: trimmedRecipient,
            })
        } catch (e) {
            toast.error(t, e)
        } finally {
            setIsSubmitting(false)
        }
    }

    const style = styles(theme)

    return (
        <SafeAreaContainer edges="notop">
            <Column grow gap="lg" style={style.container}>
                <ScrollView
                    style={style.scroll}
                    contentContainerStyle={style.scrollContent}
                    keyboardShouldPersistTaps="handled"
                    alwaysBounceVertical={false}>
                    <Input
                        label={
                            <Text caption medium>
                                {t('feature.usdt.recipient-address')}
                            </Text>
                        }
                        value={recipient}
                        onChangeText={setRecipient}
                        placeholder="0x…"
                        autoCapitalize="none"
                        autoCorrect={false}
                        rightIcon={
                            <PressableIcon
                                svgName="Clipboard"
                                onPress={handlePasteRecipient}
                            />
                        }
                        errorMessage={
                            trimmedRecipient.length > 0 && !isRecipientValid
                                ? t('feature.usdt.invalid-address')
                                : undefined
                        }
                    />
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
                                : amountInput.length > 0 &&
                                    amountMicros === null
                                  ? t('feature.usdt.invalid-amount')
                                  : undefined
                        }
                    />
                    <Text caption color={theme.colors.darkGrey}>
                        {t('feature.wallet.available-balance-amount', {
                            amount: formatUsdtMicros(balanceMicros),
                        })}
                    </Text>
                    {feeMicros !== null && receivedMicros !== null && (
                        <Column gap="xs" style={style.feeContainer}>
                            <Row justify="between">
                                <Text caption color={theme.colors.darkGrey}>
                                    {t('feature.usdt.network-fee')}
                                </Text>
                                <Text caption medium>
                                    {formatUsdtMicros(feeMicros)}
                                </Text>
                            </Row>
                            <Row justify="between">
                                <Text caption color={theme.colors.darkGrey}>
                                    {t('feature.usdt.recipient-receives')}
                                </Text>
                                <Text caption medium>
                                    {formatUsdtMicros(
                                        Math.max(receivedMicros, 0),
                                    )}
                                </Text>
                            </Row>
                        </Column>
                    )}
                </ScrollView>
                <Button
                    title={t('words.send')}
                    onPress={handleSend}
                    loading={isSubmitting}
                    disabled={!canSend || isSubmitting}
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
        scroll: {
            flex: 1,
        },
        scrollContent: {
            gap: theme.spacing.sm,
        },
        feeContainer: {
            padding: theme.spacing.md,
            backgroundColor: theme.colors.offWhite100,
            borderRadius: theme.borders.tileRadius,
        },
    })

export default UsdtSend
