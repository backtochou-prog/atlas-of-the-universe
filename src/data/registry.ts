import type { CelestialObject, Dataset } from './schema';

/**
 * Registry for datasets. Datasets are registered (not hard-wired), so new catalogues can be
 * added without touching rendering code. Lookups are by object id and are validated.
 */
export class DataRegistry {
  private readonly datasets = new Map<string, Dataset>();
  private readonly objects = new Map<string, CelestialObject>();

  register(dataset: Dataset): this {
    if (this.datasets.has(dataset.id)) throw new Error(`Dataset "${dataset.id}" already registered`);
    for (const o of dataset.objects) {
      if (this.objects.has(o.id)) throw new Error(`Duplicate object id "${o.id}" (dataset "${dataset.id}")`);
      this.objects.set(o.id, o);
    }
    this.datasets.set(dataset.id, dataset);
    return this;
  }

  get(id: string): CelestialObject | undefined {
    return this.objects.get(id);
  }

  all(): readonly CelestialObject[] {
    return [...this.objects.values()];
  }

  datasetList(): readonly Dataset[] {
    return [...this.datasets.values()];
  }
}
