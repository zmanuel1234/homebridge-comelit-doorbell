"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthenticationError = void 0;
exports.authenticate = authenticate;
const channels_1 = require("./channels");
class AuthenticationError extends Error {
}
exports.AuthenticationError = AuthenticationError;
async function authenticate(client, token) {
    const channel = await client.openChannel('UAUT', channels_1.ChannelType.UAUT);
    const response = await client.sendJson(channel, {
        message: 'access',
        'user-token': token,
        'message-type': 'request',
        'message-id': channels_1.ViperMessageId.UAUT,
    });
    const code = response['response-code'];
    if (code !== 200) {
        const reason = response['response-string'] ?? 'Unknown error';
        throw new AuthenticationError(`Authentication failed: ${code} ${reason}`);
    }
}
