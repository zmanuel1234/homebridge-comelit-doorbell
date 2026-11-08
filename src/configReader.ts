import { ChannelType, ViperMessageId } from './channels';
import { IconaBridgeClient, ProtocolError } from './client';
import type { DeviceConfig, Door } from './models';
import type { JsonMessage } from './protocol';

type Obj = Record<string, unknown>;

export async function getDeviceConfig(client: IconaBridgeClient): Promise<DeviceConfig> {
  const channel = await client.openChannel('UCFG', ChannelType.UCFG);
  const response = await client.sendJson(channel, {
    message: 'get-configuration',
    addressbooks: 'all',
    'message-type': 'request',
    'message-id': ViperMessageId.UCFG,
  });
  const code = response['response-code'];
  if (code !== 200) {
    throw new ProtocolError(`Config request returned code ${String(code)}`);
  }
  return parseConfig(response);
}

function list(v: unknown): Obj[] {
  return Array.isArray(v) ? (v as Obj[]) : [];
}

export function parseConfig(data: JsonMessage): DeviceConfig {
  const vip = (data['vip'] ?? {}) as Obj;
  const userParams = (vip['user-parameters'] ?? {}) as Obj;
  const config: DeviceConfig = {
    aptAddress: (vip['apt-address'] as string) ?? '',
    aptSubaddress: (vip['apt-subaddress'] as number) ?? 0,
    callerAddress: '',
    doors: [],
    cameras: [],
    raw: data,
  };
  const entrances = list(userParams['entrance-address-book']);
  if (entrances.length > 0) {
    config.callerAddress = (entrances[0]['apt-address'] as string) ?? '';
  }
  const door = (d: Obj, index: number, isActuator: boolean): Door => ({
    id: (d['id'] as number) ?? index,
    index,
    name: (d['name'] as string) ?? '',
    aptAddress: (d['apt-address'] as string) ?? '',
    outputIndex: (d['output-index'] as number) ?? 0,
    secureMode: (d['secure-mode'] as boolean) ?? false,
    isActuator,
    moduleIndex: isActuator ? ((d['module-index'] as number) ?? 0) : 0,
  });
  for (const d of list(userParams['opendoor-address-book'])) {
    config.doors.push(door(d, config.doors.length, false));
  }
  for (const d of list(userParams['actuator-address-book'])) {
    config.doors.push(door(d, config.doors.length, true));
  }
  for (const c of list(userParams['rtsp-camera-address-book'])) {
    config.cameras.push({
      id: (c['id'] as number) ?? 0,
      name: (c['name'] as string) ?? '',
      rtspUrl: (c['rtsp-url'] as string) ?? '',
      rtspUser: (c['rtsp-user'] as string) ?? '',
      rtspPassword: (c['rtsp-password'] as string) ?? '',
    });
  }
  return config;
}
