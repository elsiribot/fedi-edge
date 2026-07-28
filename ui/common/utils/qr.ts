/**
 * @file
 * Encoding helpers for animated (qrloop) ecash QR codes.
 *
 * An animated ecash QR frames the token's *bytes* with qrloop's `dataToFrames`
 * and the scanner reassembles those bytes and recovers a string with
 * `decodeEcashFromBuffer` below. The two must be an exact inverse pair for every
 * token type we generate:
 *
 *  - v1 BTC `OOBNotes` are genuine base64 text. Framing their base64-*decoded*
 *    bytes is compact and lossless, because the scanner classifies the random
 *    bytes as `binary` and re-encodes them to the identical canonical base64
 *    string. (This is the historical behaviour and stays byte-for-byte the same.)
 *  - v2 USDT tokens are `"fedimint" + base32hex(...)` ASCII text, NOT base64.
 *    Base64-decoding them and re-encoding only reproduces the original when the
 *    length happens to be a multiple of 4, so ~3/4 of tokens are corrupted. We
 *    instead frame their own utf8 bytes; the scanner classifies printable ASCII
 *    as `utf8` and returns the exact original string for ANY length.
 *
 * Keep {@link encodeEcashToBuffer} and {@link decodeEcashFromBuffer} in lockstep.
 */
import { getBufferEncoding } from './istextorbinary'

/**
 * Prefix of a v2 (`fedimint…`) ecash token — see `FEDIMINT_PREFIX` in
 * fedimint-core `base32.rs`. Present iff the token is base32hex text rather than
 * base64.
 */
export const FEDIMINT_ECASH_PREFIX = 'fedimint'

/**
 * Choose the byte representation of an ecash token to hand to qrloop's
 * `dataToFrames`.
 *
 * v2 `fedimint…` tokens are framed as their own utf8 bytes (lossless for any
 * length); genuine v1 base64 tokens keep their compact base64-decoded bytes.
 */
export function encodeEcashToBuffer(ecash: string): Buffer {
    if (ecash.startsWith(FEDIMINT_ECASH_PREFIX)) {
        return Buffer.from(ecash, 'utf8')
    }
    return Buffer.from(ecash, 'base64')
}

/**
 * Recover the original ecash string from the bytes reassembled by qrloop's
 * `framesToData`. Mirrors the scanner's historical logic exactly: binary-looking
 * payloads (v1 base64 bytes) are re-encoded as base64; text payloads (v2 utf8
 * bytes) are decoded as utf8.
 */
export function decodeEcashFromBuffer(frameData: Buffer): string {
    return frameData.toString(
        getBufferEncoding(frameData) === 'binary' ? 'base64' : 'utf8',
    )
}
