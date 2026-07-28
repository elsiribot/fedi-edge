import { Button, Text, Theme, useTheme } from '@rneui/themed'
import { dataToFrames } from 'qrloop'
import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Pressable, StyleSheet } from 'react-native'

import { selectIsInternetUnreachable } from '@fedi/common/redux'
import { encodeEcashToBuffer } from '@fedi/common/utils/qr'

import { useAppSelector } from '../../../state/hooks'
import { Column, Row } from '../../ui/Flex'
import HoloAlert from '../../ui/HoloAlert'
import QRCodeContainer from '../../ui/QRCodeContainer'
import { SafeScrollArea } from '../../ui/SafeArea'
import SvgImage from '../../ui/SvgImage'

type Props = {
    /** The ecash token (v1 base64 or v2 `fedimint…`), rendered as an animated QR and copied on tap */
    ecash: string
    /** Formatted primary (h1) amount, e.g. "0.001 BTC" or "$1.50" */
    formattedPrimaryAmount: string
    /** Optional formatted secondary amount (BTC shows a fiat line; USDT has none) */
    formattedSecondaryAmount?: string
    /**
     * Web claim link for the Share button; when undefined the Share button
     * falls back to sharing the raw ecash token instead of a web link.
     */
    shareUrl?: string
    /** Reclaims the notes + surfaces the result; wired by each thin screen */
    onCancel: () => void | Promise<void>
    /** Long-press "I have sent payment" handler (navigates to the success screen) */
    onConfirmSent: () => void
    /** Disables the cancel affordance while a reclaim is in-flight */
    cancelDisabled?: boolean
}

/**
 * Shared offline-ecash QR display, rendered by the Bitcoin (SendOfflineQr)
 * and USDT (UsdtSendOfflineQr) thin screens. Owns the animated QR frame
 * loop, the cancel-confirmation dialog, and the layout; the reclaim logic
 * and success navigation differ per asset and are passed in.
 */
const OfflineQrScreen: React.FC<Props> = ({
    ecash,
    formattedPrimaryAmount,
    formattedSecondaryAmount,
    shareUrl,
    onCancel,
    onConfirmSent,
    cancelDisabled,
}) => {
    const { theme } = useTheme()
    const { t } = useTranslation()
    const [index, setIndex] = useState(0)
    const isOffline = useAppSelector(selectIsInternetUnreachable)

    const frames = useMemo(() => {
        return dataToFrames(encodeEcashToBuffer(ecash))
    }, [ecash])

    // show new qr every 100ms
    useEffect(() => {
        const interval = setInterval(() => {
            setIndex((index + 1) % frames.length)
        }, 100)
        return () => clearInterval(interval)
    }, [index, frames])

    const style = styles(theme)

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
                    onPress: onCancel,
                },
            ],
        )
    }

    return (
        <SafeScrollArea safeAreaContainerStyle={style.container} edges="notop">
            <Column align="center" gap="xs">
                <Text h1>{formattedPrimaryAmount}</Text>
                {formattedSecondaryAmount !== undefined && (
                    <Text style={style.secondaryAmount}>
                        {formattedSecondaryAmount}
                    </Text>
                )}
            </Column>
            <QRCodeContainer
                qrValue={frames[index]}
                copyValue={ecash}
                copyMessage={t('phrases.copied-ecash-token')}
                shareValue={shareUrl}
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
                        disabled={cancelDisabled}>
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
                    onLongPress={onConfirmSent}
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
        secondaryAmount: {
            color: theme.colors.darkGrey,
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

export default OfflineQrScreen
