import type { AdapterState, ChangeRequest, PlannedMutation } from "./contracts.js";
import { TildaEngineError } from "./contracts.js";

export interface VolatileChangeMaterial {
  readonly request: ChangeRequest;
  readonly before: AdapterState;
  readonly plan: PlannedMutation;
}

/**
 * Raw lab values, T123 code, Zero models, and page forms never leave process
 * memory. A server restart intentionally makes pending rollback unavailable.
 */
export class VolatileSnapshotVault {
  readonly #materials = new Map<string, VolatileChangeMaterial>();

  put(changeSetId: string, material: VolatileChangeMaterial): void {
    if (this.#materials.has(changeSetId)) {
      throw new TildaEngineError("VAULT_CONFLICT", "ChangeSet material already exists in memory.");
    }
    try {
      this.#materials.set(changeSetId, structuredClone(material));
    } catch {
      throw new TildaEngineError(
        "INVALID_VOLATILE_MATERIAL",
        "Private snapshot material must be structured-cloneable and process-local.",
      );
    }
  }

  get(changeSetId: string): VolatileChangeMaterial {
    const material = this.#materials.get(changeSetId);
    if (material === undefined) {
      throw new TildaEngineError(
        "PLAN_MATERIAL_UNAVAILABLE",
        "The private snapshot is no longer in this MCP process; no write or rollback is allowed.",
      );
    }
    try {
      return structuredClone(material);
    } catch {
      throw new TildaEngineError(
        "INVALID_VOLATILE_MATERIAL",
        "Private snapshot material could not be safely cloned.",
      );
    }
  }

  has(changeSetId: string): boolean {
    return this.#materials.has(changeSetId);
  }

  delete(changeSetId: string): void {
    this.#materials.delete(changeSetId);
  }
}
