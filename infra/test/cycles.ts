import type { CfnResource, Json } from './helpers';

/** Logical ids a value depends on through Ref, Fn::GetAtt and Fn::Sub (`${X}` / `${X.Attr}`). */
export function references(value: Json | undefined, out = new Set<string>()): Set<string> {
  if (value === null || value === undefined || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) references(v, out);
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    if (key === 'Ref' && typeof v === 'string') out.add(v);
    else if (key === 'Fn::GetAtt') {
      if (Array.isArray(v) && typeof v[0] === 'string') out.add(v[0]);
      else if (typeof v === 'string') out.add(v.split('.')[0] ?? v);
    } else if (key === 'Fn::Sub') {
      const [template, vars] = Array.isArray(v) ? [v[0], v[1]] : [v, undefined];
      if (typeof template === 'string') {
        const local = new Set(
          vars && typeof vars === 'object' && !Array.isArray(vars) ? Object.keys(vars) : [],
        );
        for (const m of template.matchAll(/\$\{([^!}][^}]*)\}/g)) {
          const id = (m[1] ?? '').split('.')[0] ?? '';
          if (!local.has(id)) out.add(id);
        }
      }
      references(vars, out);
    } else references(v, out);
  }
  return out;
}

/** Resource dependency graph; pseudo parameters, parameters and conditions are not nodes. */
export function dependencyGraph(resources: Record<string, CfnResource>): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const [id, r] of Object.entries(resources)) {
    const deps = references(r.Properties);
    for (const d of typeof r.DependsOn === 'string' ? [r.DependsOn] : (r.DependsOn ?? []))
      deps.add(d);
    graph.set(id, new Set([...deps].filter((d) => d in resources)));
  }
  return graph;
}

/** Tarjan's strongly connected components; returns every component that is a cycle. */
export function findCycles(graph: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (v: string): void => {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!indices.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, indices.get(w) ?? 0));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      const selfLoop = component.length === 1 && (graph.get(v)?.has(v) ?? false);
      if (component.length > 1 || selfLoop) cycles.push(component.sort());
    }
  };

  for (const v of graph.keys()) if (!indices.has(v)) visit(v);
  return cycles;
}
