import { ChannelType, ViperMessageId } from './channels.js';
import type { IconaBridgeClient } from './client.js';

export class AuthenticationError extends Error {}

export async function authenticate(client: IconaBridgeClient, token: string): Promise<void> {
  const channel = await client.openChannel('UAUT', ChannelType.UAUT);
  const response = await client.sendJson(channel, {
    message: 'access',
    'user-token': token,
    'message-type': 'request',
    'message-id': ViperMessageId.UAUT,
  });
  const code = response['response-code'];
  if (code !== 200) {
    const reason = (response['response-string'] as string | undefined) ?? 'Unknown error';
    throw new AuthenticationError(`Authentication failed: ${String(code)} ${reason}`);
  }
}
