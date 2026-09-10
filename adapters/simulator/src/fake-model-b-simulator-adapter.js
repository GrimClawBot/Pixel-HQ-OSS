import { snapshotSafePlainData } from '../../../packages/adapter-sdk/src/model-runtime-adapters.js';
import {
  MODEL_RUNTIME_ADAPTER_CONTRACT,
  MODEL_SCHEMA_VERSION,
  validateModelProviderRequestV1,
} from '../../../packages/contracts/src/model-v1.js';
import { tokenizeMemoryText } from '../../../packages/contracts/src/memory-v1.js';

function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return value;
}

export class FakeModelBSimulatorAdapter {
  get source() { return 'simulator'; }
  get providerContract() { return MODEL_RUNTIME_ADAPTER_CONTRACT; }
  get runtimeId() { return 'pixel.simulator.model-runtime-b'; }
  get modelId() { return 'pixel.fake-model-b.v1'; }

  invoke(providerRequest) {
    const request = snapshotSafePlainData(providerRequest);
    if (!validateModelProviderRequestV1(request).ok) throw new TypeError('Fake Model B requires a valid provider request');
    const output = `Fake Model B summarized ${request.context_items.length} approved context item(s).`;
    return freeze({
      provider_result_id: `provider-result-${request.provider_request_id}`,
      schema_version: MODEL_SCHEMA_VERSION,
      invocation_id: request.invocation_id,
      provider_contract: MODEL_RUNTIME_ADAPTER_CONTRACT,
      runtime_id: this.runtimeId,
      model_id: this.modelId,
      source: this.source,
      status: 'OUTPUT_AVAILABLE',
      output_text: output,
      output_token_units: tokenizeMemoryText(output).length,
    });
  }
}
