import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { WEB_APP_URL } from '@fedi/common/constants/api'
import { useAmountFormatter } from '@fedi/common/hooks/amount'
import { useFedimint } from '@fedi/common/hooks/fedimint'
import { useToast } from '@fedi/common/hooks/toast'
import { cancelEcash, selectPaymentFederation } from '@fedi/common/redux'

import OfflineQrScreen from '../components/feature/send/OfflineQrScreen'
import { useAppDispatch, useAppSelector } from '../state/hooks'
import { reset } from '../state/navigation'
import type { RootStackParamList } from '../types/navigation'

export type Props = NativeStackScreenProps<RootStackParamList, 'SendOfflineQr'>

const SendOfflineQr: React.FC<Props> = ({ navigation, route }: Props) => {
    const { ecash, amount } = route.params
    const { t } = useTranslation()
    const toast = useToast()
    const paymentFederation = useAppSelector(selectPaymentFederation)
    const { makeFormattedAmountsFromMSats } = useAmountFormatter({
        federationId: paymentFederation?.id,
    })
    const dispatch = useAppDispatch()
    const fedimint = useFedimint()

    const { formattedPrimaryAmount, formattedSecondaryAmount } =
        makeFormattedAmountsFromMSats(amount)

    const handleCancelEcashNotes = async () => {
        try {
            await dispatch(cancelEcash({ fedimint, ecash })).unwrap()

            toast.show({
                status: 'success',
                content: t('phrases.canceled-ecash-send'),
            })

            navigation.navigate('EcashSendCancelled')
        } catch (e) {
            toast.error(t, e)
        }
    }

    return (
        <OfflineQrScreen
            ecash={ecash}
            formattedPrimaryAmount={formattedPrimaryAmount}
            formattedSecondaryAmount={formattedSecondaryAmount}
            shareUrl={`${WEB_APP_URL}/link#screen=ecash&id=${ecash}`}
            onCancel={handleCancelEcashNotes}
            onConfirmSent={() => {
                navigation.dispatch(
                    reset('SendSuccess', {
                        amount,
                        unit: 'sats',
                    }),
                )
            }}
        />
    )
}

export default SendOfflineQr
