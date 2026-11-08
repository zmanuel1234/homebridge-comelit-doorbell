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
    const channel = await client.openChannel(zmanChName(), zmanChType());
    await client.sendJson(channel, zmanMsg(config));
    client.setPushCallback((raw) => {
        const event = parsePushEvent(raw);
        if (event)
            callback(event);
    });
}
async function sendPushKeepalive(client, config) {
    let channel = client.getChannel(zmanChName());
    if (!channel) {
        client.removeChannel(zmanChName());
        channel = await client.openChannel(zmanChName(), zmanChType());
    }
    await client.sendJson(channel, zmanMsg(config));
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
// zman: settings - registerPush=true restores the original push registration
function zmanChName() { return global.__zmanRegisterPush ? 'PUSH' : 'INFO'; }
function zmanChType() { return global.__zmanRegisterPush ? channels_1.ChannelType.PUSH : channels_1.ChannelType.INFO; }
function zmanMsg(config) { return global.__zmanRegisterPush ? buildPushMsg(config) : zmanInfoMsg(); }
