import { screen } from '@testing-library/react-native'

import stringUtils from '@fedi/common/utils/StringUtils'
import { renderWithProviders } from '@fedi/native/tests/utils/render'

import ReceiveQr from '../../../../../components/feature/receive/ReceiveQr'

// Swap the real QR renderer (SVG generation) for a stub that surfaces the
// `value` prop it was given, so the test can assert what actually gets
// encoded in the on-screen QR without rendering real SVG output.
jest.mock('../../../../../components/ui/QRCode', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Text } = require('react-native')
    return {
        __esModule: true,
        default: ({ value }: { value: string }) =>
            React.createElement(Text, { testID: 'qr-value' }, value),
    }
})

describe('components/feature/receive/ReceiveQr', () => {
    const bareAddress = '0x000000000000000000000000000000000000ab'
    const requestUri = `ethereum:${bareAddress}?amount=1.5`

    it('encodes uri.body in the on-screen QR when qrValue is not provided', () => {
        renderWithProviders(
            <ReceiveQr uri={{ fullString: bareAddress, body: bareAddress }} />,
        )

        expect(screen.getByTestId('qr-value')).toHaveTextContent(bareAddress)
    })

    it('encodes qrValue in the on-screen QR when provided, independent of uri.body', () => {
        renderWithProviders(
            <ReceiveQr
                uri={{ fullString: requestUri, body: bareAddress }}
                qrValue={requestUri}
            />,
        )

        expect(screen.getByTestId('qr-value')).toHaveTextContent(requestUri)
    })

    it('always shows the bare uri.body as the truncated caption, even when the QR carries a request URI', () => {
        renderWithProviders(
            <ReceiveQr
                uri={{ fullString: requestUri, body: bareAddress }}
                qrValue={requestUri}
            />,
        )

        // uri.body still drives the truncated address caption below the QR,
        // regardless of what the QR itself encodes.
        expect(
            screen.getByText(
                stringUtils.truncateMiddleOfString(bareAddress, 6),
            ),
        ).toBeOnTheScreen()
    })
})
