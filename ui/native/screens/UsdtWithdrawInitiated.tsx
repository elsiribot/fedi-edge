import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Text, Theme, useTheme } from '@rneui/themed'
import { TFunction } from 'i18next'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useFormatUsdtMicros } from '@fedi/common/hooks/usdt'
import { selectPaymentFederation } from '@fedi/common/redux'
import { RpcUsdtWithdrawalStatus } from '@fedi/common/types/bindings'
import stringUtils from '@fedi/common/utils/StringUtils'
import { makeLog } from '@fedi/common/utils/log'

import HoloCircle from '../components/ui/HoloCircle'
import SvgImage from '../components/ui/SvgImage'
import { useAppSelector } from '../state/hooks'
import { resetToWallets } from '../state/navigation'
import type { RootStackParamList } from '../types/navigation'

const log = makeLog('UsdtWithdrawInitiated')

export type Props = NativeStackScreenProps<
    RootStackParamList,
    'UsdtWithdrawInitiated'
>

const getStatusText = (
    t: TFunction,
    status: RpcUsdtWithdrawalStatus | null,
): string => {
    switch (status?.type) {
        case 'signing':
            return t('feature.usdt.withdrawal-signing')
        case 'submitted':
            return t('feature.usdt.withdrawal-submitted')
        case 'confirmed':
            return t('feature.usdt.withdrawal-confirmed')
        case 'failed':
            return t('feature.usdt.withdrawal-failed', {
                reason: status.reason,
            })
        case 'queued':
        default:
            return t('feature.usdt.withdrawal-queued')
    }
}

const UsdtWithdrawInitiated: React.FC<Props> = ({ route, navigation }) => {
    const { t } = useTranslation()
    const { theme } = useTheme()
    const fedimint = useFedimint()
    const formatUsdt = useFormatUsdtMicros()
    const { txid, amountMicros, recipient } = route.params

    const federation = useAppSelector(selectPaymentFederation)
    const federationId = federation?.id ?? ''

    const [status, setStatus] = useState<RpcUsdtWithdrawalStatus | null>(null)

    const isFinal = status?.type === 'confirmed' || status?.type === 'failed'

    // Poll the withdrawal status + listen for withdrawal events for this txid
    useEffect(() => {
        if (!federationId || !txid || isFinal) return

        const checkWithdrawalStatus = async () => {
            try {
                const withdrawalStatus = await fedimint.usdtWithdrawalStatus(
                    federationId,
                    txid,
                )
                setStatus(withdrawalStatus)
            } catch (e) {
                log.warn('Failed to check USDT withdrawal status', e)
            }
        }

        checkWithdrawalStatus()
        const withdrawalStatusMonitor = setInterval(checkWithdrawalStatus, 5000)

        const unsubscribe = fedimint.addListener('usdtWithdrawal', event => {
            if (event.federationId !== federationId) return
            if (event.txid !== txid) return
            setStatus(event.state)
        })

        return () => {
            clearInterval(withdrawalStatusMonitor)
            unsubscribe()
        }
    }, [federationId, txid, isFinal, fedimint])

    const style = styles(theme)

    return (
        <SafeAreaView
            style={style.container}
            edges={{ left: 'additive', right: 'additive', bottom: 'maximum' }}>
            <View style={style.holoCircleContainer}>
                <HoloCircle
                    content={
                        <View style={style.holoContentContainer}>
                            {/* Official Tether mark carries its own colors, no tint */}
                            <SvgImage name="UsdtCircle" size={32} />
                            <Text medium style={style.holoText}>
                                {t('feature.usdt.withdrawal-initiated')}
                            </Text>
                            <Text h2 medium style={style.holoText}>
                                {formatUsdt(amountMicros)}
                            </Text>
                            <Text
                                caption
                                medium
                                style={[style.holoText, style.darkGrey]}>
                                {t('feature.usdt.sent-to', {
                                    address: stringUtils.truncateMiddleOfString(
                                        recipient,
                                        6,
                                    ),
                                })}
                            </Text>
                            <Text
                                caption
                                medium
                                style={[style.holoText, style.darkGrey]}>
                                {getStatusText(t, status)}
                            </Text>
                        </View>
                    }
                />
            </View>
            <Button
                fullWidth
                containerStyle={style.button}
                onPress={() => navigation.dispatch(resetToWallets())}
                title={
                    <Text medium caption style={style.buttonText}>
                        {t('words.okay')}
                    </Text>
                }
            />
        </SafeAreaView>
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        container: {
            flexDirection: 'column',
            flex: 1,
            alignItems: 'center',
            padding: theme.spacing.lg,
        },
        holoCircleContainer: {
            marginTop: 'auto',
        },
        holoContentContainer: {
            textAlign: 'center',
            alignItems: 'center',
        },
        holoText: {
            textAlign: 'center',
            paddingVertical: theme.spacing.xs,
            maxWidth: 220,
        },
        darkGrey: {
            color: theme.colors.darkGrey,
        },
        button: {
            marginTop: 'auto',
        },
        buttonText: {
            color: theme.colors.secondary,
        },
    })

export default UsdtWithdrawInitiated
