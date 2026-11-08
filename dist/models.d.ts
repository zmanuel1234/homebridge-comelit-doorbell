export interface Door {
    id: number;
    index: number;
    name: string;
    aptAddress: string;
    outputIndex: number;
    secureMode: boolean;
    isActuator: boolean;
    moduleIndex: number;
}
export interface Camera {
    id: number;
    name: string;
    rtspUrl: string;
    rtspUser: string;
    rtspPassword: string;
}
export interface DeviceConfig {
    aptAddress: string;
    aptSubaddress: number;
    callerAddress: string;
    doors: Door[];
    cameras: Camera[];
    raw?: Record<string, unknown>;
}
export interface PushEvent {
    eventType: string;
    aptAddress: string;
    timestamp: number;
    raw?: Record<string, unknown>;
}
//# sourceMappingURL=models.d.ts.map