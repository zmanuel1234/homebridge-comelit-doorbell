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

export type IntercomEventType = 'doorbell_ring' | 'missed_call' | 'door_opened';

export interface IntercomEvent {
  eventType: IntercomEventType;
  aptAddress: string;
  timestamp: number;
  raw?: Record<string, unknown>;
}

/** Outcome of a door-open request. `confirmed` is false when the intercom didn't answer in time. */
export interface OpenResult {
  confirmed: boolean;
}
