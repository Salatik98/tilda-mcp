import type {
  AdapterRegistry,
  ChangeAdapter,
  ChangeRequest,
} from "../core/contracts.js";
import { TildaEngineError } from "../core/contracts.js";

export class StaticAdapterRegistry implements AdapterRegistry {
  readonly #adapters: readonly ChangeAdapter[];

  constructor(adapters: readonly ChangeAdapter[]) {
    const ids = adapters.map((adapter) => adapter.id);
    if (new Set(ids).size !== ids.length) {
      throw new TildaEngineError("DUPLICATE_ADAPTER", "Adapter IDs must be unique.");
    }
    this.#adapters = [...adapters];
  }

  forRequest(request: ChangeRequest): ChangeAdapter {
    const matches = this.#adapters.filter((adapter) => adapter.supports(request));
    if (matches.length !== 1) {
      throw new TildaEngineError(
        "CAPABILITY_UNAVAILABLE",
        "Exactly one adapter must own the requested capability.",
      );
    }
    return matches[0]!;
  }

  byId(adapterId: string): ChangeAdapter {
    const adapter = this.#adapters.find((candidate) => candidate.id === adapterId);
    if (adapter === undefined) {
      throw new TildaEngineError("ADAPTER_UNAVAILABLE", "ChangeSet adapter is unavailable.");
    }
    return adapter;
  }

  listCapabilities() {
    return this.#adapters.map((adapter) => ({
      adapter: adapter.id,
      capabilities: [...adapter.capabilities],
    }));
  }
}
