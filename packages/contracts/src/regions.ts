import { z } from 'zod';

// §32 region allowlist — EXACTLY these 17 AWS regions, nothing else.
//
// This is the SINGLE canonical source of the supported-region set. Every
// consumer derives from it — API/deployment validation (regionSchema), the
// install page's Quick Create link (resolveBootstrapTemplate), the bootstrap
// publisher's regional fan-out (SUPPORTED_AWS_REGIONS) and the UI's region
// options (REGION_LABELS) — so no other module ever lists regions again.
export const SUPPORTED_AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'sa-east-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-north-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
] as const;
export type Region = (typeof SUPPORTED_AWS_REGIONS)[number];

export const regionSchema = z.enum(SUPPORTED_AWS_REGIONS);

/** Human-readable label per supported region, for UI region options. */
export const REGION_LABELS: Readonly<Record<Region, string>> = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'ca-central-1': 'Canada (Central)',
  'sa-east-1': 'South America (São Paulo)',
  'eu-west-1': 'Europe (Ireland)',
  'eu-west-2': 'Europe (London)',
  'eu-west-3': 'Europe (Paris)',
  'eu-central-1': 'Europe (Frankfurt)',
  'eu-north-1': 'Europe (Stockholm)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
};

/** Type guard for a value that must be one of the supported regions. */
export function isSupportedRegion(value: string): value is Region {
  return (SUPPORTED_AWS_REGIONS as readonly string[]).includes(value);
}
