import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Text, Theme, useTheme } from '@rneui/themed'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native'

import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import {
    useFormatUsdtMicros,
    useUsdtAmountInput,
} from '@fedi/common/hooks/usdt'
import { refreshUsdtBalance, selectPaymentFederation } from '@fedi/common/redux'
import { makeLog } from '@fedi/common/utils/log'
import { microsToDecimalString } from '@fedi/common/utils/usdt'

import ReceiveQr from '../components/feature/receive/ReceiveQr'
import { Column, Row } from '../components/ui/Flex'
import { SafeAreaContainer } from '../components/ui/SafeArea'
import SvgImage from '../components/ui/SvgImage'
import UsdtAmountInput from '../components/ui/UsdtAmountInput'
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
    const formatUsdt = useFormatUsdtMicros()
    const { amountInput, setAmountInput, setAmountFromMicros, amountMicros } =
        useUsdtAmountInput()

    const federation = useAppSelector(selectPaymentFederation)
    const federationId = federation?.id ?? ''

    const [address, setAddress] = useState<string | null>(null)
    const [receivedMicros, setReceivedMicros] = useState(0)
    // Optional requested amount, encoded as a Fedi-convention
    // `ethereum:<address>?amount=<decimal USDT>` URI in the QR
    const [requestedMicros, setRequestedMicros] = useState<number | null>(null)
    const [isEnteringAmount, setIsEnteringAmount] = useState(false)

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

    const handleEditRequestAmount = () => {
        setAmountFromMicros(requestedMicros)
        setIsEnteringAmount(true)
    }

    const handleConfirmRequestAmount = () => {
        setRequestedMicros(
            amountMicros !== null && amountMicros > 0 ? amountMicros : null,
        )
        setIsEnteringAmount(false)
    }

    // Machine format only - URIs never carry locale-formatted amounts.
    // Actual contract (this screen only — OnchainReceiveQr has no
    // amount-request feature, so it isn't precedent here): `body`
    // (copy-to-clipboard + the truncated caption) is always the bare
    // `0x…` address, so pasting it elsewhere (e.g. an exchange withdrawal
    // field) never hands over a URI with query params. `requestUri` feeds
    // both the on-screen QR (via `qrValue`) and `fullString` (Share), and
    // carries the amount request — `ethereum:<address>?amount=<amount>` —
    // whenever one is set, so scanning the QR prefills the sender's amount
    // step (see UsdtSend.tsx's `ethereum:` URI parsing).
    const requestUri =
        address && requestedMicros
            ? `ethereum:${address}?amount=${microsToDecimalString(requestedMicros)}`
            : (address ?? '')

    const style = styles(theme)

    if (isEnteringAmount) {
        return (
            <SafeAreaContainer edges="notop">
                <Column grow style={style.container}>
                    <UsdtAmountInput
                        amountInput={amountInput}
                        onChangeAmountInput={setAmountInput}
                    />
                    <Button
                        title={t('words.done')}
                        onPress={handleConfirmRequestAmount}
                        containerStyle={style.button}
                    />
                </Column>
            </SafeAreaContainer>
        )
    }

    return (
        <SafeAreaContainer edges="notop">
            <Column grow gap="lg" style={style.container}>
                <ReceiveQr
                    uri={{
                        fullString: requestUri,
                        body: address ?? '',
                    }}
                    qrValue={requestUri}
                    isLoading={!address}>
                    <Column gap="sm">
                        <Pressable
                            disabled={!address}
                            onPress={handleEditRequestAmount}>
                            <Row center gap="sm">
                                <SvgImage
                                    name="Edit"
                                    size={16}
                                    color={theme.colors.primary}
                                />
                                <Text caption medium>
                                    {requestedMicros
                                        ? t('feature.usdt.requesting-amount', {
                                              amount: formatUsdt(
                                                  requestedMicros,
                                              ),
                                          })
                                        : t('feature.usdt.request-amount')}
                                </Text>
                            </Row>
                        </Pressable>
                        <Row center gap="sm" style={style.statusContainer}>
                            {receivedMicros > 0 ? (
                                <>
                                    <SvgImage
                                        name="Check"
                                        size="sm"
                                        color={theme.colors.moneyGreen}
                                    />
                                    <Text caption medium>
                                        {`${t('feature.usdt.deposit-received')}: ${formatUsdt(receivedMicros)}`}
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
                        <Row gap="sm" style={style.statusContainer}>
                            <SvgImage
                                name="AlertWarningTriangle"
                                size="sm"
                                color={theme.colors.darkGrey}
                            />
                            <Column gap="xs" shrink>
                                <Text caption medium>
                                    {t('feature.usdt.network-notice-title')}
                                </Text>
                                <Text small color={theme.colors.darkGrey}>
                                    {t('feature.usdt.network-notice-body')}
                                </Text>
                            </Column>
                        </Row>
                    </Column>
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
        button: {
            marginTop: theme.spacing.md,
        },
    })

export default UsdtReceive
