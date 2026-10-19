// Net worth: what the user owns minus what they owe. Spec §5 — reports classify by node KIND, never by the
// sign of an amount, which is why income and expense totals (flows, not holdings) never enter net worth and a
// bank-to-bank transfer cannot be double-counted as income.

import type { LedgerKind } from "./ledger-kind"
import type { Paise } from "./money"

export interface NodeBalance {
  nodeId: string
  kind: LedgerKind
  balance: Paise
}

export interface NetWorth {
  assets: Paise
  investments: Paise
  liabilities: Paise
  total: Paise
  // True when at least one investment could not be valued and so is missing from `total`.
  isPartial: boolean
  unvaluedNodeIds: string[]
}

/**
 * net worth = Σ ASSET balances + Σ INVESTMENT current values − Σ LIABILITY balances
 *
 * `valuations` maps an investment node to its current market value:
 *   - absent from the map  → falls back to its contribution balance (all of M1's behaviour);
 *   - present with a Paise → that value is used instead of the contribution balance;
 *   - present with `null`  → the node cannot be valued: it is left out of the total entirely (neither zero nor
 *     cost, either of which would state a figure the user would believe and that would be wrong), listed in
 *     `unvaluedNodeIds`, and the result is flagged `isPartial`.
 */
export function netWorth(
  balances: readonly NodeBalance[],
  valuations: ReadonlyMap<string, Paise | null> = new Map(),
): NetWorth {
  let assets = 0n
  let investments = 0n
  let liabilities = 0n
  const unvaluedNodeIds: string[] = []

  for (const { nodeId, kind, balance } of balances) {
    switch (kind) {
      case "ASSET":
        assets += balance
        break
      case "LIABILITY":
        liabilities += balance
        break
      case "INVESTMENT": {
        // `has`, not truthiness: a null value and a 0n value are both falsy, and neither means "absent".
        const value = valuations.has(nodeId) ? valuations.get(nodeId) : balance
        if (value === null || value === undefined) {
          unvaluedNodeIds.push(nodeId)
        } else {
          investments += value
        }
        break
      }
      case "INCOME_SOURCE":
      case "EXPENSE":
        // Flows, not holdings.
        break
    }
  }

  return {
    assets,
    investments,
    liabilities,
    total: assets + investments - liabilities,
    isPartial: unvaluedNodeIds.length > 0,
    unvaluedNodeIds,
  }
}
