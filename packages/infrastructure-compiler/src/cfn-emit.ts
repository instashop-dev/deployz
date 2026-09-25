import type { ResolvedAwsGraph, ResolvedResource } from './resolved-graph.js';

// Deterministic CloudFormation serialization. Pure — the same resolved graph
// always serializes to the same template object (and therefore the same JSON
// and hash). Key order is construction order (stable); no timestamps, no
// random ids, no AWS lookups.

function serializeResource(resource: ResolvedResource): Record<string, unknown> {
  return {
    Type: resource.cfnType,
    Properties: resource.properties,
    ...(resource.dependsOn !== undefined && resource.dependsOn.length > 0
      ? { DependsOn: resource.dependsOn }
      : {}),
    // DeletionPolicy/UpdateReplacePolicy are emitted only for retained
    // (stateful) resources — CloudFormation's default is Delete, and
    // emitting an explicit Delete on every resource adds noise without
    // changing semantics.
    ...(resource.deletionPolicy === 'Retain'
      ? { UpdateReplacePolicy: 'Retain', DeletionPolicy: 'Retain' }
      : {}),
  };
}

/**
 * Serialize a resolved graph to a CloudFormation template object. Resources
 * are emitted in graph order (dependency order), which is deterministic.
 */
export function emitCloudFormation(graph: ResolvedAwsGraph): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  for (const param of graph.parameters) {
    parameters[param.id] = {
      Type: param.type,
      ...(param.defaultValue !== undefined ? { Default: param.defaultValue } : {}),
      ...(param.description !== undefined ? { Description: param.description } : {}),
      NoEcho: param.noEcho,
    };
  }

  const resources: Record<string, unknown> = {};
  for (const resource of graph.resources) {
    resources[resource.logicalId] = serializeResource(resource);
  }

  const outputs: Record<string, unknown> = {};
  for (const output of graph.outputs) {
    outputs[output.id] = { Value: output.value };
  }

  const template: Record<string, unknown> = {
    Parameters: parameters,
    Resources: resources,
    Outputs: outputs,
  };
  if (graph.conditions.length > 0) {
    const conditions: Record<string, unknown> = {};
    for (const condition of graph.conditions) {
      conditions[condition.id] = condition.expression;
    }
    template['Conditions'] = conditions;
  }
  return template;
}
