/**
 * The AWS CloudFormation console URL for a region — the exact pattern the
 * install and deploy pages already link with. `filteringText` (a stack
 * name) rides the hash fragment's own query, matching the existing
 * prefiltered links.
 */
export function cloudFormationStacksUrl(region: string, filteringText?: string): string {
  const base = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks`;
  return filteringText === undefined ? base : `${base}?filteringText=${encodeURIComponent(filteringText)}`;
}
