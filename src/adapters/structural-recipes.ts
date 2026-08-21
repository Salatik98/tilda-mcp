import { TildaEngineError } from "../core/contracts.js";
import type { KnownObservedTemplateId } from "../research/browser-session.js";

export type StructuralRecipeState =
  | "PREFLIGHT_ONLY"
  | "LIVE_REPRODUCED"
  | "UNAVAILABLE_EVIDENCE_GAP";

export interface StructuralRecipe {
  readonly operation: "standard.add" | "standard.clone" | "standard.order";
  readonly state: StructuralRecipeState;
  readonly boundary: string;
}

export const STANDARD_STRUCTURAL_RECIPES: readonly StructuralRecipe[] = Object.freeze([
  Object.freeze({
    operation: "standard.add",
    state: "PREFLIGHT_ONLY",
    boundary: "Known template 128/778/131/396; EXP-06 observed create and reload admission but did not prove cleanup.",
  }),
  Object.freeze({
    operation: "standard.clone",
    state: "UNAVAILABLE_EVIDENCE_GAP",
    boundary: "No exact standard-record clone/readback/cleanup contract exists.",
  }),
  Object.freeze({
    operation: "standard.order",
    state: "UNAVAILABLE_EVIDENCE_GAP",
    boundary: "EXP-07 is blocked; page-order evidence does not authorize record-order writes.",
  }),
]);

export interface KnownTemplateAddPlan {
  readonly templateId: KnownObservedTemplateId;
  readonly afterRecordId: string | null;
  readonly beforeRecordId: string | null;
  readonly remoteDispatchAllowed: false;
  readonly reason: "BOUNDED_CREATE_CLEANUP_ACCEPTANCE_REQUIRED";
}

/**
 * Fixed add shape for a future bounded copy experiment. It deliberately emits
 * no dispatchable recipe until create/readback/cleanup is proven end to end.
 */
export function planKnownTemplateAddPreflight(input: {
  readonly templateId: KnownObservedTemplateId;
  readonly afterRecordId?: string | null;
  readonly beforeRecordId?: string | null;
}): KnownTemplateAddPlan {
  const afterRecordId = input.afterRecordId ?? null;
  const beforeRecordId = input.beforeRecordId ?? null;
  const validId = (value: string | null) => value === null || /^[1-9]\d*$/u.test(value);
  if (
    !validId(afterRecordId) ||
    !validId(beforeRecordId) ||
    (afterRecordId === beforeRecordId && afterRecordId !== null)
  ) {
    throw new TildaEngineError("STRUCTURAL_TARGET_REJECTED", "Known-template anchors are invalid.");
  }
  return Object.freeze({
    templateId: input.templateId,
    afterRecordId,
    beforeRecordId,
    remoteDispatchAllowed: false,
    reason: "BOUNDED_CREATE_CLEANUP_ACCEPTANCE_REQUIRED",
  });
}

export function requireStandardStructuralRecipe(operation: StructuralRecipe["operation"]): StructuralRecipe {
  const recipe = STANDARD_STRUCTURAL_RECIPES.find((candidate) => candidate.operation === operation);
  if (recipe === undefined || recipe.state === "UNAVAILABLE_EVIDENCE_GAP") {
    throw new TildaEngineError(
      "CAPABILITY_UNAVAILABLE",
      recipe?.boundary ?? "No checked-in standard structural recipe exists.",
    );
  }
  return recipe;
}
