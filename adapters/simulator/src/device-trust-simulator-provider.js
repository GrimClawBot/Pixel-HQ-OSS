import { DEVICE_TRUST_PROVIDER_CONTRACT } from '../../../packages/adapter-sdk/src/access-context-providers.js';

export class SimulatorDeviceTrustProvider {
  #certificateStatus;
  #enrollmentStatus;
  #riskPosture;
  #trustStatus;

  constructor({
    enrollmentStatus = 'enrolled',
    trustStatus = 'trusted',
    certificateStatus = 'valid',
    riskPosture = 'acceptable',
  } = {}) {
    this.#enrollmentStatus = enrollmentStatus;
    this.#trustStatus = trustStatus;
    this.#certificateStatus = certificateStatus;
    this.#riskPosture = riskPosture;
  }

  get source() {
    return 'simulator';
  }

  revoke() {
    this.#trustStatus = 'revoked';
  }

  async resolveDeviceTrust() {
    return Object.freeze({
      device_id: 'sim-owner-device-01',
      enrollment_status: this.#enrollmentStatus,
      trust_status: this.#trustStatus,
      certificate_status: this.#certificateStatus,
      risk_posture: this.#riskPosture,
      provider_contract: DEVICE_TRUST_PROVIDER_CONTRACT,
      source: this.source,
    });
  }
}
