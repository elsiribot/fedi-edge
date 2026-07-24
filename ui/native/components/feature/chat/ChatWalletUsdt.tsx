import { Button, Input, Text, Theme, useTheme } from '@rneui/themed'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Keyboard, StyleSheet } from 'react-native'

import { useChatUsdtPayment } from '@fedi/common/hooks/chat'
import { formatUsdtMicros, parseUsdtInput } from '@fedi/common/utils/usdt'

import { Column, Row } from '../../ui/Flex'
import { SafeAreaContainer } from '../../ui/SafeArea'
import SvgImage from '../../ui/SvgImage'
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

    const { balanceMicros, isProcessing, handleRequestUsdtPayment } =
        useChatUsdtPayment(t, roomId, recipientId)

    const amountMicros = parseUsdtInput(amountInput)
    const hasInsufficientBalance =
        amountMicros !== null && amountMicros > balanceMicros
    const isAmountValid = amountMicros !== null && amountMicros > 0

    const handleSend = () => {
        setSubmitAttempts(attempts => attempts + 1)
        if (!isAmountValid || hasInsufficientBalance) return
        Keyboard.dismiss()
        onSendConfirm(amountMicros)
    }

    const handleRequest = () => {
        setSubmitAttempts(attempts => attempts + 1)
        if (!isAmountValid) return
        Keyboard.dismiss()
        handleRequestUsdtPayment(amountMicros, onRequestSuccess)
    }

    const style = styles(theme)

    return (
        <SafeAreaContainer edges="notop">
            <Column grow gap="lg" style={style.container}>
                <FederationWalletSelector fullWidth />
                <Row gap="xs" center>
                    {/* Official Tether mark carries its own colors, no tint */}
                    <SvgImage name="UsdtCircle" size={16} />
                    <Text bold caption>
                        {t('words.ecash')}
                    </Text>
                </Row>
                <Column grow gap="sm">
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
                        rightIcon={
                            <Text medium style={style.usdtSuffix}>
                                USDT
                            </Text>
                        }
                        errorMessage={
                            hasInsufficientBalance
                                ? t('feature.usdt.insufficient-balance')
                                : amountInput.length > 0 &&
                                    amountMicros === null
                                  ? t('feature.usdt.invalid-amount')
                                  : submitAttempts > 0 && !isAmountValid
                                    ? t('feature.usdt.invalid-amount')
                                    : undefined
                        }
                    />
                    <Text caption color={theme.colors.darkGrey}>
                        {t('feature.wallet.available-balance-amount', {
                            amount: formatUsdtMicros(balanceMicros),
                        })}
                    </Text>
                </Column>
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
        button: {
            flex: 1,
        },
        usdtSuffix: {
            color: theme.colors.moneyGreen,
        },
    })

export default ChatWalletUsdt
