import {
  MODEL_OUTPUT_MAX_CHARS,
  MODEL_ROUTING_POLICY_ID,
} from '../../../packages/contracts/src/model-v1.js';

const ROUTES = Object.freeze({
  simulation: Object.freeze({
    placement: Object.freeze({
      runtime_id: 'pixel.simulator.model-runtime-a',
      model_id: 'pixel.fake-model-a.v1',
      source: 'simulator',
    }),
    budget: Object.freeze({
      max_input_token_units: 256,
      max_output_token_units: 64,
      max_output_chars: MODEL_OUTPUT_MAX_CHARS,
    }),
  }),
  dev: Object.freeze({
    placement: Object.freeze({
      runtime_id: 'pixel.simulator.model-runtime-b',
      model_id: 'pixel.fake-model-b.v1',
      source: 'simulator',
    }),
    budget: Object.freeze({
      max_input_token_units: 512,
      max_output_token_units: 96,
      max_output_chars: MODEL_OUTPUT_MAX_CHARS,
    }),
  }),
});

export function selectAlphaModelRoute(environment) {
  const route = ROUTES[environment];
  if (!route) {
    return Object.freeze({
      decision: 'DENY', reason_code: 'ROUTE_UNSUPPORTED', policy_id: MODEL_ROUTING_POLICY_ID,
      placement: null, budget: null,
    });
  }
  return Object.freeze({
    decision: 'ROUTE', reason_code: 'ROUTE_SELECTED', policy_id: MODEL_ROUTING_POLICY_ID,
    placement: route.placement, budget: route.budget,
  });
}
