// nDCG@k scorer with binary relevance.

/**
 * Compute nDCG@k given a ranked list of retrieved IDs and a set of relevant IDs.
 * Uses binary relevance: 1 if the retrieved ID is in goldIds, 0 otherwise.
 */
export function ndcg(retrievedIds: string[], goldIds: Set<string>, k: number): number {
  if (goldIds.size === 0) return 0;

  const topK = retrievedIds.slice(0, k);

  // DCG: sum of rel_i / log2(i + 2) for i in 0..k-1
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = goldIds.has(topK[i]!) ? 1 : 0;
    dcg += rel / Math.log2(i + 2);
  }

  // Ideal DCG: all relevant docs ranked first
  const idealCount = Math.min(goldIds.size, k);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  if (idcg === 0) return 0;
  return dcg / idcg;
}
