import type { Logging } from 'homebridge';
import type { Channel } from './channels';
import type { IconaBridgeClient } from './client';
import { ackWord } from './ctp';
import { encodeCallResponseAck, encodeCtppInit } from './protocol';

const PREFIX_VIP_EVENT = 0x1860;
/** A new call from the intercom (a ring's INVITE starts with this). */
const PREFIX_CALL_INIT = 0x18c0;
/** Reads at most this many messages while waiting for the two answers. */
const MAX_INIT_READS = 4;

/**
 * Registers on the CTPP channel and reads the intercom's first two answers.
 *
 * No ACK pair is sent right after the registration: on this device it is taken as a
 * hang-up on an idle channel and the connection is closed. The listener acknowledges
 * later messages instead.
 *
 * A ring that arrives while waiting is not one of the answers: it is put back on the channel's
 * queue, so the listener sees it.
 */
export async function ctppInitSequence(
  client: IconaBridgeClient,
  channel: Channel,
  aptAddr: string,
  aptSub: number,
  ourAddr: string,
  timestamp: number,
  responseTimeoutMs = 5_000,
  log?: Logging,
): Promise<void> {
  log?.debug(`CTPP init: sending init ts=0x${timestamp.toString(16)} addr=${ourAddr}`);
  await client.sendBinary(channel, encodeCtppInit(aptAddr, aptSub, timestamp));
  // The device usually answers with an ACK and a first renewal (0x1860). Acknowledging
  // that renewal right away keeps the connection from being dropped before the listener
  // starts.
  const calls: Buffer[] = [];
  let answers = 0;
  for (let i = 0, reads = 0; i < 2 && reads < MAX_INIT_READS; i++, reads++) {
    const resp = await client.readResponse(channel, responseTimeoutMs);
    if (!resp || resp.length < 8) {
      log?.debug(`CTPP init response ${i + 1}: timeout (no data)`);
      continue;
    }
    answers++;
    const prefix = resp.readUInt16LE(0);
    if (prefix === PREFIX_CALL_INIT) {
      log?.debug('CTPP init: a call arrived during the registration; keeping it for the listener');
      calls.push(resp);
      i--;
      continue;
    }
    log?.debug(`CTPP init response ${i + 1}: ${resp.length} bytes prefix=0x${prefix.toString(16).padStart(4, '0')}`);
    if (prefix === PREFIX_VIP_EVENT) {
      const ack = ackWord(resp.readUInt32LE(2));
      log?.debug(`CTPP init: sending fast renewal ACK ts=0x${ack.toString(16)}`);
      try {
        await client.sendBinary(channel, encodeCallResponseAck(ourAddr, aptAddr, ack));
        await client.sendBinary(channel, encodeCallResponseAck(ourAddr, aptAddr, ack, 0x1820));
      } catch {
        log?.warn('CTPP init: fast renewal ACK failed (connection closing)');
      }
    }
  }
  if (answers === 0 && calls.length === 0) {
    // At normal level, also when the connection's steps aren't logged (a planned reconnect):
    // without an answer, rings may not come.
    log?.warn('CTPP init: the intercom did not answer the registration; rings may not reach HomeKit until the next refresh');
  }
  for (const c of calls) {
    channel.responseQueue.enqueue(c);
  }
}
