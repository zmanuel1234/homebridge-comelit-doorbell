"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDeviceConfig = getDeviceConfig;
const client_1 = require("./client");
const channels_1 = require("./channels");
async function getDeviceConfig(client) {
    const channel = await client.openChannel('UCFG', channels_1.ChannelType.UCFG);
    const response = await client.sendJson(channel, {
        message: 'get-configuration',
        addressbooks: 'all',
        'message-type': 'request',
        'message-id': channels_1.ViperMessageId.UCFG,
    });
    const code = response['response-code'];
    if (code !== 200)
        throw new client_1.ProtocolError(`Config request returned code ${code}`);
    return parseConfig(response);
}
function parseConfig(data) {
    const config = {
        aptAddress: '',
        aptSubaddress: 0,
        callerAddress: '',
        doors: [],
        cameras: [],
        raw: data,
    };
    const vip = (data['vip'] ?? {});
    config.aptAddress = vip['apt-address'] ?? '';
    config.aptSubaddress = vip['apt-subaddress'] ?? 0;
    const userParams = (vip['user-parameters'] ?? {});
    const entranceBook = userParams['entrance-address-book'] ?? [];
    if (entranceBook.length > 0) {
        config.callerAddress = entranceBook[0]['apt-address'] ?? '';
    }
    let doorIndex = 0;
    const doorBook = userParams['opendoor-address-book'] ?? [];
    for (const item of doorBook) {
        const d = item;
        config.doors.push({
            id: d['id'] ?? doorIndex,
            index: doorIndex,
            name: d['name'] ?? '',
            aptAddress: d['apt-address'] ?? '',
            outputIndex: d['output-index'] ?? 0,
            secureMode: d['secure-mode'] ?? false,
            isActuator: false,
            moduleIndex: 0,
        });
        doorIndex++;
    }
    const actuatorBook = userParams['actuator-address-book'] ?? [];
    for (const item of actuatorBook) {
        const d = item;
        config.doors.push({
            id: d['id'] ?? doorIndex,
            index: doorIndex,
            name: d['name'] ?? '',
            aptAddress: d['apt-address'] ?? '',
            outputIndex: d['output-index'] ?? 0,
            secureMode: d['secure-mode'] ?? false,
            isActuator: true,
            moduleIndex: d['module-index'] ?? 0,
        });
        doorIndex++;
    }
    const cameraBook = userParams['rtsp-camera-address-book'] ?? [];
    for (const item of cameraBook) {
        const c = item;
        config.cameras.push({
            id: c['id'] ?? 0,
            name: c['name'] ?? '',
            rtspUrl: c['rtsp-url'] ?? '',
            rtspUser: c['rtsp-user'] ?? '',
            rtspPassword: c['rtsp-password'] ?? '',
        });
    }
    return config;
}
