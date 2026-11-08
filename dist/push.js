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
    // zman: no push - comelit-vip never registers for push; keep the link alive with server-info instead
    const channel = await client.openChannel('INFO', channels_1.ChannelType.INFO);
    await client.sendJson(channel, zmanInfoMsg());
    client.setPushCallback((raw) => {
        const event = parsePushEvent(raw);
        if (event)
            callback(event);
    });
}
async function sendPushKeepalive(client, config) {
    let channel = client.getChannel('INFO');
    if (!channel) {
        client.removeChannel('INFO');
        channel = await client.openChannel('INFO', channels_1.ChannelType.INFO);
    }
    await client.sendJson(channel, zmanInfoMsg());
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

function zmanInfoMsg() { return { message: 'server-info', 'message-type': 'request', 'message-id': channels_1.ViperMessageId.SERVER_INFO }; } // zman: no push
