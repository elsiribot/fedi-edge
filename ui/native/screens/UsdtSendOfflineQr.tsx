import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import { useFormatUsdtMicros } from '@fedi/common/hooks/usdt'
import { refreshUsdtBalance, selectPaymentFederation } from '@fedi/common/redux'

import OfflineQrScreen from '../components/feature/send/OfflineQrScreen'
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
    const { t } = useTranslation()
    const toast = useToast()
    const fedimint = useFedimint()
    const dispatch = useAppDispatch()
    const formatUsdt = useFormatUsdtMicros()
    const [isCancelling, setIsCancelling] = useState(false)
    const federation = useAppSelector(selectPaymentFederation)
    const federationId = federation?.id ?? ''

    const formattedAmount = formatUsdt(amountMicros)

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

    return (
        <OfflineQrScreen
            ecash={ecash}
            formattedPrimaryAmount={formattedAmount}
            // TODO(Task 17): re-enable the web share link once the web ecash
            // claim page renders v2/USDT notes as USDT instead of SATS. Until
            // then omit shareUrl so Share falls back to the raw ecash token
            // rather than exposing a wrong-asset claim page.
            shareUrl={undefined}
            onCancel={handleCancelEcashNotes}
            cancelDisabled={isCancelling}
            onConfirmSent={() => {
                navigation.dispatch(
                    reset('SendSuccessShield', {
                        title: t('feature.send.you-sent'),
                        formattedAmount,
                        description: '',
                    }),
                )
            }}
        />
    )
}

export default UsdtSendOfflineQr
