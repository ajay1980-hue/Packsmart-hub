# Cost-entry basis

Products & Profit compares the displayed variant price with costs for one saleable SKU / variant unit. That unit can be an individual item or a retail pack. Supplier cartons, supplier pricing quantities, billed quantities and retail packs are not interchangeable. The UI does not perform a pack conversion or validate that saved costs use the correct basis.

## Entering costs

- Enter landed, packing, handling, customer postage, payment, channel, advertising and other variable costs for one saleable SKU unit. A cost already on that basis must not be multiplied again.
- For an order or batch charge, confirm the allocation basis before entering a per-SKU-unit amount. Unknown allocations remain unknown; a blank new cost is not zero. Enter zero only when zero is confirmed.
- For the box price helper, box quantity must be the number of saleable SKU units covered by the same box price. Keep the supplier's original carton, pricing and billed quantities in the supporting evidence; do not relabel those source quantities as retail packs.
- Fictional example: 120 physical items can make 20 retail packs of 6. If that pack is the saleable SKU unit, the corresponding helper quantity is 20. This example supplies no actual supplier price, delivery allocation, VAT treatment, fees or margin floor.
- Confirm supplier VAT rate and recovery treatment separately. No tax treatment is inferred from this guidance.
- Existing entries with an unknown basis require review before they can support decisions. Opening this guidance does not convert or rewrite them.

## Existing calculation and authority boundaries

`deriveLandedCost` in `server/lib/profit.mjs` first uses a recorded landed cost. Otherwise it uses supplier unit cost when present, or box price divided by a positive box quantity. Derived landed cost also requires known supplier delivery allocation, VAT rate and a boolean VAT recovery treatment. These inputs must already describe the saleable SKU unit; there is no additional pack multiplier.

`unitEconomics` adds the required costs once and subtracts that total from the displayed variant price once. Incomplete required costs leave contribution unknown. This is operating contribution, not statutory accounting profit.

This clarification does not alter arithmetic, saved amounts, product prices, tax settings, margin floors, validation, source attestations or financial execution authority. Source review remains a separate diagnostic annotation; guidance and cost completeness do not remove financial or action holds. See [cost-source-review.md](cost-source-review.md) and [recorded-cost-validation.md](recorded-cost-validation.md).
