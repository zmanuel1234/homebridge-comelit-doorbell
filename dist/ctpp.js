"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CTR_INCR_BOTH = void 0;
exports.ctppInitSequence = ctppInitSequence;
exports.readResponseCtpp = readResponseCtpp;
const protocol_1 = require("./protocol");
exports.CTR_INCR_BOTH = 0x01010000;
const CTPP_RESPONSE_MIN_LEN = 8;
const PREFIX_VIP_EVENT = 0x1860;
const ACK_TS_INCREMENT = 0x01000000;
function zmanAckTs(t) { const c0 = (t & 0xff) ^ 0x80, c1 = (t >>> 8) & 0xff, s = (t >>> 16) & 0xff, a = (t >>> 24) & 0xff; return (c0 | (c1 << 8) | (a << 16) | (((s + 1) & 0xff) << 24)) >>> 0; } // zman: proper CTP ack
async function ctppInitSequence(client, channel, aptAddr, aptSub, ourAddr, timestamp, responseTimeoutMs = 5_000, sendAck = true, log) {
    log?.debug(`CTPP init: sending init ts=0x${timestamp.toString(16)} addr=${ourAddr}`);
    await client.sendBinary(channel, (0, protocol_1.encodeCttpInit)(aptAddr, aptSub, timestamp));
    await readResponseCtpp(client, channel, responseTimeoutMs, log, { aptAddr, ourAddr });
    if (sendAck) {
        const ackTs = (timestamp + exports.CTR_INCR_BOTH) >>> 0;
        log?.debug(`CTPP init: sending ACK pair ackTs=0x${ackTs.toString(16)} caller=${ourAddr} callee=${aptAddr}`);
        await client.sendBinary(channel, (0, protocol_1.encodeCallResponseAck)(ourAddr, aptAddr, ackTs));
        await client.sendBinary(channel, (0, protocol_1.encodeCallResponseAck)(ourAddr, aptAddr, ackTs, 0x1820));
        log?.debug('CTPP init: ACK pair sent');
    }
}
async function readResponseCtpp(client, channel, responseTimeoutMs = 5_000, log, ackConfig) {
    // Read up to two responses from the device after the CTPP init. The device
    // typically sends [0x1800 init ACK][0x1860 initial-burst renewal] in quick
    // succession. If a renewal (0x1860) is seen here we ACK it immediately — this
    // gets the ACK out within a few ms while the device's acceptance window is still
    // open, giving the connection the best chance of surviving into periodic-renewal
    // mode. Without the fast ACK the device sends EOF before the VIP listener can
    // respond. If the device sends fewer than two responses the extras time out.
    for (let i = 0; i < 2; i++) {
        const resp = await client.readResponse(channel, responseTimeoutMs);
        if (resp && resp.length >= CTPP_RESPONSE_MIN_LEN) {
            const prefix = resp.readUInt16LE(0);
            log?.debug(`CTPP init response ${i + 1}: ${resp.length} bytes prefix=0x${prefix.toString(16).padStart(4, '0')}`);
            if (prefix === PREFIX_VIP_EVENT && ackConfig) {
                const { aptAddr, ourAddr } = ackConfig;
                const msgTs = resp.readUInt32LE(2);
                const ackTs = zmanAckTs(msgTs);
                log?.debug(`CTPP init: sending fast renewal ACK ts=0x${ackTs.toString(16)}`);
                try {
                    await client.sendBinary(channel, (0, protocol_1.encodeCallResponseAck)(ourAddr, aptAddr, ackTs));
                    await client.sendBinary(channel, (0, protocol_1.encodeCallResponseAck)(ourAddr, aptAddr, ackTs, 0x1820));
                }
                catch {
                    log?.warn('CTPP init: fast renewal ACK failed (connection closing)');
                }
            }
        }
        else {
            log?.debug(`CTPP init response ${i + 1}: timeout (no data)`);
        }
    }
}
