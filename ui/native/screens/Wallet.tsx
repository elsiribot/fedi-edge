import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs'
import { useNavigation } from '@react-navigation/native'
import { Button, Text, useTheme, type Theme } from '@rneui/themed'
import React, { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollView, StyleSheet } from 'react-native'

import {
    useIsStabilityPoolEnabledByFederation,
    useIsUsdtOnlyFederation,
    useIsUsdtSupported,
} from '@fedi/common/hooks/federation'
import { useWalletButtons } from '@fedi/common/hooks/wallet'
import {
    selectCurrency,
    selectIsInternetUnreachable,
    setSelectedFederationId,
    selectLoadedFederations,
    selectLoadedFederationsByRecency,
    selectPaymentType,
    selectSelectedFederation,
    setPaymentType,
    setPayFromFederationId,
    type PaymentType,
} from '@fedi/common/redux'
import { getCurrencyCode } from '@fedi/common/utils/currency'

import WalletBalanceCard from '../components/feature/federations/BalanceCard'
import FederationStatusAvatar from '../components/feature/federations/FederationStatusAvatar'
import WalletSetupEmpty from '../components/feature/wallet/WalletSetupEmpty'
import { Column, Row } from '../components/ui/Flex'
import HelpTooltip from '../components/ui/HelpTooltip'
import { Pressable } from '../components/ui/Pressable'
import SvgImage from '../components/ui/SvgImage'
import { Switcher, type Option } from '../components/ui/Switcher'
import { useAppDispatch, useAppSelector } from '../state/hooks'
import { LoadedFederation } from '../types'
import type {
    RootStackParamList,
    TabsNavigatorParamList,
} from '../types/navigation'

export type Props = BottomTabScreenProps<
    TabsNavigatorParamList & RootStackParamList,
    'Wallet'
>

const Wallet: React.FC<Props> = ({ navigation }) => {
    const { theme } = useTheme()
    const { t } = useTranslation()

    const federation = useAppSelector(selectSelectedFederation)
    const federationId = federation?.id ?? ''
    const paymentType = useAppSelector(selectPaymentType)
    const loadedFederations = useAppSelector(selectLoadedFederations)
    const loadedFederationsByRecency = useAppSelector(
        selectLoadedFederationsByRecency,
    )
    const selectedCurrency = useAppSelector(s =>
        selectCurrency(s, federationId),
    )
    const isOffline = useAppSelector(selectIsInternetUnreachable)

    const stabilityPoolDisabledByFederation =
        !useIsStabilityPoolEnabledByFederation(federationId)
    const isUsdtSupported = useIsUsdtSupported(federationId)
    const isUsdtOnlyFederation = useIsUsdtOnlyFederation(federationId)

    const { sendDisabled, receiveDisabled, disabledMessage } = useWalletButtons(
        t,
        federationId,
    )

    const dispatch = useAppDispatch()

    const handleReceive = () => {
        dispatch(setPayFromFederationId(federationId))
        if (paymentType === 'stable-balance') {
            navigation.navigate('StabilityReceive', { federationId })
        } else if (paymentType === 'usdt') {
            navigation.navigate('UsdtReceive')
        } else {
            navigation.navigate('ReceiveBitcoin', {})
        }
    }

    const handleSend = () => {
        dispatch(setPayFromFederationId(federationId))
        if (paymentType === 'stable-balance') {
            navigation.navigate('StabilitySend', { federationId })
        } else if (paymentType === 'usdt') {
            navigation.navigate('UsdtSend')
        } else if (isOffline) {
            navigation.navigate('SendOfflineAmount')
        } else {
            navigation.navigate('Send', { federationId })
        }
    }

    const currencyCode = getCurrencyCode(selectedCurrency)
    const style = styles(theme)

    const switcherOptions = useMemo(() => {
        const options: Option<PaymentType>[] = []
        if (!isUsdtOnlyFederation) {
            options.push({
                label: t('words.bitcoin'),
                value: 'bitcoin',
            })
            if (!stabilityPoolDisabledByFederation) {
                options.push({
                    label: currencyCode,
                    value: 'stable-balance',
                })
            }
        }
        if (isUsdtSupported) {
            options.push({
                label: t('feature.usdt.usdt-balance'),
                value: 'usdt',
            })
        }
        return options
    }, [
        t,
        currencyCode,
        isUsdtOnlyFederation,
        isUsdtSupported,
        stabilityPoolDisabledByFederation,
    ])

    useEffect(() => {
        if (loadedFederationsByRecency.length > 0 && !federation)
            dispatch(setSelectedFederationId(loadedFederationsByRecency[0].id))
    }, [federation, loadedFederationsByRecency, dispatch])

    // If the current federation is USDT-only, force the USDT account.
    // Otherwise if the current payment type isn't supported by the
    // federation, switch back to bitcoin.
    useEffect(() => {
        if (isUsdtOnlyFederation) {
            if (paymentType !== 'usdt') dispatch(setPaymentType('usdt'))
        } else if (paymentType === 'usdt' && !isUsdtSupported) {
            dispatch(setPaymentType('bitcoin'))
        } else if (
            paymentType === 'stable-balance' &&
            stabilityPoolDisabledByFederation
        ) {
            dispatch(setPaymentType('bitcoin'))
        }
    }, [
        dispatch,
        paymentType,
        isUsdtOnlyFederation,
        isUsdtSupported,
        stabilityPoolDisabledByFederation,
    ])

    if (loadedFederations.length === 0) {
        return <WalletSetupEmpty navigation={navigation} />
    }

    if (!federation) return null

    return (
        <ScrollView
            contentContainerStyle={style.container}
            style={style.scrollContainer}
            alwaysBounceVertical={false}>
            <Column gap="lg" fullWidth grow>
                <SelectedWalletHeader federation={federation} />
                {switcherOptions.length > 1 && (
                    <Switcher<PaymentType>
                        options={switcherOptions}
                        onChange={type => dispatch(setPaymentType(type))}
                        selected={paymentType}
                    />
                )}
                <WalletBalanceCard federationId={federationId} />
                <Row fullWidth gap="md" justify="between">
                    <Button
                        title={t('words.receive')}
                        icon={
                            <SvgImage
                                name="ArrowDown"
                                color={
                                    receiveDisabled
                                        ? theme.colors.lightGrey
                                        : theme.colors.white
                                }
                            />
                        }
                        containerStyle={{
                            flex: 1,
                        }}
                        onPress={handleReceive}
                        disabled={receiveDisabled}
                    />
                    <Button
                        title={t('words.send')}
                        icon={
                            <SvgImage
                                name="ArrowUp"
                                color={
                                    sendDisabled
                                        ? theme.colors.lightGrey
                                        : theme.colors.white
                                }
                            />
                        }
                        containerStyle={{
                            flex: 1,
                        }}
                        onPress={handleSend}
                        disabled={sendDisabled}
                    />
                </Row>
                {disabledMessage && (
                    <Text
                        center
                        caption
                        color={theme.colors.darkGrey}
                        style={style.disabledText}>
                        {disabledMessage}
                    </Text>
                )}
            </Column>
        </ScrollView>
    )
}

function SelectedWalletHeader({
    federation,
}: {
    federation: LoadedFederation
}) {
    const navigation = useNavigation()
    const { t } = useTranslation()
    const { theme } = useTheme()

    const goToFederationDetails = () => {
        navigation.navigate('FederationDetails', {
            federationId: federation.id,
        })
    }

    const style = styles(theme)

    return (
        <Pressable
            containerStyle={style.paymentFederationHeader}
            onPress={goToFederationDetails}
            testID={federation.name.concat('DetailsButton').replaceAll(' ', '')}
            // hitSlop is intentionally set to 9 to expand the hit area
            // but not cause accidental tab presses
            hitSlop={8}>
            <FederationStatusAvatar federation={federation} size={48} />
            <Text medium h2 style={style.title}>
                {federation.name}
            </Text>
            <HelpTooltip
                hitSlop={8}
                svgProps={{ color: theme.colors.grey, size: 24 }}>
                <Text caption>
                    {t('feature.wallet.wallet-provider-guidance')}
                </Text>
            </HelpTooltip>
            <SvgImage
                name="ChevronRight"
                color={theme.colors.darkGrey}
                containerStyle={style.icon}
                size="sm"
            />
        </Pressable>
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        scrollContainer: {
            flex: 1,
        },
        container: {
            padding: theme.spacing.lg,
            paddingBottom: theme.spacing.xl,
            width: '100%',
            flexGrow: 1,
        },
        paymentFederationHeader: {
            width: '100%',
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            paddingVertical: 0,
            paddingHorizontal: 0,
        },
        icon: {
            marginLeft: 'auto',
        },
        title: {
            color: theme.colors.primary,
            flexShrink: 1,
            flexGrow: 1,
        },
        disabledText: {
            paddingBottom: theme.spacing.md,
        },
    })

export default Wallet
