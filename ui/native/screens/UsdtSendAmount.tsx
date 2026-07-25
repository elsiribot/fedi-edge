import Clipboard from '@react-native-clipboard/clipboard'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Input, Text, Theme, useTheme } from '@rneui/themed'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StyleSheet } from 'react-native'

import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import {
    useFormatUsdtMicros,
    useUsdtAmountInput,
} from '@fedi/common/hooks/usdt'
import {
    selectPaymentFederation,
    selectUsdtBalanceMicros,
} from '@fedi/common/redux'
import { hexToRgba } from '@fedi/common/utils/color'
import { makeLog } from '@fedi/common/utils/log'
import { isValidEvmAddress } from '@fedi/common/utils/usdt'

import { Column, Row } from '../components/ui/Flex'
import { PressableIcon } from '../components/ui/PressableIcon'
import { SafeAreaContainer } from '../components/ui/SafeArea'
import UsdtAmountInput from '../components/ui/UsdtAmountInput'
import { useAppSelector } from '../state/hooks'
import type { RootStackParamList } from '../types/navigation'

const log = makeLog('UsdtSendAmount')

export type Props = NativeStackScreenProps<RootStackParamList, 'UsdtSendAmount'>

/**
 * Amount entry + network fee quote step of the USDT send flow. The
 * recipient address arrives from the UsdtSend scanner, but stays editable.
 * A scanned `?amount=` param prefills the amount, also still editable.
 */
const UsdtSendAmount: React.FC<Props> = ({ navigation, route }) => {
    const { t } = useTranslation()
    const { theme } = useTheme()
    const toast = useToast()
    const fedimint = useFedimint()
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
    } = useUsdtAmountInput({
        balanceMicros,
        initialMicros: route.params.amountMicros,
    })

    const [recipient, setRecipient] = useState(route.params.recipient)
    const [feeMicros, setFeeMicros] = useState<number | null>(null)
    const [isSubmitting, setIsSubmitting] = useState(false)

    const trimmedRecipient = recipient.trim()
    const isRecipientValid = isValidEvmAddress(trimmedRecipient)

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
        try {
            const txid = await fedimint.usdtWithdraw(
                federationId,
                trimmedRecipient,
                amountMicros,
                feeMicros,
            )
            navigation.replace('SendSuccessShield', {
                title: t('feature.send.you-sent'),
                formattedAmount: formatUsdt(amountMicros),
                description: '',
                nextScreenParams: [
                    'UsdtWithdrawInitiated',
                    {
                        txid,
                        amountMicros,
                        recipient: trimmedRecipient,
                    },
                ],
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
            <Column grow style={style.container}>
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
                <UsdtAmountInput
                    amountInput={amountInput}
                    onChangeAmountInput={setAmountInput}
                    isSubmitting={isSubmitting}
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
                    content={
                        feeMicros !== null && receivedMicros !== null ? (
                            <Column gap="xs" style={style.feeContainer}>
                                <Row justify="between">
                                    <Text caption color={theme.colors.darkGrey}>
                                        {t('feature.usdt.network-fee')}
                                    </Text>
                                    <Text caption medium>
                                        {formatUsdt(feeMicros)}
                                    </Text>
                                </Row>
                                <Row justify="between">
                                    <Text caption color={theme.colors.darkGrey}>
                                        {t('feature.usdt.recipient-receives')}
                                    </Text>
                                    <Text caption medium>
                                        {formatUsdt(
                                            Math.max(receivedMicros, 0),
                                        )}
                                    </Text>
                                </Row>
                            </Column>
                        ) : null
                    }
                />
                <Button
                    title={t('words.send')}
                    onPress={handleSend}
                    loading={isSubmitting}
                    disabled={!canSend || isSubmitting}
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
        feeContainer: {
            padding: theme.spacing.md,
            marginHorizontal: theme.spacing.lg,
            backgroundColor: theme.colors.offWhite100,
            borderRadius: theme.borders.tileRadius,
        },
        button: {
            marginTop: theme.spacing.md,
        },
    })

export default UsdtSendAmount
