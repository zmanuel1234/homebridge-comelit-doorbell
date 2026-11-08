/**
 * Wire protocol encoding/decoding for the ICONA Bridge TCP protocol.
 * Faithful TypeScript translation of the Python protocol.py.
 *
 * Header format (8 bytes):
 *   [0x00 0x06] [body_len LE16] [request_id LE16] [0x00 0x00]
 */
export declare const HEADER_SIZE = 8;
export declare const HEADER_MAGIC: Buffer<ArrayBuffer>;
export declare const enum MessageType {
    COMMAND = 43981,
    END = 495,
    OPEN_DOOR_INIT = 6336,
    OPEN_DOOR = 6144,
    OPEN_DOOR_CONFIRM = 6176
}
export declare const ACTION_CALL_INIT = 40;
export declare const ACTION_CODEC_NEG = 8;
export declare const ACTION_RTPC_LINK = 10;
export declare const ACTION_VIDEO_CONFIG = 26;
export declare const ACTION_PEER = 112;
export declare const ACTION_CONFIG_ACK = 14;
export declare const ACTION_HANGUP = 45;
export declare const ACTION_DOOR_OPEN = 13;
export declare function encodeHeader(bodyLength: number, requestId?: number): Buffer;
export declare function decodeHeader(data: Buffer): {
    bodyLength: number;
    requestId: number;
};
export declare function encodeJsonMessage(msg: Record<string, unknown>, requestId: number): Buffer;
export declare function decodeJsonBody(body: Buffer): Record<string, unknown>;
export declare function isJsonBody(body: Buffer): boolean;
export declare function encodeChannelOpen(channelName: string, channelTypeId: number, sequence: number, requestId: number, extraData?: string, trailingByte?: number): Buffer;
export declare function encodeChannelOpenResponse(requestId: number): Buffer;
export declare function encodeChannelClose(sequence: number, serverChannelId?: number): Buffer;
export declare function parseCommandResponse(body: Buffer): {
    msgType: number;
    seq: number;
    serverChannelId: number;
};
export declare function encodeCttpInit(aptAddress: string, aptSubaddress: number, timestamp?: number): Buffer;
export declare function encodeOpenDoor(msgType: number, aptAddress: string, outputIndex: number, doorAptAddress: string): Buffer;
export declare function encodeDoorInit(aptAddress: string, outputIndex: number, doorAptAddress: string): Buffer;
export declare function encodeActuatorInit(aptAddress: string, outputIndex: number, actuatorAptAddress: string): Buffer;
export declare function encodeActuatorOpen(aptAddress: string, outputIndex: number, actuatorAptAddress: string, confirm?: boolean): Buffer;
export declare function encodeCallInit(caller: string, callee: string, timestamp: number): Buffer;
export declare function encodeCallAck(caller: string, callee: string, timestamp: number): Buffer;
export declare function encodeRtpcLink(caller: string, callee: string, rtpcReqId: number, timestamp: number, refresh?: boolean): Buffer;
export declare function encodeVideoConfig(caller: string, callee: string, rtpc2ReqId: number, timestamp: number, width?: number, height?: number, fps?: number): Buffer;
export declare function encodeCallResponseAck(caller: string, callee: string, timestamp: number, prefix?: number): Buffer;
export declare function encodeHangup(caller: string, entranceAddr: string, timestamp: number): Buffer;
export declare function encodeDoorOpenDuringVideo(ourAddr: string, entranceAddr: string, callCounter: number, relayIndex: number): Buffer;
export interface RtpHeader {
    version: number;
    padding: boolean;
    extension: boolean;
    csrcCount: number;
    marker: boolean;
    payloadType: number;
    sequence: number;
    timestamp: number;
    ssrc: number;
}
export declare function decodeRtpHeader(data: Buffer): {
    header: RtpHeader;
    payload: Buffer;
};
//# sourceMappingURL=protocol.d.ts.map