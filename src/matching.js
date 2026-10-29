// Minimum-cost maximum bipartite matching for the small station snapshots.
// Successive shortest augmenting paths can undo earlier choices through
// reverse edges; unlike greedy matching, a cheap first pair cannot lock out
// a better complete assignment. Bellman-Ford handles negative reverse costs.
// Costs are lexicographic: exact timestamp offset first, ordering only on ties.
export function minimumCostMatching(leftCount, rightCount, candidates) {
  const source = leftCount + rightCount;
  const sink = source + 1;
  const graph = Array.from({ length: sink + 1 }, () => []);
  function addEdge(from, to, cost, tieCost = 0) {
    const edge = { to, reverse: graph[to].length, capacity: 1, cost, tieCost };
    graph[from].push(edge);
    graph[to].push({
      to: from,
      reverse: graph[from].length - 1,
      capacity: 0,
      cost: -cost,
      tieCost: -tieCost,
    });
    return edge;
  }
  for (let l = 0; l < leftCount; l++) addEdge(source, l, 0);
  for (let r = 0; r < rightCount; r++) addEdge(leftCount + r, sink, 0);
  const pairs = [...candidates]
    .sort((a, b) => a.left - b.left || a.right - b.right)
    .map((pair) => ({
      pair,
      edge: addEdge(pair.left, leftCount + pair.right, pair.cost, pair.tieCost ?? 0),
    }));

  for (;;) {
    const costs = Array(graph.length).fill(Infinity);
    const ties = Array(graph.length).fill(Infinity);
    const previous = Array(graph.length).fill(null);
    costs[source] = ties[source] = 0;
    for (let pass = 0; pass < graph.length - 1; pass++) {
      let changed = false;
      for (let from = 0; from < graph.length; from++) {
        if (costs[from] === Infinity) continue;
        for (const [index, edge] of graph[from].entries()) {
          if (!edge.capacity) continue;
          const cost = costs[from] + edge.cost;
          const tie = ties[from] + edge.tieCost;
          if (cost < costs[edge.to] || (cost === costs[edge.to] && tie < ties[edge.to])) {
            costs[edge.to] = cost;
            ties[edge.to] = tie;
            previous[edge.to] = { from, index };
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    // Augment until no path remains: coverage outranks the sum of offsets.
    if (!previous[sink]) break;
    for (let to = sink; to !== source;) {
      const { from, index } = previous[to];
      const edge = graph[from][index];
      edge.capacity--;
      graph[to][edge.reverse].capacity++;
      to = from;
    }
  }
  return pairs.filter(({ edge }) => !edge.capacity).map(({ pair }) => pair);
}
