# Brand One Card

This supplier (`api.brand-one-card.com`) has its own `BrandOneCardAdapter`.
The existing `brand1-card` supplier continues to use `AlkasrVipAdapter`.

Create a provider through the existing admin provider API with:

```json
{
  "name": "Brand One Card",
  "slug": "brand-one-card",
  "adapterType": "brand-one-card",
  "baseUrl": "https://api.brand-one-card.com",
  "apiToken": "YOUR_API_TOKEN"
}
```

Allow the backend server's outbound IP in the supplier account. Set the account
currency to USD: platform product costs use USD, so catalogue sync rejects products
that explicitly declare another currency. No currency conversion is performed.

Sync the catalogue using the existing provider sync flow. `qty_values: null` maps
to a minimum and maximum of 1. The original `product_type`, `currency`, `params`,
`params_info` and category metadata remain in the provider product's `rawPayload`.
Configure platform product `orderFields` and `providerMapping` from the supplier's
parameter names (for example `playerId` or `serverId`). Products without customer
parameters are supported. The platform multiplies product unit price by quantity;
fixed-price package products therefore sync with minimum and maximum quantity 1.

Placement uses GET `/client/api/newOrder/{id}/params` with the platform's stable
`referenceId` as `order_uuid`. This reference must stay identical on retries.
If invoking the adapter directly, provide `referenceId` (or `order_uuid`,
`orderUuid`, `orderId`). No fresh random reference is generated per attempt.
HTTP 200 `status: ERROR` means no order was charged. Transport failures or malformed
placement replies trigger UUID lookup; unresolved results stay processing for
the existing fulfillment poller to recover with `checkOrderByReference`.

The integration uses status polling (`checkOrder` / `checkOrders`). No webhook
receiver is added; leave the supplier webhook URL empty for this integration.
`getContent(categoryId)` exposes category browsing, with 0 as the default root.

Supplier limits are 300 requests/minute/IP overall and 120 new orders/minute/IP.
The adapter adds no automatic placement retry loop. Size sync/polling schedules
and order throughput to fit those limits.
