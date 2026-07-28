import {
    areFramesComplete,
    dataToFrames,
    framesToData,
    parseFramesReducer,
} from 'qrloop'

import {
    decodeEcashFromBuffer,
    encodeEcashToBuffer,
} from '../../../utils/qr'

/**
 * Full animated-QR round-trip through the REAL qrloop framing plus the REAL
 * scanner recovery (`framesToData` + `decodeEcashFromBuffer`). This is the exact
 * path an animated ecash QR takes from the sender's screen to the scanner, so a
 * MATCH here proves the on-device scan reproduces the token intact.
 */
function roundTrip(ecash: string): { frames: number; out: string } {
    const frames = dataToFrames(encodeEcashToBuffer(ecash))
    let state = null
    for (const frame of frames) {
        state = parseFramesReducer(state, frame)
    }
    if (!state || !areFramesComplete(state)) {
        throw new Error('frames did not reassemble')
    }
    return { frames: frames.length, out: decodeEcashFromBuffer(framesToData(state)) }
}

// A genuine base64 token (v1 BTC OOBNotes are base64 text). Deterministic bytes
// that include low control bytes so the scanner classifies them as `binary`.
function makeBase64Token(byteLength: number): string {
    const bytes = Buffer.alloc(byteLength)
    for (let i = 0; i < byteLength; i++) bytes[i] = (i * 7 + 3) % 256
    return bytes.toString('base64')
}

// A v2 (`fedimint…`) token of an exact total length. Body is RFC4648 base32hex
// (0-9a-v), matching fedimint-core `encode_prefixed(FEDIMINT_PREFIX, …)`.
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv'
function makeFedimintToken(totalLength: number): string {
    let token = 'fedimint'
    let i = 0
    while (token.length < totalLength) {
        token += BASE32HEX[(i * 13 + 5) % BASE32HEX.length]
        i++
    }
    return token
}

// Pick the smallest length >= min with the requested length % 4.
function lengthWithResidue(min: number, residue: number): number {
    return min + ((4 + residue - (min % 4)) % 4)
}

describe('animated ecash QR round-trip', () => {
    describe('v1 base64 tokens (BTC OOBNotes)', () => {
        it('round-trips a single-frame token', () => {
            const token = makeBase64Token(60)
            const { frames, out } = roundTrip(token)
            expect(frames).toBe(1)
            expect(out).toBe(token)
        })

        it('round-trips a multi-frame token', () => {
            const token = makeBase64Token(1800)
            const { frames, out } = roundTrip(token)
            expect(frames).toBeGreaterThan(1)
            expect(out).toBe(token)
        })
    })

    describe('v2 fedimint tokens (USDT) survive every length alignment', () => {
        for (const residue of [1, 2, 3, 0]) {
            it(`round-trips a single-frame token with length % 4 == ${residue}`, () => {
                const token = makeFedimintToken(lengthWithResidue(60, residue))
                expect(token.length % 4).toBe(residue)
                const { frames, out } = roundTrip(token)
                expect(frames).toBe(1)
                expect(out).toBe(token)
            })

            it(`round-trips a multi-frame token with length % 4 == ${residue}`, () => {
                const token = makeFedimintToken(lengthWithResidue(600, residue))
                expect(token.length % 4).toBe(residue)
                const { frames, out } = roundTrip(token)
                expect(frames).toBeGreaterThan(1)
                expect(out).toBe(token)
            })
        }
    })
})
