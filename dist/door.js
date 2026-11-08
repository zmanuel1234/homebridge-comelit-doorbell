"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DoorOpenError = void 0;
exports.openDoor = openDoor;
exports.openCtppChannel = openCtppChannel;
const channels_1 = require("./channels");
const ctpp_1 = require("./ctpp");
const protocol_1 = require("./protocol");
const DOOR_CTPP_INIT_TIMEOUT_MS = 5_000;
const DOOR_RESPONSE_TIMEOUT_MS = 2_000;
class DoorOpenError extends Error {
}
exports.DoorOpenError = DoorOpenError;
async function openDoor(client, config, door) {
    const existingCtpp = client.getChannel('CTPP');
    const openedChannel = existingCtpp === undefined;
    let ctpp;
    if (existingCtpp) {
        ctpp = existingCtpp;
    }
    else {
        ctpp = await openCtppChannel(client, config);
    }
    try {
        await openDoorOnChannel(client, ctpp, config.aptAddress, door);
    }
    catch (e) {
        throw new DoorOpenError(`Failed to open door '${door.name}': ${e.message}`);
    }
    finally {
        if (openedChannel) {
            client.removeChannel('CTPP_DOOR');
        }
    }
}
async function openCtppChannel(client, config) {
    const aptAddr = config.aptAddress;
    const aptSub = config.aptSubaddress;
    const ourAddr = `${aptAddr}${aptSub}`;
    try {
        const ctpp = await client.openChannel('CTPP_DOOR', channels_1.ChannelType.CTPP, ourAddr);
        const ts = Date.now() / 1000 | 0;
        await (0, ctpp_1.ctppInitSequence)(client, ctpp, aptAddr, aptSub, ourAddr, ts, DOOR_CTPP_INIT_TIMEOUT_MS, false);
        return ctpp;
    }
    catch (e) {
        throw new DoorOpenError(`Failed to open CTPP channel: ${e.message}`);
    }
}
async function openDoorOnChannel(client, channel, aptAddr, door) {
    // Phase B: Open + Confirm (regular doors only)
    if (!door.isActuator) {
        await sendOpenAndConfirm(client, channel, aptAddr, door);
    }
    // Phase C: Door-specific init
    const initMsg = door.isActuator
        ? (0, protocol_1.encodeActuatorInit)(aptAddr, door.outputIndex, door.aptAddress)
        : (0, protocol_1.encodeDoorInit)(aptAddr, door.outputIndex, door.aptAddress);
    await client.sendBinary(channel, initMsg);
    for (let i = 0; i < 2; i++) {
        await client.readResponse(channel, DOOR_RESPONSE_TIMEOUT_MS);
    }
    // Phase D: Open + Confirm again
    if (!door.isActuator) {
        await sendOpenAndConfirm(client, channel, aptAddr, door);
    }
    else {
        await client.sendBinary(channel, (0, protocol_1.encodeActuatorOpen)(aptAddr, door.outputIndex, door.aptAddress, false));
        await client.sendBinary(channel, (0, protocol_1.encodeActuatorOpen)(aptAddr, door.outputIndex, door.aptAddress, true));
    }
}
async function sendOpenAndConfirm(client, channel, aptAddr, door) {
    await client.sendBinary(channel, (0, protocol_1.encodeOpenDoor)(6144 /* MessageType.OPEN_DOOR */, aptAddr, door.outputIndex, door.aptAddress));
    await client.sendBinary(channel, (0, protocol_1.encodeOpenDoor)(6176 /* MessageType.OPEN_DOOR_CONFIRM */, aptAddr, door.outputIndex, door.aptAddress));
}
