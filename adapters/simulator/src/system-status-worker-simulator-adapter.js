import { SYSTEM_STATUS_WORKER_CONTRACT } from '../../../packages/adapter-sdk/src/job-runtime-adapters.js';

export class SimulatorSystemStatusWorker {
  #invocationCount = 0;
  #outcomeCode;

  constructor({ outcomeCode = 'SYSTEM_STATUS_AVAILABLE' } = {}) {
    this.#outcomeCode = outcomeCode;
  }

  get source() {
    return 'simulator';
  }

  get contract() {
    return SYSTEM_STATUS_WORKER_CONTRACT;
  }

  get invocationCount() {
    return this.#invocationCount;
  }

  async execute() {
    this.#invocationCount += 1;
    return Object.freeze({ outcome_code: this.#outcomeCode });
  }
}
