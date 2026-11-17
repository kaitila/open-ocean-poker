// Logarithmic Market Scoring Rule (LMSR) market maker.
// Shared by the server (require) and the browser (window.LMSR) so quotes match.
//
// q:      { outcomeId: sharesOutstanding }
// active: array of outcome ids still alive (busted players are dropped,
//         which renormalises the remaining prices)
// b:      liquidity parameter (higher = prices move less per chip)
(function (root) {
  function logSumExp(xs) {
    if (!xs.length) return -Infinity;
    const m = Math.max(...xs);
    let s = 0;
    for (const x of xs) s += Math.exp(x - m);
    return m + Math.log(s);
  }

  function cost(q, active, b) {
    return b * logSumExp(active.map((id) => (q[id] || 0) / b));
  }

  function prices(q, active, b) {
    const lse = logSumExp(active.map((id) => (q[id] || 0) / b));
    const out = {};
    for (const id of active) out[id] = Math.exp((q[id] || 0) / b - lse);
    return out;
  }

  // Shares received for spending `amount` chips on `id`.
  function sharesForAmount(q, active, b, id, amount) {
    if (amount <= 0) return 0;
    // ΔC = X  =>  e^{Δ/b} = 1 + (S/e_i)(e^{X/b} - 1)
    // S/e_i = 1/p_i, computed in log space for stability.
    const p = prices(q, active, b)[id];
    const ratio = Math.expm1(amount / b) / p; // can be large; log1p keeps it sane
    return b * Math.log1p(ratio);
  }

  // Chips received for selling `shares` of `id`.
  function amountForShares(q, active, b, id, shares) {
    if (shares <= 0) return 0;
    const before = cost(q, active, b);
    const q2 = Object.assign({}, q, { [id]: (q[id] || 0) - shares });
    return before - cost(q2, active, b);
  }

  const api = { cost, prices, sharesForAmount, amountForShares };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LMSR = api;
})(typeof window !== 'undefined' ? window : globalThis);
