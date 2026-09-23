import type { SellerTrust } from '../lib/sellerTrust'

/**
 * A seller's record, as three tiers rather than a binary (spec §5.6.1).
 *
 * The count is shown in every tier, including the solid one: 100% of 45 reviews
 * and 100% of 19,000 look identical if only the percentage is printed, and the
 * reader is the one who should decide what that is worth.
 */
export function SellerBadge({ trust }: { trust: SellerTrust }) {
  if (trust.tier === 'not_marked') return null
  const solid = trust.tier === 'trusted'
  return (
    <span
      title={
        solid
          ? `Flawless record over ${trust.count} reviews`
          : `Flawless, but only ${trust.count} reviews`
      }
      className={
        solid
          ? 'rounded bg-seashell px-1.5 py-0.5 text-xs text-space-indigo'
          : 'rounded border border-seashell/40 px-1.5 py-0.5 text-xs text-seashell/70'
      }
    >
      100%{trust.count === null ? '' : ` · ${trust.count.toLocaleString('en-US')}`}
    </span>
  )
}
