import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Divider, Text, Theme, useTheme } from '@rneui/themed'
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StyleSheet } from 'react-native'

import { useAmountFormatter, useBalance } from '@fedi/common/hooks/amount'
import { useChatPaymentPush, useChatUsdtPayment } from '@fedi/common/hooks/chat'
import { useCommonSelector } from '@fedi/common/hooks/redux'
import {
    useEcashFeeDetails,
    useFeeDisplayUtils,
} from '@fedi/common/hooks/transactions'
import {
    selectCurrency,
    selectMatrixRoom,
    selectPaymentFederation,
} from '@fedi/common/redux'
import { Sats } from '@fedi/common/types'
import amountUtils from '@fedi/common/utils/AmountUtils'
import { formatUsdtMicros } from '@fedi/common/utils/usdt'

import ChatAvatar from '../components/feature/chat/ChatAvatar'
import FederationWalletSelector from '../components/feature/send/FederationWalletSelector'
import FeeOverlay from '../components/feature/send/FeeOverlay'
import PaymentType from '../components/feature/send/PaymentType'
import SendAmounts from '../components/feature/send/SendAmounts'
import { AvatarSize } from '../components/ui/Avatar'
import { Column, Row } from '../components/ui/Flex'
import NotesInput from '../components/ui/NotesInput'
import { PressableIcon } from '../components/ui/PressableIcon'
import { SafeAreaContainer } from '../components/ui/SafeArea'
import SvgImage from '../components/ui/SvgImage'
import { useAppSelector } from '../state/hooks'
import { resetToDirectChat } from '../state/navigation'
import type { RootStackParamList } from '../types/navigation'

export type Props = NativeStackScreenProps<
    RootStackParamList,
    'ConfirmSendChatPayment'
>

const ConfirmSendChatPayment: React.FC<Props> = ({ route, navigation }) => {
    const { params } = route

    if (params.unit === 'usdt') {
        return (
            <ConfirmSendChatPaymentUsdt
                amountMicros={params.amountMicros}
                roomId={params.roomId}
                notes={params.notes}
                navigation={navigation}
            />
        )
    }

    return (
        <ConfirmSendChatPaymentBtc
            amount={params.amount}
            roomId={params.roomId}
            notes={params.notes}
            navigation={navigation}
        />
    )
}

const ConfirmSendChatPaymentBtc: React.FC<{
    amount: Sats
    roomId: string
    notes?: string
    navigation: Props['navigation']
}> = ({ amount, roomId, notes: initialNotes, navigation }) => {
    const { theme } = useTheme()
    const { t } = useTranslation()
    const [showFeeBreakdown, setShowFeeBreakdown] = useState<boolean>(false)
    const [notes, setNotes] = useState(initialNotes ?? '')
    const paymentFederation = useAppSelector(selectPaymentFederation)
    const { feeBreakdownTitle, ecashFeesGuidanceText, makeEcashFeeContent } =
        useFeeDisplayUtils(t, paymentFederation?.id || '')
    const amountMsats = amountUtils.satToMsat(amount)
    const feeDetails = useEcashFeeDetails(amountMsats, paymentFederation?.id)
    const { formattedTotalFee, feeItemsBreakdown, formattedTotalAmount } =
        makeEcashFeeContent(amountMsats, feeDetails)
    const { formattedBalanceText } = useBalance(t, paymentFederation?.id || '')
    const selectedCurrency = useCommonSelector(s =>
        selectCurrency(s, paymentFederation?.id),
    )
    const { makeFormattedAmountsFromSats } = useAmountFormatter({
        currency: selectedCurrency,
        federationId: paymentFederation?.id,
    })
    const { formattedPrimaryAmount, formattedSecondaryAmount } =
        makeFormattedAmountsFromSats(amount)

    const existingRoom = useAppSelector(s => selectMatrixRoom(s, roomId))
    const { isProcessing, handleSendPayment } = useChatPaymentPush(
        t,
        roomId,
        existingRoom?.directUserId || '',
    )

    const onSend = useCallback(async () => {
        handleSendPayment(
            amount,
            () => {
                // go back to DirectChat to show sent payment
                navigation.dispatch(resetToDirectChat(roomId))
            },
            notes,
        )
    }, [amount, handleSendPayment, navigation, notes, roomId])

    const style = styles(theme)

    return (
        <SafeAreaContainer style={style.container} edges="notop">
            <FederationWalletSelector fullWidth />
            <Column style={style.content} fullWidth align="center" grow>
                <Column style={style.amountContainer} align="center" fullWidth>
                    <PaymentType type="ecash" />
                    <SendAmounts
                        balanceDisplay={formattedBalanceText}
                        formattedPrimaryAmount={formattedPrimaryAmount}
                        formattedSecondaryAmount={formattedSecondaryAmount}
                    />
                </Column>
                <Column fullWidth>
                    {existingRoom && (
                        <>
                            <Row
                                align="center"
                                justify="between"
                                style={style.item}>
                                <Text caption bold>
                                    {t('feature.send.send-to')}
                                </Text>
                                <Row align="center" gap="sm">
                                    <ChatAvatar
                                        user={{
                                            ...existingRoom,
                                            displayName:
                                                existingRoom.name ?? '',
                                            avatarUrl:
                                                existingRoom.avatarUrl ??
                                                undefined,
                                        }}
                                        size={AvatarSize.sm}
                                    />
                                    <Text caption medium>
                                        {existingRoom.name}
                                    </Text>
                                </Row>
                            </Row>
                            <Divider />
                        </>
                    )}
                    <Column style={style.itemGroup} gap="md">
                        <Row align="center" justify="between">
                            <Text caption>{t('words.amount')}</Text>
                            <Text caption medium>
                                {formattedPrimaryAmount}
                            </Text>
                        </Row>
                        <Row align="center" justify="between">
                            <Text caption>{t('words.fees')}</Text>
                            <Row align="center" gap="xs">
                                <Text caption medium>
                                    {formattedTotalFee}
                                </Text>
                                <PressableIcon
                                    svgName="Info"
                                    onPress={() => setShowFeeBreakdown(true)}
                                    svgProps={{
                                        size: 16,
                                        color: theme.colors.grey,
                                    }}
                                />
                            </Row>
                        </Row>
                        <Row align="center" justify="between">
                            <Text caption bold>
                                {t('words.total')}
                            </Text>
                            <Text caption bold>
                                {formattedTotalAmount}
                            </Text>
                        </Row>
                    </Column>
                    <Divider />
                    <Column style={style.itemGroup}>
                        <NotesInput notes={notes} setNotes={setNotes} />
                    </Column>
                </Column>
            </Column>
            <Button
                title={t('words.send')}
                onPress={onSend}
                disabled={isProcessing}
                fullWidth
            />
            <FeeOverlay
                show={showFeeBreakdown}
                onDismiss={() => setShowFeeBreakdown(false)}
                title={feeBreakdownTitle}
                feeItems={feeItemsBreakdown}
                description={ecashFeesGuidanceText}
            />
        </SafeAreaContainer>
    )
}

/**
 * Confirmation screen for a USDT-denominated in-chat ecash payment.
 * Amounts are in USDT micros. USDT ecash payments have no Fedi fees,
 * so no fee estimation is performed.
 */
const ConfirmSendChatPaymentUsdt: React.FC<{
    amountMicros: number
    roomId: string
    notes?: string
    navigation: Props['navigation']
}> = ({ amountMicros, roomId, notes: initialNotes, navigation }) => {
    const { theme } = useTheme()
    const { t } = useTranslation()
    const [notes, setNotes] = useState(initialNotes ?? '')

    const existingRoom = useAppSelector(s => selectMatrixRoom(s, roomId))
    const { balanceMicros, isProcessing, handleSendUsdtPayment } =
        useChatUsdtPayment(t, roomId, existingRoom?.directUserId || '')

    const formattedAmount = formatUsdtMicros(amountMicros)

    const onSend = useCallback(async () => {
        handleSendUsdtPayment(
            amountMicros,
            () => {
                // go back to DirectChat to show sent payment
                navigation.dispatch(resetToDirectChat(roomId))
            },
            notes,
        )
    }, [amountMicros, handleSendUsdtPayment, navigation, notes, roomId])

    const style = styles(theme)

    return (
        <SafeAreaContainer style={style.container} edges="notop">
            <FederationWalletSelector fullWidth />
            <Column style={style.content} fullWidth align="center" grow>
                <Column style={style.amountContainer} align="center" fullWidth>
                    <Row center gap="xs">
                        {/* Official Tether mark carries its own colors, no tint */}
                        <SvgImage name="UsdtCircle" size={16} />
                        <Text bold caption>
                            {t('feature.usdt.usdt-balance')}
                        </Text>
                    </Row>
                    <SendAmounts
                        balanceDisplay={t(
                            'feature.wallet.available-balance-amount',
                            { amount: formatUsdtMicros(balanceMicros) },
                        )}
                        formattedPrimaryAmount={
                            <Text
                                h1
                                medium
                                numberOfLines={1}
                                style={style.usdtAmount}>
                                {formattedAmount}
                            </Text>
                        }
                    />
                </Column>
                <Column fullWidth>
                    {existingRoom && (
                        <>
                            <Row
                                align="center"
                                justify="between"
                                style={style.item}>
                                <Text caption bold>
                                    {t('feature.send.send-to')}
                                </Text>
                                <Row align="center" gap="sm">
                                    <ChatAvatar
                                        user={{
                                            ...existingRoom,
                                            displayName:
                                                existingRoom.name ?? '',
                                            avatarUrl:
                                                existingRoom.avatarUrl ??
                                                undefined,
                                        }}
                                        size={AvatarSize.sm}
                                    />
                                    <Text caption medium>
                                        {existingRoom.name}
                                    </Text>
                                </Row>
                            </Row>
                            <Divider />
                        </>
                    )}
                    <Column style={style.itemGroup} gap="md">
                        <Row align="center" justify="between">
                            <Text caption>{t('words.amount')}</Text>
                            <Text caption medium>
                                {formattedAmount}
                            </Text>
                        </Row>
                        <Row align="center" justify="between">
                            <Text caption bold>
                                {t('words.total')}
                            </Text>
                            <Text caption bold>
                                {formattedAmount}
                            </Text>
                        </Row>
                    </Column>
                    <Divider />
                    <Column style={style.itemGroup}>
                        <NotesInput notes={notes} setNotes={setNotes} />
                    </Column>
                </Column>
            </Column>
            <Button
                title={t('words.send')}
                onPress={onSend}
                disabled={isProcessing}
                fullWidth
            />
        </SafeAreaContainer>
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        container: {
            alignItems: 'center',
            paddingTop: theme.spacing.lg,
        },
        content: {
            paddingHorizontal: theme.spacing.xl,
        },
        item: {
            paddingVertical: theme.spacing.sm,
        },
        itemGroup: {
            paddingVertical: theme.spacing.md,
        },
        darkGrey: {
            color: theme.colors.darkGrey,
        },
        sendFrom: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
        },
        amountContainer: {
            paddingVertical: theme.spacing.xl,
        },
        usdtAmount: {
            color: theme.colors.moneyGreen,
            textAlign: 'center',
        },
    })

export default ConfirmSendChatPayment
