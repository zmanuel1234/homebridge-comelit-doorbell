import { CHANNEL_TYPE_PUSH, ChannelType, ViperMessageId } from './channels';
import type { IconaBridgeClient } from './client';
import type { DeviceConfig, IntercomEvent } from './models';
import type { JsonMessage } from './protocol';

const BUNDLE_ID = 'com.comelitgroup.friendhome';
const PROFILE_ID = '3';
const DEVICE_TOKEN = 'comelit-local-homebridge-plugin';

/**
 * Keeps the link alive. By default this is a `server-info` request on the INFO channel,
 * like comelit-vip. With `registerPush` the original push registration is used instead,
 * which makes the intercom divert calls away from this connection.
 */
interface KeepaliveKind {
  channel: string;
  type: number;
  message: (config: DeviceConfig) => JsonMessage;
}

function kind(registerPush: boolean): KeepaliveKind {
  if (registerPush) {
    return {
      channel: 'PUSH',
      type: CHANNEL_TYPE_PUSH,
      message: (config) => ({
        'apt-address': config.aptAddress,
        'apt-subaddress': config.aptSubaddress,
        'bundle-id': BUNDLE_ID,
        message: 'push-info',
        'message-id': ViperMessageId.PUSH,
        'os-type': 'ios',
        'profile-id': PROFILE_ID,
        'device-token': DEVICE_TOKEN,
        'message-type': 'request',
      }),
    };
  }
  return {
    channel: 'INFO',
    type: ChannelType.INFO,
    message: () => ({ message: 'server-info', 'message-type': 'request', 'message-id': ViperMessageId.SERVER_INFO }),
  };
}

export async function registerPush(
  client: IconaBridgeClient,
  config: DeviceConfig,
  registerPushDevice: boolean,
  callback: (event: IntercomEvent) => void,
): Promise<void> {
  const k = kind(registerPushDevice);
  const channel = await client.openChannel(k.channel, k.type);
  await client.sendJson(channel, k.message(config));
  client.setPushCallback((raw) => {
    const event = parsePushEvent(raw);
    if (event) {
      callback(event);
    }
  });
}

export async function sendPushKeepalive(client: IconaBridgeClient, config: DeviceConfig, registerPushDevice: boolean): Promise<void> {
  const k = kind(registerPushDevice);
  let channel = client.getChannel(k.channel);
  if (!channel) {
    client.removeChannel(k.channel);
    channel = await client.openChannel(k.channel, k.type);
  }
  await client.sendJson(channel, k.message(config));
}

function parsePushEvent(raw: JsonMessage): IntercomEvent | null {
  const msgType = raw['message'];
  const base = { aptAddress: (raw['apt-address'] as string) ?? '', timestamp: Date.now() / 1000, raw };
  if (msgType === 'incoming-call' || msgType === 'push-incoming-call') {
    return { eventType: 'doorbell_ring', ...base };
  }
  if (msgType === 'missed-call' || msgType === 'push-missed-call') {
    return { eventType: 'missed_call', ...base };
  }
  return null;
}
