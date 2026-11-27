import type { API, Logging, PlatformAccessory, Service } from 'homebridge';

/** What the plugin last named each service, kept with the accessory (by service type and subtype). */
interface NamedContext {
  givenNames?: Record<string, string>;
}

/**
 * Keeps a service's name in step with the settings (the intercom's Name, or a door's name on the
 * intercom). The first time, the name is only noted: tiles named before this version stay as they
 * are. When the name later changes, the tile takes the new one, unless it was renamed in the Home
 * app since the plugin last named it (that name wins).
 * Returns true when the service was renamed.
 */
export function followName(api: API, log: Logging, accessory: PlatformAccessory, service: Service, name: string): boolean {
  const { Characteristic: C } = api.hap;
  const ctx = accessory.context as NamedContext;
  const key = `${service.UUID}/${service.subtype ?? ''}`;
  const given = ctx.givenNames?.[key];
  ctx.givenNames = { ...ctx.givenNames, [key]: name };
  if (given === undefined || given === name) {
    return false;
  }
  if (!service.testCharacteristic(C.ConfiguredName)) {
    service.addOptionalCharacteristic(C.ConfiguredName);
  }
  const configured = service.getCharacteristic(C.ConfiguredName);
  const shown = typeof configured.value === 'string' ? configured.value.trim() : '';
  if (shown && shown.toLowerCase() !== given.toLowerCase()) {
    log.info(`'${shown}' keeps the name it was given in the Home app (the plugin would now call it '${name}')`);
    return false;
  }
  service.setCharacteristic(C.Name, name);
  configured.updateValue(name);
  log.info(`'${given}' is now '${name}', as in the settings`);
  return true;
}
