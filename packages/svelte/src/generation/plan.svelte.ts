import {
  planGenerationRequest,
  type GenerationPlan,
  type GenerationRequest,
  type ModelCapabilities,
  type PlanAdjustment,
  type PlanError,
  type PlanOptions,
} from "@pixerate/editor/generation";

export interface SvelteGenerationPlan {
  readonly plan: GenerationPlan;
  readonly ok: boolean;
  /** The adjusted request. */
  readonly request: GenerationRequest;
  readonly adjustments: PlanAdjustment[];
  readonly errors: PlanError[];
}

/**
 * Reactive `planGenerationRequest` (Svelte 5 runes). Pass getters so the plan
 * follows `$state` request/capabilities/options:
 * `createGenerationPlan(() => request, () => caps, () => ({ strategy }))`.
 */
export function createGenerationPlan(
  request: () => GenerationRequest,
  capabilities: () => ModelCapabilities,
  options: () => PlanOptions = () => ({}),
): SvelteGenerationPlan {
  const plan = $derived(planGenerationRequest(request(), capabilities(), options()));
  return {
    get plan() {
      return plan;
    },
    get ok() {
      return plan.ok;
    },
    get request() {
      return plan.request;
    },
    get adjustments() {
      return plan.adjustments;
    },
    get errors() {
      return plan.errors;
    },
  };
}
