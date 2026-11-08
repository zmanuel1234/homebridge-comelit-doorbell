import type { Logging } from 'homebridge';
import type { CallHandler } from './call';
import { ChannelType, Channel } from './channels';
import type { IconaBridgeClient } from './client';
import { buildFrame, CAUSE_BUSY, Flag, logicalAddress, Opcode } from './ctp';
import { ctppInitSequence } from './ctpp';
import type { DeviceConfig, Door, OpenResult } from './models';
import { encodeActuatorInit, encodeActuatorOpen } from './protocol';
import type { VipEventListener } from './vipListener';

const CTPP_INIT_TIMEOUT_MS = 5_000;
const ACTUATOR_RESPONSE_TIMEOUT_MS = 2_000;
/** The intercom can take several seconds to answer an open while it is busy. */
const OPEN_REPLY_TIMEOUT_MS = 10_000;

export class DoorOpenError extends Error {}

export interface OpenContext {
  /** Receives the intercom's answer to the open request; without it, the open is not confirmed. */
  listener?: VipEventListener;
  /** Used to answer a ringing call first (`answerMode: answer-on-open`). */
  call?: CallHandler;
  log?: Logging;
}

export async function openDoor(client: IconaBridgeClient, config: DeviceConfig, door: Door, ctx: OpenContext = {}): Promise<OpenResult> {
  const existing = client.getChannel('CTPP');
  const ctpp = existing ?? (await openCtppChannel(client, config));
  try {
    return await openDoorOnChannel(client, ctpp, config, door, ctx);
  } catch (e) {
    throw new DoorOpenError(`Failed to open door '${door.name}': ${(e as Error).message}`);
  } finally {
    if (!existing) {
      client.removeChannel('CTPP_DOOR');
    }
  }
}

async function openCtppChannel(client: IconaBridgeClient, config: DeviceConfig): Promise<Channel> {
  const ourAddr = `${config.aptAddress}${config.aptSubaddress}`;
  try {
    const ctpp = await client.openChannel('CTPP_DOOR', ChannelType.CTPP, ourAddr);
    await ctppInitSequence(client, ctpp, config.aptAddress, config.aptSubaddress, ourAddr, (Date.now() / 1000) | 0, CTPP_INIT_TIMEOUT_MS);
    return ctpp;
  } catch (e) {
    throw new DoorOpenError(`Failed to open CTPP channel: ${(e as Error).message}`);
  }
}

async function openDoorOnChannel(client: IconaBridgeClient, channel: Channel, config: DeviceConfig, door: Door, ctx: OpenContext): Promise<OpenResult> {
  const inCall = await ctx.call?.openInCall(door);
  if (inCall) {
    return inCall;
  }
  if (door.isActuator) {
    return openActuator(client, channel, config.aptAddress, door);
  }
  return openEntrance(client, channel, `${config.aptAddress}${config.aptSubaddress}`, door, ctx.listener);
}

/**
 * OPEN_DOOR (0x002D) on a new connection, sent from our own address (as comelit-vip does),
 * then waits for the intercom's RELEASE: cause 0 means the door opened.
 */
async function openEntrance(client: IconaBridgeClient, channel: Channel, ourAddr: string, door: Door, listener?: VipEventListener): Promise<OpenResult> {
  const conn = Math.floor(Math.random() * 0x7ffe) + 1;
  const conn0 = (conn >> 8) & 0xff;
  const conn1 = conn & 0xff;
  const body = Buffer.concat([Buffer.from([0x00, Opcode.OPEN_DOOR]), logicalAddress(door.aptAddress), Buffer.from([door.outputIndex & 0xff])]);
  const frame = buildFrame({
    flags: Flag.SYN,
    conn0,
    conn1,
    seq: Math.floor(Math.random() * 256),
    ack: Math.floor(Math.random() * 256),
    body,
    source: ourAddr,
    destination: door.aptAddress,
  });
  const reply = listener?.waitForRelease(conn0, conn1, OPEN_REPLY_TIMEOUT_MS);
  try {
    await client.sendBinary(channel, frame);
  } catch (e) {
    reply?.cancel();
    throw e;
  }
  const cause = reply ? await reply.result : null;
  if (cause === null) {
    return { confirmed: false };
  }
  if (cause !== 0) {
    throw new DoorOpenError(`intercom refused (cause ${cause}${cause === CAUSE_BUSY ? ', busy: a call is ringing and was not answered' : ''})`);
  }
  return { confirmed: true };
}

/** Actuators (gates, secondary outputs): the original sequence, not yet tested on a device. */
async function openActuator(client: IconaBridgeClient, channel: Channel, aptAddr: string, door: Door): Promise<OpenResult> {
  await client.sendBinary(channel, encodeActuatorInit(aptAddr, door.outputIndex, door.aptAddress));
  for (let i = 0; i < 2; i++) {
    await client.readResponse(channel, ACTUATOR_RESPONSE_TIMEOUT_MS);
  }
  await client.sendBinary(channel, encodeActuatorOpen(aptAddr, door.outputIndex, door.aptAddress, false));
  await client.sendBinary(channel, encodeActuatorOpen(aptAddr, door.outputIndex, door.aptAddress, true));
  return { confirmed: false };
}
