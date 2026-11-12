import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Door } from '../models';
import type { ComelitIntercomPlatform } from '../platform';

const SHOW_UNLOCKED_MS = 3_000;
const REFUSED_LOG_INTERVAL_MS = 5_000;

/**
 * One door relay as a HomeKit lock. Unlock opens the door; the lock shows Unlocked at once, and
 * Locked again a few seconds after the intercom has taken the open (at once if it refuses).
 */
export class LockAccessory {
  private readonly service: Service;
  private lockState: number;
  private lastRefusedLog = 0;
  private opening = false;
  /** When the lock shows Locked again after an open; a new open cancels it. */
  private relockTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: ComelitIntercomPlatform,
    readonly accessory: PlatformAccessory,
    private readonly door: Door,
  ) {
    const { Service, Characteristic } = platform;
    this.lockState = Characteristic.LockCurrentState.SECURED;
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, 'ViP door relay')
      .setCharacteristic(Characteristic.SerialNumber, `door-${door.index}`);
    this.service = accessory.getService(Service.LockMechanism) || accessory.addService(Service.LockMechanism, door.name);
    this.service.getCharacteristic(Characteristic.LockCurrentState).onGet(() => {
      this.checkReachable();
      return this.lockState;
    });
    this.service
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(() => {
        this.checkReachable();
        return this.lockState === Characteristic.LockCurrentState.UNSECURED ? Characteristic.LockTargetState.UNSECURED : Characteristic.LockTargetState.SECURED;
      })
      .onSet((value) => this.onTarget(value));
  }

  /** Home shows No Response while the intercom has been unreachable for a while. */
  private checkReachable(): void {
    if (this.platform.unreachable()) {
      const { hap } = this.platform.api;
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** The intercom is back: tell Home the lock's state again (clears No Response). */
  refresh(): void {
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.LockCurrentState, this.lockState);
    this.service.updateCharacteristic(
      Characteristic.LockTargetState,
      this.lockState === Characteristic.LockCurrentState.UNSECURED ? Characteristic.LockTargetState.UNSECURED : Characteristic.LockTargetState.SECURED,
    );
  }

  private onTarget(value: CharacteristicValue): void {
    const { Characteristic } = this.platform;
    if (value !== Characteristic.LockTargetState.UNSECURED) {
      return;
    }
    if (this.platform.unreachable()) {
      this.platform.log.warn('Open refused: the intercom is not connected');
      this.checkReachable();
    }
    if (!this.platform.isUnlockAllowed()) {
      const now = Date.now();
      if (now - this.lastRefusedLog > REFUSED_LOG_INTERVAL_MS) {
        this.lastRefusedLog = now;
        this.platform.log.warn(`Open refused: no ring in the last ${this.platform.settings.ringWindowMs / 1000} s`);
      }
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    if (this.opening) {
      return; // an open is already on its way
    }
    // Answer HomeKit right away; the door command can take several seconds.
    void this.triggerOpen();
  }

  /** Shows Unlocked for a moment after a door open that didn't come from this lock (doctor mode). */
  showOpened(): void {
    const { Characteristic } = this.platform;
    if (this.opening) {
      return; // this lock's own open is showing Unlocked already, and relocks itself
    }
    clearTimeout(this.relockTimer);
    this.lockState = Characteristic.LockCurrentState.UNSECURED;
    this.service.updateCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.UNSECURED);
    this.relockTimer = setTimeout(() => {
      this.lockState = Characteristic.LockCurrentState.SECURED;
      this.service.updateCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.SECURED);
    }, SHOW_UNLOCKED_MS);
  }

  async triggerOpen(): Promise<void> {
    const { Characteristic } = this.platform;
    const relock = () => {
      this.lockState = Characteristic.LockCurrentState.SECURED;
      this.service.updateCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.SECURED);
      this.service.updateCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED);
    };
    this.opening = true;
    clearTimeout(this.relockTimer); // an earlier open's relock must not show Locked during this one
    // Shown as Unlocked at once: the intercom confirms an open only by not refusing it, which
    // takes a few seconds (and longer when the call must be answered first). A refusal or a
    // failure turns it back to Locked.
    this.lockState = Characteristic.LockCurrentState.UNSECURED;
    this.service.updateCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.UNSECURED);
    try {
      const result = await this.platform.openDoor(this.door);
      if (result.confirmed) {
        this.platform.log.info(`Door '${this.door.name}' opened`);
      } else {
        this.platform.log.warn(`Door '${this.door.name}': open sent, but the intercom did not confirm it`);
      }
    } catch (e) {
      this.platform.log.error(`Door open failed: ${(e as Error).message}`);
      relock();
      return;
    } finally {
      this.opening = false;
    }
    this.relockTimer = setTimeout(relock, SHOW_UNLOCKED_MS);
  }
}
