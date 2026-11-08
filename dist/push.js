"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPush = registerPush;
exports.sendPushKeepalive = sendPushKeepalive;
const channels_1 = require("./channels");
const BUNDLE_ID = 'com.comelitgroup.friendhome';
const PROFILE_ID = '3';
const DEVICE_TOKEN = 'comelit-local-homebridge-plugin';
function buildPushMsg(config) {
    return {
        'apt-address': config.aptAddress,
        'apt-subaddress': config.aptSubaddress,
        'bundle-id': BUNDLE_ID,
        message: 'push-info',
        'message-id': channels_1.ViperMessageId.PUSH,
        'os-type': 'ios',
        'profile-id': PROFILE_ID,
        'device-token': DEVICE_TOKEN,
        'message-type': 'request',
    };
}
async function registerPush(client, config, callback) {
    const channel = await client.openChannel('PUSH', channels_1.ChannelType.PUSH);
    await client.sendJson(channel, buildPushMsg(config));
    client.setPushCallback((raw) => {
        const event = parsePushEvent(raw);
        if (event)
            callback(event);
    });
}
async function sendPushKeepalive(client, config) {
    const channel = client.getChannel('PUSH');
    if (!channel)
        throw new Error('PUSH channel not open');
    await client.sendJson(channel, buildPushMsg(config));
}
function parsePushEvent(raw) {
    const msgType = raw['message'];
    if (msgType === 'incoming-call' || msgType === 'push-incoming-call') {
        return {
            eventType: 'doorbell_ring',
            aptAddress: raw['apt-address'] ?? '',
            timestamp: Date.now() / 1000,
            raw,
        };
    }
    if (msgType === 'missed-call' || msgType === 'push-missed-call') {
        return {
            eventType: 'missed_call',
            aptAddress: raw['apt-address'] ?? '',
            timestamp: Date.now() / 1000,
            raw,
        };
    }
    return null;
}
