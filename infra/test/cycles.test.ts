import { dependencyGraph, findCycles, references } from './cycles';
import { type CfnResource, PROD, synth } from './helpers';

describe('cycle detector', () => {
  it('finds Ref, GetAtt (both forms), Sub and DependsOn edges, ignoring pseudo parameters and Sub variables', () => {
    const refs = references({
      a: { Ref: 'A' },
      b: { 'Fn::GetAtt': ['B', 'Arn'] },
      c: { 'Fn::GetAtt': 'C.Arn' },
      d: { 'Fn::Sub': 'arn:${AWS::Partition}:x:${D.Arn}/${E}' },
      e: { 'Fn::Sub': ['${local}-${F}', { local: { Ref: 'G' } }] },
    });
    expect([...refs].sort()).toEqual(['A', 'AWS::Partition', 'B', 'C', 'D', 'E', 'F', 'G']);
  });

  it('reports a cycle, including one only closed by DependsOn, and self references', () => {
    const resources: Record<string, CfnResource> = {
      A: { Type: 'X', Properties: { p: { Ref: 'B' } } },
      B: { Type: 'X', Properties: { p: { 'Fn::Sub': '${C.Arn}' } } },
      C: { Type: 'X', DependsOn: ['A'] },
      D: { Type: 'X', Properties: { p: { Ref: 'D' } } },
      E: { Type: 'X', Properties: { p: { Ref: 'A' } } },
    };
    expect(findCycles(dependencyGraph(resources))).toEqual([['A', 'B', 'C'], ['D']]);
  });

  it('reports nothing for a DAG', () => {
    const resources: Record<string, CfnResource> = {
      A: { Type: 'X', Properties: { p: { Ref: 'B' } } },
      B: { Type: 'X', Properties: { p: { Ref: 'AWS::Region' } } },
      C: { Type: 'X', DependsOn: 'A' },
    };
    expect(findCycles(dependencyGraph(resources))).toEqual([]);
  });
});

describe('synthesized templates', () => {
  it.each([
    ['dev', {}],
    [
      'prod with operator role',
      { ...PROD, operatorPrincipalArn: 'arn:aws:iam::111111111111:root' },
    ],
  ])('%s has no dependency cycle', (_name, context) => {
    const s = synth(context);
    const graph = dependencyGraph(s.resources);
    expect(graph.size).toBeGreaterThan(50);
    expect(findCycles(graph)).toEqual([]);
  });
});
