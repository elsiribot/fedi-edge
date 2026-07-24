import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Text, Theme, useTheme } from '@rneui/themed'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, StyleSheet } from 'react-native'

import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import { refreshUsdtBalance, selectPaymentFederation } from '@fedi/common/redux'
import { makeLog } from '@fedi/common/utils/log'
import { formatUsdtMicros } from '@fedi/common/utils/usdt'

import ReceiveQr from '../components/feature/receive/ReceiveQr'
import { Column, Row } from '../components/ui/Flex'
import { SafeAreaContainer } from '../components/ui/SafeArea'
import SvgImage from '../components/ui/SvgImage'
import { useAppDispatch, useAppSelector } from '../state/hooks'
import type { RootStackParamList } from '../types/navigation'

const log = makeLog('UsdtReceive')

export type Props = NativeStackScreenProps<RootStackParamList, 'UsdtReceive'>

const UsdtReceive: React.FC<Props> = () => {
    const { t } = useTranslation()
    const { theme } = useTheme()
    const toast = useToast()
    const fedimint = useFedimint()
    const dispatch = useAppDispatch()

    const federation = useAppSelector(selectPaymentFederation)
    const federationId = federation?.id ?? ''

    const [address, setAddress] = useState<string | null>(null)
    const [receivedMicros, setReceivedMicros] = useState(0)

    // Generate a fresh deposit address on mount
    useEffect(() => {
        if (!federationId) return
        let cancelled = false

        fedimint
            .usdtGenerateDepositAddress(federationId)
            .then(depositAddress => {
                if (!cancelled) setAddress(depositAddress)
            })
            .catch(e => toast.error(t, e))

        return () => {
            cancelled = true
        }
    }, [federationId, fedimint, toast, t])

    // Poll the deposit status + listen for deposit events for this address
    useEffect(() => {
        if (!federationId || !address) return

        const checkDepositStatus = async () => {
            try {
                const status = await fedimint.usdtDepositStatus(
                    federationId,
                    address,
                )
                setReceivedMicros(received =>
                    Math.max(received, status.credited),
                )
            } catch (e) {
                log.warn('Failed to check USDT deposit status', e)
            }
        }

        checkDepositStatus()
        const depositStatusMonitor = setInterval(checkDepositStatus, 10000)

        const unsubscribe = fedimint.addListener('usdtDeposit', event => {
            if (event.federationId !== federationId) return
            if (event.address !== address) return
            const state = event.state
            if (state.type === 'claimed') {
                setReceivedMicros(received => Math.max(received, state.amount))
                dispatch(refreshUsdtBalance({ fedimint, federationId }))
            }
        })

        return () => {
            clearInterval(depositStatusMonitor)
            unsubscribe()
        }
    }, [address, federationId, fedimint, dispatch])

    const style = styles(theme)

    return (
        <SafeAreaContainer edges="notop">
            <Column grow gap="lg" style={style.container}>
                <ReceiveQr
                    uri={{
                        fullString: address ?? '',
                        body: address ?? '',
                    }}
                    isLoading={!address}>
                    <Row center gap="sm" style={style.statusContainer}>
                        {receivedMicros > 0 ? (
                            <>
                                <SvgImage
                                    name="Check"
                                    size="sm"
                                    color={theme.colors.moneyGreen}
                                />
                                <Text caption medium>
                                    {`${t('feature.usdt.deposit-received')}: ${formatUsdtMicros(receivedMicros)}`}
                                </Text>
                            </>
                        ) : (
                            <>
                                <ActivityIndicator size="small" />
                                <Text caption color={theme.colors.darkGrey}>
                                    {t('feature.usdt.awaiting-deposit')}
                                </Text>
                            </>
                        )}
                    </Row>
                </ReceiveQr>
            </Column>
        </SafeAreaContainer>
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        container: {
            paddingTop: theme.spacing.lg,
        },
        statusContainer: {
            padding: theme.spacing.md,
            backgroundColor: theme.colors.offWhite100,
            borderRadius: theme.borders.tileRadius,
            width: '100%',
        },
    })

export default UsdtReceive
