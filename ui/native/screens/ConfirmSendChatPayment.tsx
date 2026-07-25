import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Divider, Text, Theme, useTheme } from '@rneui/themed'
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StyleSheet } from 'react-native'

import { useAmountFormatter, useBalance } from '@fedi/common/hooks/amount'
import { useChatPaymentPush } from '@fedi/common/hooks/chat'
import { useCommonSelector } from '@fedi/common/hooks/redux'
import {
    useEcashFeeDetails,
    useFeeDisplayUtils,
} from '@fedi/common/hooks/transactions'
import { useFormatUsdtMicros } from '@fedi/common/hooks/usdt'
import {
    selectCurrency,
    selectMatrixRoom,
    selectPaymentFederation,
} from '@fedi/common/redux'
import { Sats } from '@fedi/common/types'
import { RpcEcashUnit } from '@fedi/common/types/bindings'
import amountUtils from '@fedi/common/utils/AmountUtils'

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
            <ConfirmSendChatPaymentInner
                unit="usdt"
                amountMicros={params.amountMicros}
                roomId={params.roomId}
                notes={params.notes}
                navigation={navigation}
            />
        )
    }

    return (
        <ConfirmSendChatPaymentInner
            unit="bitcoin"
            amount={params.amount}
            roomId={params.roomId}
            notes={params.notes}
            navigation={navigation}
        />
    )
}

/**
 * Confirmation screen for an in-chat ecash payment push. Defaults to a
 * bitcoin (sats-denominated) payment with fee estimation; when
 * `unit === 'usdt'`, `amountMicros` (USDT micros) is used instead, no fee
 * estimation is performed (USDT ecash has no Fedi fees), and the balance /
 * amount rendering uses the USDT-specific display.
 */
const ConfirmSendChatPaymentInner: React.FC<{
    unit: RpcEcashUnit
    amount?: Sats
    amountMicros?: number
    roomId: string
    notes?: string
    navigation: Props['navigation']
}> = ({
    unit,
    amount: btcAmountProp,
    amountMicros: usdtAmountMicrosProp,
    roomId,
    notes: initialNotes,
    navigation,
}) => {
    const isUsdt = unit === 'usdt'
    const btcAmount = (btcAmountProp ?? (0 as Sats)) as Sats
    const usdtAmountMicros = usdtAmountMicrosProp ?? 0

    const { theme } = useTheme()
    const { t } = useTranslation()
    const [showFeeBreakdown, setShowFeeBreakdown] = useState<boolean>(false)
    const [notes, setNotes] = useState(initialNotes ?? '')
    const paymentFederation = useAppSelector(selectPaymentFederation)
    const { feeBreakdownTitle, ecashFeesGuidanceText, makeEcashFeeContent } =
        useFeeDisplayUtils(t, paymentFederation?.id || '')
    const amountMsats = amountUtils.satToMsat(btcAmount)
    // Called unconditionally (hook rules): for a USDT payment `btcAmount`
    // defaults to 0, so `amountMsats` is 0 and this suppresses the fee-details
    // RPC (USDT ecash carries no Fedi fees).
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
        makeFormattedAmountsFromSats(btcAmount)
    const formatUsdt = useFormatUsdtMicros()
    const formattedUsdtAmount = formatUsdt(usdtAmountMicros)

    const existingRoom = useAppSelector(s => selectMatrixRoom(s, roomId))
    const { balanceMicros, isProcessing, handleSendPayment } =
        useChatPaymentPush(
            t,
            roomId,
            existingRoom?.directUserId || '',
            unit,
        )

    const onSend = useCallback(async () => {
        handleSendPayment(
            isUsdt ? usdtAmountMicros : btcAmount,
            () => {
                // go back to DirectChat to show sent payment
                navigation.dispatch(resetToDirectChat(roomId))
            },
            notes,
        )
    }, [
        btcAmount,
        handleSendPayment,
        isUsdt,
        navigation,
        notes,
        roomId,
        usdtAmountMicros,
    ])

    const style = styles(theme)

    return (
        <SafeAreaContainer style={style.container} edges="notop">
            <FederationWalletSelector fullWidth />
            <Column style={style.content} fullWidth align="center" grow>
                <Column style={style.amountContainer} align="center" fullWidth>
                    {isUsdt ? (
                        <>
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
                                    { amount: formatUsdt(balanceMicros) },
                                )}
                                formattedPrimaryAmount={
                                    <Text
                                        h1
                                        medium
                                        numberOfLines={1}
                                        style={style.usdtAmount}>
                                        {formattedUsdtAmount}
                                    </Text>
                                }
                            />
                        </>
                    ) : (
                        <>
                            <PaymentType type="ecash" />
                            <SendAmounts
                                balanceDisplay={formattedBalanceText}
                                formattedPrimaryAmount={formattedPrimaryAmount}
                                formattedSecondaryAmount={
                                    formattedSecondaryAmount
                                }
                            />
                        </>
                    )}
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
                        {isUsdt ? (
                            <>
                                <Row align="center" justify="between">
                                    <Text caption>{t('words.amount')}</Text>
                                    <Text caption medium>
                                        {formattedUsdtAmount}
                                    </Text>
                                </Row>
                                <Row align="center" justify="between">
                                    <Text caption bold>
                                        {t('words.total')}
                                    </Text>
                                    <Text caption bold>
                                        {formattedUsdtAmount}
                                    </Text>
                                </Row>
                            </>
                        ) : (
                            <>
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
                                            onPress={() =>
                                                setShowFeeBreakdown(true)
                                            }
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
                            </>
                        )}
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
            {!isUsdt && (
                <FeeOverlay
                    show={showFeeBreakdown}
                    onDismiss={() => setShowFeeBreakdown(false)}
                    title={feeBreakdownTitle}
                    feeItems={feeItemsBreakdown}
                    description={ecashFeesGuidanceText}
                />
            )}
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
