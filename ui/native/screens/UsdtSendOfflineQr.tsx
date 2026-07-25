import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Text, Theme, useTheme } from '@rneui/themed'
import { Buffer } from 'buffer'
import { dataToFrames } from 'qrloop'
import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Pressable, StyleSheet } from 'react-native'

import { WEB_APP_URL } from '@fedi/common/constants/api'
import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import {
    refreshUsdtBalance,
    selectIsInternetUnreachable,
    selectPaymentFederation,
} from '@fedi/common/redux'
import { formatUsdtMicros } from '@fedi/common/utils/usdt'

import { Column, Row } from '../components/ui/Flex'
import HoloAlert from '../components/ui/HoloAlert'
import QRCodeContainer from '../components/ui/QRCodeContainer'
import { SafeScrollArea } from '../components/ui/SafeArea'
import SvgImage from '../components/ui/SvgImage'
import { useAppDispatch, useAppSelector } from '../state/hooks'
import { reset } from '../state/navigation'
import type { RootStackParamList } from '../types/navigation'

export type Props = NativeStackScreenProps<
    RootStackParamList,
    'UsdtSendOfflineQr'
>

/**
 * Displays generated USDT ecash notes as an animated QR (modeled on the
 * Bitcoin SendOfflineQr screen). Cancelling reclaims the notes via
 * `usdtReceiveEcash`.
 */
const UsdtSendOfflineQr: React.FC<Props> = ({ navigation, route }: Props) => {
    const { ecash, amountMicros } = route.params
    const { theme } = useTheme()
    const { t } = useTranslation()
    const toast = useToast()
    const fedimint = useFedimint()
    const dispatch = useAppDispatch()
    const [index, setIndex] = useState(0)
    const [isCancelling, setIsCancelling] = useState(false)
    const federation = useAppSelector(selectPaymentFederation)
    const federationId = federation?.id ?? ''
    const isOffline = useAppSelector(selectIsInternetUnreachable)

    const frames = useMemo(() => {
        return dataToFrames(Buffer.from(ecash, 'base64'))
    }, [ecash])

    // show new qr every 100ms
    useEffect(() => {
        const interval = setInterval(() => {
            setIndex((index + 1) % frames.length)
        }, 100)
        return () => clearInterval(interval)
    }, [index, frames])

    const formattedAmount = formatUsdtMicros(amountMicros)
    const style = styles(theme)

    const shareLink = `${WEB_APP_URL}/link#screen=ecash&id=${ecash}`

    const handleCancelEcashNotes = async () => {
        if (!federationId || isCancelling) return
        setIsCancelling(true)
        try {
            // Reclaim our own notes to cancel the send
            await fedimint.usdtReceiveEcash(ecash, federationId)
            dispatch(refreshUsdtBalance({ fedimint, federationId }))

            toast.show({
                status: 'success',
                content: t('phrases.canceled-ecash-send'),
            })

            navigation.navigate('EcashSendCancelled')
        } catch (e) {
            toast.error(t, e)
        } finally {
            setIsCancelling(false)
        }
    }

    const handleCancelSend = () => {
        Alert.alert(
            t('phrases.please-confirm'),
            t('feature.send.cancel-notes-warning'),
            [
                {
                    text: t('phrases.go-back'),
                },
                {
                    text: t('words.continue'),
                    onPress: handleCancelEcashNotes,
                },
            ],
        )
    }

    return (
        <SafeScrollArea safeAreaContainerStyle={style.container} edges="notop">
            <Column align="center" gap="xs">
                <Text h1>{formattedAmount}</Text>
            </Column>
            <QRCodeContainer
                qrValue={frames[index]}
                copyValue={ecash}
                copyMessage={t('phrases.copied-ecash-token')}
                shareValue={shareLink}
                disableSave
                showActionButtons
            />
            <HoloAlert text={t('feature.send.ecash-recipient-notice')} />
            <Column
                align="center"
                gap="md"
                fullWidth
                style={style.optionsContainer}>
                {isOffline ? null : (
                    <Pressable
                        onPress={handleCancelSend}
                        disabled={isCancelling}>
                        <Row center gap="sm" style={style.cancelSendContainer}>
                            <SvgImage
                                name="Close"
                                size={20}
                                color={theme.colors.red}
                            />
                            <Text style={style.cancelSendText} caption medium>
                                {t('feature.send.cancel-send')}
                            </Text>
                        </Row>
                    </Pressable>
                )}
                <Button
                    fullWidth
                    title={t('feature.send.i-have-sent-payment')}
                    onLongPress={() => {
                        navigation.dispatch(
                            reset('SendSuccessShield', {
                                title: t('feature.send.you-sent'),
                                formattedAmount,
                                description: '',
                            }),
                        )
                    }}
                    delayLongPress={500}
                />
                <Text small>{t('phrases.hold-to-confirm')}</Text>
            </Column>
        </SafeScrollArea>
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        container: {
            alignItems: 'center',
            gap: theme.spacing.xl,
            paddingVertical: theme.spacing.lg,
        },
        cancelSendContainer: {
            paddingVertical: theme.spacing.md,
        },
        cancelSendText: {
            color: theme.colors.red,
        },
        optionsContainer: {
            marginTop: 'auto',
        },
    })

export default UsdtSendOfflineQr
