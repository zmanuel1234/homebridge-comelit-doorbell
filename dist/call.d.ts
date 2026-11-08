/**
 * Experimental: taking part in an incoming call (a ring).
 *
 * While a ring is unanswered, the intercom refuses a door release from anyone who didn't
 * answer it (RELEASE cause 8, busy). The Comelit app answers first and then opens inside
 * the call. This module mirrors that, guided by the outgoing-call setup known from
 * comelit-vip:
 *
 *   intercom → INVITE (SYN)         we → echo the INVITE
 *   intercom → CAPABILITIES         we → our CAPABILITIES   ("handshake": stop here)
 *   we → SETUP_ACK (answer), OPEN_DOOR inside the call, RELEASE (hang up)
 *
 * Every frame of a call is logged with the prefix `call:`.
 */
import type { Logging } from 'homebridge';
import { CtpFrame } from './ctp';
import type { Door, OpenResult } from './models';
export type AnswerMode = 'off' | 'handshake' | 'answer-on-open';
interface Call {
    conn0: number;
    conn1: number;
    /** Our next sequence number on this connection. */
    seq: number;
    /** Their last sequence number + 1. */
    ack: number;
    peer: string;
    born: number;
    seen: Set<string>;
    ended: boolean;
}
export declare class CallHandler {
    private readonly mode;
    private readonly ourAddress;
    private readonly defaultPeer;
    private readonly sendFrame;
    private readonly log?;
    private readonly calls;
    private waiters;
    constructor(mode: AnswerMode, ourAddress: string, defaultPeer: string, sendFrame: (frame: Buffer) => Promise<void>, log?: Logging | undefined);
    get enabled(): boolean;
    /** The most recent call still in progress, if any. */
    activeCall(): Call | undefined;
    onFrame(frame: CtpFrame, addresses: string[]): Promise<void>;
    /**
     * In `answer-on-open` mode with a call ringing: answer it, open `door` inside the call,
     * then hang up. Returns null when there is nothing to answer, so the caller opens the
     * normal way.
     */
    openInCall(door: Door): Promise<OpenResult | null>;
    private send;
    private wait;
}
export {};
