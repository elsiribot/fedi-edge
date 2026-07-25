import { Button, Text, Theme, useTheme } from '@rneui/themed'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StyleSheet } from 'react-native'

import { useChatUsdtPayment } from '@fedi/common/hooks/chat'
import {
    useFormatUsdtMicros,
    useUsdtDecimalSeparator,
    useUsdtGroupingSeparator,
} from '@fedi/common/hooks/usdt'
import { hexToRgba } from '@fedi/common/utils/color'
import { parseUsdtInput } from '@fedi/common/utils/usdt'

import { Column, Row } from '../../ui/Flex'
import { SafeAreaContainer } from '../../ui/SafeArea'
import SvgImage from '../../ui/SvgImage'
import UsdtAmountInput from '../../ui/UsdtAmountInput'
import FederationWalletSelector from '../send/FederationWalletSelector'

/**
 * Amount entry for in-chat payments when the selected payment federation
 * is USDT-only. Amounts are entered in USD (USDT) and carried as USDT
 * micros (10^-6 USDT). USDT ecash payments have no Fedi fees.
 */
const ChatWalletUsdt: React.FC<{
    roomId: string
    recipientId: string
    onSendConfirm: (amountMicros: number, notes?: string) => void
    onRequestSuccess: () => void
}> = ({ roomId, recipientId, onSendConfirm, onRequestSuccess }) => {
    const { t } = useTranslation()
    const { theme } = useTheme()

    const [amountInput, setAmountInput] = useState('')
    const [submitAttempts, setSubmitAttempts] = useState(0)
    const decimalSeparator = useUsdtDecimalSeparator()
    const groupingSeparator = useUsdtGroupingSeparator()
    const formatUsdt = useFormatUsdtMicros()

    const { balanceMicros, isProcessing, handleRequestUsdtPayment } =
        useChatUsdtPayment(t, roomId, recipientId)

    // `parseUsdtInput` tolerates a transient trailing decimal separator
    // mid-entry, e.g. "5."
    const amountMicros = parseUsdtInput(amountInput, {
        decimalSeparator,
        groupingSeparator,
    })
    const hasInsufficientBalance =
        amountMicros !== null && amountMicros > balanceMicros
    const isAmountValid = amountMicros !== null && amountMicros > 0

    const handleSend = () => {
        setSubmitAttempts(attempts => attempts + 1)
        if (!isAmountValid || hasInsufficientBalance) return
        onSendConfirm(amountMicros)
    }

    const handleRequest = () => {
        setSubmitAttempts(attempts => attempts + 1)
        if (!isAmountValid) return
        handleRequestUsdtPayment(amountMicros, onRequestSuccess)
    }

    const style = styles(theme)

    return (
        <SafeAreaContainer edges="notop">
            <Column grow gap="lg" style={style.container}>
                <FederationWalletSelector fullWidth />
                <UsdtAmountInput
                    amountInput={amountInput}
                    onChangeAmountInput={setAmountInput}
                    isSubmitting={isProcessing}
                    error={
                        hasInsufficientBalance
                            ? t('feature.usdt.insufficient-balance')
                            : submitAttempts > 0 && !isAmountValid
                              ? t('feature.usdt.invalid-amount')
                              : null
                    }
                    preHeader={
                        <Column gap="sm">
                            <Row gap="xs" center>
                                {/* Official Tether mark carries its own colors, no tint */}
                                <SvgImage name="UsdtCircle" size={16} />
                                <Text bold caption>
                                    {t('words.ecash')}
                                </Text>
                            </Row>
                            <Text
                                caption
                                style={style.balance}
                                numberOfLines={1}
                                adjustsFontSizeToFit>
                                {t('feature.wallet.available-balance-amount', {
                                    amount: formatUsdt(balanceMicros),
                                })}
                            </Text>
                        </Column>
                    }
                />
                <Row gap="md" fullWidth>
                    <Button
                        containerStyle={style.button}
                        title={t('words.request')}
                        titleProps={{ numberOfLines: 1 }}
                        onPress={handleRequest}
                        loading={isProcessing}
                        disabled={isProcessing}
                    />
                    <Button
                        containerStyle={style.button}
                        title={t('words.send')}
                        titleProps={{ numberOfLines: 1 }}
                        onPress={handleSend}
                        disabled={isProcessing}
                    />
                </Row>
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
            flex: 1,
        },
    })

export default ChatWalletUsdt
