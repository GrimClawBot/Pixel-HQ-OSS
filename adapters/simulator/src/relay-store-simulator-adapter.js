import {
  validateJobEnvelopeV1,
  validateJobResultV1,
  validateJobTransitionV1,
  validateToolCapabilityDecisionV1,
  validateToolExecutionRequestV1,
} from '../../../packages/contracts/src/job-v1.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function frozenCopy(value) {
  return deepFreeze(structuredClone(value));
}

function sameWorkerBinding(left, right) {
  return left?.worker_id === right?.worker_id
    && left?.department_ref === right?.department_ref
    && left?.role_ref === right?.role_ref;
}

function sameExecutionBinding(request, decision) {
  return request?.request_id === decision?.request_id
    && request?.job_id === decision?.job_id
    && request?.execution_id === decision?.execution_id
    && request?.capability === decision?.capability
    && request?.tool_class === decision?.tool_class
    && request?.target === decision?.target
    && request?.parameter_hash === decision?.parameter_hash
    && request?.environment === decision?.environment
    && sameWorkerBinding(request?.worker_binding, decision?.worker_binding);
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesEnvelope(job, request) {
  const execution = job.envelope.execution;
  return request.job_id === job.envelope.job_id
    && request.execution_id === job.executionId
    && request.environment === job.envelope.environment
    && request.trace_id === job.envelope.trace_id
    && request.capability === execution.capability
    && request.tool_class === execution.tool_class
    && request.target === execution.target
    && request.parameter_hash === execution.parameter_hash
    && sameWorkerBinding(request.worker_binding, execution.worker_binding);
}

function projection(job) {
  if (!job) return null;
  return frozenCopy({
    envelope: job.envelope,
    current_state: job.currentState,
    execution_id: job.executionId,
    transitions: job.transitions,
    execution_request: job.executionRequest,
    gateway_decision: job.gatewayDecision,
    invocation_claimed: job.invocationClaimed,
    result: job.result,
  });
}

export class SimulatorRelayStoreAdapter {
  #failInvocationClaim;
  #failTerminalCommit;
  #jobs = new Map();
  #namespaces = new Map();

  constructor({ failInvocationClaim = false, failTerminalCommit = false } = {}) {
    this.#failInvocationClaim = failInvocationClaim;
    this.#failTerminalCommit = failTerminalCommit;
  }

  get source() {
    return 'simulator';
  }

  claimOrReturnExisting({ namespace, fingerprint, candidateJob }) {
    if (typeof namespace !== 'string' || namespace.length === 0) {
      return { disposition: 'REJECTED', job: null };
    }
    if (!validateJobEnvelopeV1(candidateJob).ok || candidateJob.idempotency.fingerprint !== fingerprint) {
      return { disposition: 'REJECTED', job: null };
    }

    const existingJobId = this.#namespaces.get(namespace);
    if (existingJobId) {
      const existing = this.#jobs.get(existingJobId);
      if (existing.envelope.idempotency.fingerprint !== fingerprint) {
        return { disposition: 'CONFLICT', job: null };
      }
      return { disposition: 'EXISTING', job: projection(existing) };
    }

    const envelope = frozenCopy(candidateJob);
    const job = {
      envelope,
      currentState: 'SUBMITTED',
      executionId: null,
      transitions: [],
      executionRequest: null,
      gatewayDecision: null,
      invocationClaimed: false,
      result: null,
    };
    this.#namespaces.set(namespace, envelope.job_id);
    this.#jobs.set(envelope.job_id, job);
    return { disposition: 'CREATED', job: projection(job) };
  }

  getJob(jobId) {
    return projection(this.#jobs.get(jobId));
  }

  applyTransition(jobId, transition) {
    const job = this.#jobs.get(jobId);
    const validation = validateJobTransitionV1(transition);
    if (
      !job
      || !validation.ok
      || transition.job_id !== jobId
      || transition.trace_id !== job.envelope.trace_id
      || transition.environment !== job.envelope.environment
      || transition.from_state !== job.currentState
      || (
        transition.from_state === 'SUBMITTED'
        && transition.to_state === 'ACCEPTED'
        && transition.execution_id !== null
      )
      || ['COMPLETED', 'FAILED'].includes(job.currentState)
    ) return { disposition: 'REJECTED', job: projection(job) };

    if (transition.to_state === 'RUNNING') job.executionId = transition.execution_id;
    if (job.executionId !== null && transition.execution_id !== job.executionId) {
      return { disposition: 'REJECTED', job: projection(job) };
    }
    job.transitions.push(frozenCopy(transition));
    job.currentState = transition.to_state;
    return { disposition: 'APPLIED', job: projection(job) };
  }

  recordGatewayDecision(jobId, request, decision) {
    const job = this.#jobs.get(jobId);
    if (
      !job
      || job.currentState !== 'RUNNING'
      || job.gatewayDecision !== null
      || !validateToolExecutionRequestV1(request).ok
      || !validateToolCapabilityDecisionV1(decision).ok
      || !matchesEnvelope(job, request)
      || !sameExecutionBinding(request, decision)
    ) return { disposition: 'REJECTED', job: projection(job) };

    job.executionRequest = frozenCopy(request);
    job.gatewayDecision = frozenCopy(decision);
    return { disposition: 'RECORDED', job: projection(job) };
  }

  claimWorkerInvocation(jobId, request, decision) {
    const job = this.#jobs.get(jobId);
    if (
      this.#failInvocationClaim
      || !job
      || job.currentState !== 'RUNNING'
      || job.gatewayDecision?.decision !== 'ALLOW'
      || !sameExecutionBinding(request, decision)
      || !sameExecutionBinding(job.executionRequest, job.gatewayDecision)
      || !sameExecutionBinding(job.executionRequest, request)
      || !sameRecord(job.executionRequest, request)
      || !sameRecord(job.gatewayDecision, decision)
      || decision.decision !== 'ALLOW'
    ) return { disposition: 'REJECTED', job: projection(job) };

    if (job.invocationClaimed) return { disposition: 'ALREADY_CLAIMED', job: projection(job) };
    job.invocationClaimed = true;
    return { disposition: 'INVOKE_NOW', job: projection(job) };
  }

  commitTerminalResult(jobId, transition, result) {
    const job = this.#jobs.get(jobId);
    if (
      this.#failTerminalCommit
      || !job
      || job.currentState !== 'RUNNING'
      || !validateJobTransitionV1(transition).ok
      || !validateJobResultV1(result).ok
      || transition.job_id !== jobId
      || result.job_id !== jobId
      || transition.execution_id !== job.executionId
      || result.execution_id !== job.executionId
      || transition.to_state !== result.state
      || transition.trace_id !== job.envelope.trace_id
      || result.trace_id !== job.envelope.trace_id
      || job.gatewayDecision === null
      || (job.gatewayDecision.decision === 'ALLOW' && !job.invocationClaimed)
      || (job.gatewayDecision.decision === 'DENY' && job.invocationClaimed)
      || (
        job.gatewayDecision.decision === 'DENY'
        && (
          result.state !== 'FAILED'
          || !['CAPABILITY_DENIED', 'AUTHORIZATION_UNAVAILABLE'].includes(result.outcome_code)
        )
      )
      || (
        job.gatewayDecision.decision === 'ALLOW'
        && ['CAPABILITY_DENIED', 'AUTHORIZATION_UNAVAILABLE'].includes(result.outcome_code)
      )
    ) return { disposition: 'REJECTED', job: projection(job) };

    job.transitions.push(frozenCopy(transition));
    job.result = frozenCopy(result);
    job.currentState = transition.to_state;
    return { disposition: 'COMMITTED', job: projection(job) };
  }
}
