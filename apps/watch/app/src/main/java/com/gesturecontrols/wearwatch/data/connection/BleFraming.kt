package com.gesturecontrols.wearwatch.data.connection

/**
 * BLE fragmentation for protocol envelopes, byte-compatible with the desktop's
 * `crates/watch-bridge/src/ble.rs`. A GATT notification or write carries at
 * most `MTU - 3` bytes, which is 20 with the default 23-byte MTU — far smaller
 * than a PPG batch — so every envelope is split across fragments:
 *
 * ```
 * [flags: u8][fragment index: u16 big-endian][chunk…]
 * ```
 *
 * `flags` bit 0 marks the final fragment. Indexes must arrive in order; any gap
 * or reorder drops the partial buffer rather than deliver a truncated envelope.
 */
object BleFraming {
    const val HEADER_LENGTH = 3
    private const val FLAG_FINAL: Int = 0x01

    /**
     * Ceiling on one reassembled envelope, mirroring `MAX_BLE_MESSAGE_BYTES` on
     * the desktop. The largest real message is a 32-sample batch (a few KB);
     * past this the peer is desynced or hostile and the message is dropped.
     */
    const val MAX_MESSAGE_BYTES = 16 * 1024

    /** Usable ATT payload at the default 23-byte MTU. */
    const val MIN_ATT_PAYLOAD = 20

    /** ATT opcode + handle overhead deducted from the negotiated MTU. */
    const val ATT_OVERHEAD = 3

    /** Usable payload for one notification/write at [mtu]. */
    fun attPayloadFor(mtu: Int): Int = (mtu - ATT_OVERHEAD).coerceAtLeast(MIN_ATT_PAYLOAD)

    /**
     * Splits [message] into fragments of at most [maxAttPayload] bytes each.
     * Returns null if the envelope exceeds [MAX_MESSAGE_BYTES] — refusing to
     * send is correct; the desktop would drop it on reassembly anyway.
     */
    fun fragment(message: ByteArray, maxAttPayload: Int): List<ByteArray>? {
        if (message.size > MAX_MESSAGE_BYTES) return null
        val chunkLength = (maxAttPayload - HEADER_LENGTH).coerceAtLeast(1)
        // An empty envelope still needs one terminated fragment.
        val chunkCount = if (message.isEmpty()) 1 else (message.size + chunkLength - 1) / chunkLength
        val fragments = ArrayList<ByteArray>(chunkCount)
        for (index in 0 until chunkCount) {
            val start = index * chunkLength
            val end = minOf(start + chunkLength, message.size)
            val size = end - start
            val frame = ByteArray(HEADER_LENGTH + size)
            frame[0] = (if (index == chunkCount - 1) FLAG_FINAL else 0).toByte()
            frame[1] = ((index shr 8) and 0xFF).toByte()
            frame[2] = (index and 0xFF).toByte()
            message.copyInto(frame, HEADER_LENGTH, start, end)
            fragments.add(frame)
        }
        return fragments
    }

    /** Rebuilds envelopes from [fragment]'s output. Not thread-safe; owned by one link. */
    class Reassembler {
        private var buffer = ByteArrayOutput()
        private var nextIndex = 0

        /** Last framing violation seen, for diagnostics; cleared by [push] on success. */
        var lastError: String? = null
            private set

        /** Feeds one received ATT payload; non-null is a complete envelope. */
        fun push(frame: ByteArray): ByteArray? {
            if (frame.size < HEADER_LENGTH) {
                reset("fragment shorter than header")
                return null
            }
            val flags = frame[0].toInt()
            val index = ((frame[1].toInt() and 0xFF) shl 8) or (frame[2].toInt() and 0xFF)
            if (index != nextIndex) {
                val expected = nextIndex
                reset("fragment $index arrived while expecting $expected")
                // A peer that gave up mid-message restarts at 0; take that
                // rather than stall until the link drops.
                if (index != 0) return null
            }
            if (buffer.size + frame.size - HEADER_LENGTH > MAX_MESSAGE_BYTES) {
                reset("message exceeds $MAX_MESSAGE_BYTES bytes")
                return null
            }
            buffer.write(frame, HEADER_LENGTH, frame.size - HEADER_LENGTH)
            if (flags and FLAG_FINAL != 0) {
                val message = buffer.toByteArray()
                buffer = ByteArrayOutput()
                nextIndex = 0
                lastError = null
                return message
            }
            nextIndex += 1
            return null
        }

        /** Drops any partial message; call on disconnect so a stale half-envelope can't be completed by the next peer. */
        fun clear() {
            buffer = ByteArrayOutput()
            nextIndex = 0
            lastError = null
        }

        private fun reset(reason: String) {
            buffer = ByteArrayOutput()
            nextIndex = 0
            lastError = reason
        }
    }

    /** Minimal growable byte sink; avoids pulling java.io into the hot path. */
    private class ByteArrayOutput {
        private var bytes = ByteArray(256)
        var size = 0
            private set

        fun write(source: ByteArray, offset: Int, length: Int) {
            if (size + length > bytes.size) {
                var capacity = bytes.size
                while (capacity < size + length) capacity *= 2
                bytes = bytes.copyOf(capacity)
            }
            source.copyInto(bytes, size, offset, offset + length)
            size += length
        }

        fun toByteArray(): ByteArray = bytes.copyOf(size)
    }
}
