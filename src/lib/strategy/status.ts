/**
 * The pullback setup lost money in the 2017-2026 backtest (about -0.06R per trade after costs), so new
 * approvals are paused. The scanner keeps running so the candidates stay visible for learning.
 */
export const PULLBACK_APPROVALS_PAUSED = true;
export const PULLBACK_PAUSE_REASON =
  "Approvals are paused. The backtest found no edge for this setup: about -0.06R per trade after costs, 2017 to 2026. Candidates stay visible for learning. See the Lab for the strategies being tested instead.";
