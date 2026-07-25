import { Button, Text, Theme, useTheme } from '@rneui/themed'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StyleSheet } from 'react-native'

import { useChatPaymentPush } from '@fedi/common/hooks/chat'
import {
    useFormatUsdtMicros,
    useUsdtAmountInput,
} from '@fedi/common/hooks/usdt'
import { hexToRgba } from '@fedi/common/utils/color'

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

    const [submitAttempts, setSubmitAttempts] = useState(0)
    const formatUsdt = useFormatUsdtMicros()

    const { balanceMicros, isProcessing, handleRequestPayment } =
        useChatPaymentPush(t, roomId, recipientId, 'usdt')

    const {
        amountInput,
        setAmountInput,
        amountMicros,
        isPositiveAmount,
        isAmountValid,
        getErrorText,
    } = useUsdtAmountInput({ balanceMicros })

    const handleSend = () => {
        setSubmitAttempts(attempts => attempts + 1)
        if (!isAmountValid || amountMicros === null) return
        onSendConfirm(amountMicros)
    }

    const handleRequest = () => {
        setSubmitAttempts(attempts => attempts + 1)
        if (!isPositiveAmount || amountMicros === null) return
        handleRequestPayment(amountMicros, onRequestSuccess)
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
                    error={getErrorText(
                        t,
                        submitAttempts > 0 && !isPositiveAmount,
                    )}
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
