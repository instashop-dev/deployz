import type { AnalysisResultFile } from '../contract.js';
import type { BuildRequest, BuiltImage, ProductionEnvironmentFn, Runner, Services } from '../ports.js';

export interface ObserveDeps {
  buildImage(req: BuildRequest): Promise<BuiltImage>;
  services: Services;
  runner: Runner;
  env: ProductionEnvironmentFn;
  now(): Date;
  log(line: string): void;
  /** Waits without blocking; the default is `setTimeout`. Tests pass a fake. */
  sleep?(ms: number): Promise<void>;
}

export interface ObserveOptions {
  force: boolean;
  observationsDir: string;
  runsDir: string;
  analyses: AnalysisResultFile[];
  harnessVersion: string;
  fixtureDir?: string;
}
