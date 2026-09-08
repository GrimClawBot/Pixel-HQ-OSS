import { IDENTITY_PROVIDER_CONTRACT } from '../../../packages/adapter-sdk/src/access-context-providers.js';

export class SimulatorIdentityProvider {
  #verificationStatus;

  constructor({ verificationStatus = 'verified' } = {}) {
    this.#verificationStatus = verificationStatus;
  }

  get source() {
    return 'simulator';
  }

  async resolveIdentity() {
    return Object.freeze({
      subject_id: 'PIXEL-PRINCIPAL',
      identity_class: 'human',
      role: 'Principal',
      verification_status: this.#verificationStatus,
      provider_contract: IDENTITY_PROVIDER_CONTRACT,
      source: this.source,
    });
  }
}
