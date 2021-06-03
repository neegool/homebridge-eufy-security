import {
  Service,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { EufySecurityPlatform, EufySecurityPlatformConfig } from './platform';
import { EufySecurity, Station } from 'eufy-security-client';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class SecuritySystemPlatformAccessory {
  private service: Service;

  constructor(
    private readonly platform: EufySecurityPlatform,
    private readonly accessory: PlatformAccessory,
    private eufyClient: EufySecurity,
    private eufyStation: Station,
    private config: EufySecurityPlatformConfig,
  ) {
    this.platform.log.debug('Constructed Switch');
    // set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Eufy')
      .setCharacteristic(
        this.platform.Characteristic.Model,
        'Security Mode Control',
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        accessory.UUID,
      );

    this.service =
      this.accessory.getService(this.platform.Service.SecuritySystem) ||
      this.accessory.addService(this.platform.Service.SecuritySystem);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.displayName,
    );

    // create handlers for required characteristics
    this.service
      .getCharacteristic(
        this.platform.Characteristic.SecuritySystemCurrentState,
      )
      .on('get', this.handleSecuritySystemCurrentStateGet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.SecuritySystemTargetState)
      .on('get', this.handleSecuritySystemTargetStateGet.bind(this))
      .on('set', this.handleSecuritySystemTargetStateSet.bind(this));
  }

  async getCurrentStatus() {
    this.platform.log.debug(
      this.eufyClient.isConnected()
        ? 'Connected to Eufy API'
        : 'Not connected to Eufy API',
    );

    const guardMode = this.eufyClient
      .getStation(this.eufyStation.getSerial())
      .getGuardMode();
    this.platform.log.info('Eufy Guard Mode: ', guardMode);
    return this.convertStatusCodeToHomekit(guardMode.value as number);
  }

  convertMode(eufyMode: number) {
    const modes = [
      {'hk': 0, 'eufy': this.config.hkHome},
      {'hk': 1, 'eufy': this.config.hkAway},
      {'hk': 2, 'eufy': this.config.hkNight},
      {'hk': 3, 'eufy': this.config.hkOff},
     
    ];
    const modeObj = modes.filter(m => {
      return m.eufy === eufyMode;
    });

    return modeObj[0].hk;

  }


  convertStatusCodeToHomekit(code: number) {

    
    //---Eufy Modes--------
    //     0: "AWAY",
    //     1: "HOME",
    //     2: "SCHEDULE",
    //     3: "CUSTOM1",
    //     4: "CUSTOM2",
    //     5: "CUSTOM3",
    //     47: "GEO",
    //     63: "DISARMED"
    //-----------------------
    //---HomeKit Modes-------
    //     0: "AWAY",
    //     1: "HOME",
    //     2: "NIGHT",
    //     3: "OFF",
    //-----------------------
    switch (code) {
      case 0: //Eufy mode
        return this.convertMode(0);
      case 1: 
        return this.convertMode(1);
      case 2: 
        return this.convertMode(2);
      case 3: 
        return this.convertMode(3); 
      case 4: 
        return this.convertMode(4); 
      case 5: 
        return this.convertMode(5); 
      case 47: 
        return this.convertMode(47); 
      case 63:
        return this.convertMode(63); 
      default:
        break;
    }
  }

  /**
   * Handle requests to get the current value of the "Security System Current State" characteristic
   */
  async handleSecuritySystemCurrentStateGet(callback) {
    this.platform.log.debug('Triggered GET SecuritySystemCurrentState');

    // set this to a valid value for SecuritySystemCurrentState
    const currentValue = await this.getCurrentStatus();
    this.platform.log.debug('Handle Current System state:  -- ', currentValue);

    callback(null, currentValue);
  }

  /**
   * Handle requests to get the current value of the "Security System Target State" characteristic
   */
  async handleSecuritySystemTargetStateGet(callback) {
    this.platform.log.debug('Triggered GET SecuritySystemTargetState');

    // set this to a valid value for SecuritySystemTargetState
    const currentValue = await this.getCurrentStatus();

    callback(null, currentValue);
  }

  /**
   * Handle requests to set the "Security System Target State" characteristic
   */
  handleSecuritySystemTargetStateSet(value, callback) {
    //   states: {
    //     0: "AWAY",
    //     1: "HOME",
    //     2: "SCHEDULE",
    //     3: "CUSTOM1",
    //     4: "CUSTOM2",
    //     5: "CUSTOM3",
    //     47: "GEO",
    //     63: "DISARMED"
    // }




    let mode = -1;
    switch (value) {
      case 0: //homekit HOME
        mode = this.config.hkHome; //eufy home
        break;
      case 1: //homekit AWAY
        mode = this.config.hkAway;
        break;
      case 2: //homekit NIGHT
        mode = this.config.hkNight;
        break;
      case 3: //homekit OFF
        mode = this.config.hkOff;
        break;
      default:
        break;
    }

    if (mode === -1) {
      this.platform.log.error('Error Setting security mode! (mode returned -1)');
    } else {
      try {
        this.eufyClient.setStationProperty(
          this.eufyStation.getSerial(),
          'guardMode',
          mode,
        );
        this.service.updateCharacteristic(
          this.platform.Characteristic.SecuritySystemCurrentState,
          value,
        );
      } catch (error) {
        this.platform.log.error(
          'Error Setting security mode!',
          error,
        );
      }
    }
    callback(null);
  }
}
