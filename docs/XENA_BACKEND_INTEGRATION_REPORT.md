# Xena Recharge Backend Integration Report

Date: 2026-07-23

Scope: Backend Phase 1 only. No frontend files were modified.

## Executive Summary

The Xena Recharge backend implementation has been audited, corrected, stabilized, and verified against the full backend suite and the mandatory financial-safety gates.

Final backend verification is green:

- Full backend suite: 20 suites passed, 650 tests passed, 0 failed.
- Focused Xena adapter tests: 5 passed.
- Dedicated Xena backend lifecycle/safety suite: 34 passed.
- Provider, fulfillment, polling, and order targeted suites passed.
- Module load passed.
- App load passed.
- `git diff --check` passed.
- No frontend files were modified.

The backend is ready for the frontend phase.

## Regression Audit

The audit reviewed the Xena integration report, the current git diff, existing provider contracts, model/service contracts, API serializers, and repeated full-suite output. Failing tests were classified before changes as implementation regressions, stale fixtures, stale assertions, or missing coverage.

Root decisions:

- Existing provider behavior had to be preserved. Cancelled/canceled provider statuses remain mapped to `FAILED` and refund behavior remains intact.
- Unknown statuses remain invalid in the shared status mapper. Xena uncertainty is isolated with provider outcome flags and does not redefine global provider behavior.
- Production adapter resolution remains strict. Mock fallback is allowed only for explicit mock/test provider identities.
- Decimal-string money values are the current intentional storage/API contract for product/order pricing. Tests were updated only after checking model setters, pricing services, and serializer behavior.
- Deposit tests were stale against the current Deposit schema and were repaired to use `paymentMethodId`, `requestedAmount`, `currency`, `exchangeRate`, `amountUsd`, and `receiptImage`.
- Direct `Order.create` fixtures with `orderNumber: null` were invalid because `orderNumber` is unique. Fixtures now use valid unique order numbers.
- Receipt analyzer tests were order-dependent after full app load because `sharp` is a real installed optional dependency. The test now mocks the actual module deterministically instead of registering a virtual mock.

## Root Causes And Resolutions By Suite

`audit.test.js`:

- Cause: stale refund metadata assertion and a login-blocked fixture that no longer produced the blocked status under the current user model.
- Resolution: asserted current `totalRefund` audit metadata and set the PENDING login fixture explicitly.

`fulfillment.test.js`:

- Cause: invalid direct order fixture with duplicate null order numbers, stale automatic-order status expectation, and numeric money assertion.
- Resolution: added valid unique order numbers, kept current automatic order contract as `PROCESSING`, and asserted decimal-string `totalPrice`.

`deposit.test.js`:

- Cause: stale deposit fixtures used removed fields and missed current required schema fields.
- Resolution: fixtures now use the current Deposit schema. Approval override assertions were updated to the current object contract and audit metadata.

`order.test.js`, `catalog.test.js`, `currency.test.js`, `pricing.test.js`, `group.test.js`:

- Cause: stale numeric expectations conflicted with the confirmed decimal-string financial contract.
- Resolution: assertions now verify exact decimal strings where the model/service contract stores normalized strings. Pricing validation was also corrected to reject null, empty, negative, and non-finite inputs while preserving Decimal.js arithmetic.

`orderPolling.test.js`:

- Cause: invalid direct order fixtures with duplicate null order numbers.
- Resolution: fixtures now provide valid unique order numbers.

`admin.test.js`:

- Cause: stale wallet response shape expectation.
- Resolution: assertion now matches the current `{ user, recentTransactions }` wallet service response.

`targetApps.test.js`:

- Cause: test mock omitted the real notification export used by target-app order flow.
- Resolution: mock now includes `notifyNewTargetOrder`, matching the production notification module surface without hiding integration errors.

`receiptAnalyzer.test.js`:

- Cause: order-dependent native dependency mocking. After a full app load, virtual `sharp` mocks no longer reliably intercepted the installed module.
- Resolution: mocked the real `sharp` module name directly and retained the existing assertions.

`adapters.test.js` and `provider.test.js`:

- Cause: Xena changes exposed adapter contract drift, price DTO type drift, and unsafe global status mapping changes.
- Resolution: restored Toros/Alkasr behavior, preserved shared cancelled/unknown status semantics, kept strict production adapter resolution, and verified provider DTOs can enter sync/pricing safely.

## Fixes Applied

Status mapping compatibility:

- `cancelled`, `canceled`, `cancel`, `failed`, `reject`, `rejected`, and `error` map to `FAILED`.
- Unknown shared provider statuses throw.
- Xena unknown/ambiguous outcomes remain isolated through uncertainty flags.

Strict adapter resolution:

- Production fulfillment, polling, sync, and admin paths use strict adapter resolution.
- Unsupported providers throw `UNSUPPORTED_PROVIDER`.
- Mock adapter resolution is limited to explicit mock/test provider identities.

Monetary validation:

- Xena `unitPrice` uses Decimal.js and accepts positive finite decimals such as `0.00001`.
- `minAmount`, `maxAmount`, and order quantity remain safe integers.
- `maxAmount` must be greater than or equal to `minAmount`.
- Pricing now rejects missing, empty, negative, and non-finite values.
- Decimal multiplication/division stays in Decimal.js for final pricing.

Xena uncertainty state machine:

- Succeeded: `COMPLETED`, no refund.
- Processing: `PROCESSING`, poll by `providerOrderId`.
- Failed: `FAILED`, refund exactly once through the existing refund idempotency path.
- Unknown with provider order id: `PROCESSING` with uncertainty, no refund.
- Timeout/429/ambiguous 502 without provider order id: retry the same idempotent POST, no refund.
- Repeated uncertainty past retry limit: `MANUAL_REVIEW`, no automatic refund.
- 409 idempotency body mismatch: `MANUAL_REVIEW`, no new key/body, no automatic refund.

Credentials:

- New provider credential writes are encrypted.
- Existing encrypted credentials remain readable.
- Existing plaintext credentials remain readable for migration compatibility.
- Blank credential updates preserve existing credentials.
- Serializers redact credential values.
- Canonical env var: `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`.
- Backward-compatible alias: `PROVIDER_CREDENTIALS_KEY`.

Locking and concurrency:

- Mongo-backed leases using `fulfillmentLockUntil` and `fulfillmentLockOwner` protect fulfillment workers sharing the same MongoDB.
- Active leases block competing workers.
- Expired leases can be reclaimed.
- Lease release is safe after success and handled failure.
- Concurrent Xena execution/status races do not duplicate logical recharges or refunds.
- Limitation: multi-datacenter guarantees depend on a single authoritative Mongo primary/replica-set write path and acceptable clock discipline.

## Tests Added

Added and expanded `src/tests/xenaBackend.test.js` for:

- Credential encryption, migration compatibility, blank update preservation, and serializer redaction.
- Challenge success, reconnect challenge, invalid challenge input, challenge 401/409/429/502.
- Verify success, invalid code, expired code.
- Connection statuses: pending, verification required, connected, reauthentication required, disabled.
- Password/code/credential non-persistence and response redaction.
- Only connected providers enabling fulfillment.
- Product config validation and exact synthetic product sync.
- Target verification before wallet debit/order creation with call-order proof.
- Stable idempotency key, client reference, and immutable request body across retries.
- Processing with and without provider order id.
- Processing/unknown transitions to succeeded, failed, repeated unknown to manual review.
- Timeout/429/ambiguous 502 retrying the same placement identity.
- Polling timeout/429/502 preserving state.
- Refund-once behavior and no refunds for unknown/timeout/429/502/manual-review uncertainty.
- Fulfillment leases and admin/cron race safety.
- Bounded Xena polling concurrency.

## Legacy Tests Changed With Justification

Deposit tests:

- Old expectation: legacy fields such as `amountRequested`, `transferImageUrl`, and `transferredFromNumber`.
- Current contract: Deposit schema requires `paymentMethodId`, `requestedAmount`, `currency`, `exchangeRate`, `amountUsd`, and `receiptImage`.
- Justification: stale fixtures; model/service/API contract confirmed.
- API impact: tests now match current backend contract.

Decimal money tests:

- Old expectation: raw numbers for stored product/order/pricing fields.
- Current contract: normalized decimal strings for financial fields.
- Justification: decimal-string storage preserves precision and matches model setters/services.
- API impact: no new drift introduced; tests assert the existing contract exactly.

Order fixture tests:

- Old fixture: direct `Order.create` with `orderNumber: null`.
- Current contract: `orderNumber` is unique and should be generated or set uniquely.
- Justification: invalid test data caused duplicate key failures.
- API impact: none.

Admin/audit tests:

- Old expectation: stale wallet/audit shapes.
- Current contract: wallet service returns `{ user, recentTransactions }`; refund audit metadata uses `totalRefund`.
- Justification: assertions were stale after service evolution.
- API impact: tests now verify the current response contract.

Target-app notification test:

- Old mock: missing `notifyNewTargetOrder`.
- Current contract: notification module exports and target-app flow uses `notifyNewTargetOrder`.
- Justification: mock mismatch, not production behavior.
- API impact: none.

Receipt analyzer test:

- Old mock: virtual `sharp` mock.
- Current contract: `sharp` is installed and optional at service load.
- Justification: order-dependent test isolation issue.
- API impact: none.

## Commands Executed

- `npm.cmd run lint`
  - Result: failed because `package.json` has no `lint` script. This is a repository script gap, not a code/test failure.
- `npm.cmd test -- --runTestsByPath src/tests/adapters.test.js -t XenaRechargeAdapter --silent`
  - Result: passed. 1 suite passed; 5 tests passed; 94 skipped.
- `npm.cmd test -- --runTestsByPath src/tests/provider.test.js --silent`
  - Result: passed. 1 suite passed; 56 tests passed.
- `npm.cmd test -- --runTestsByPath src/tests/xenaBackend.test.js --silent`
  - Result: passed. 1 suite passed; 34 tests passed.
- `npm.cmd test -- --runTestsByPath src/tests/fulfillment.test.js src/tests/orderPolling.test.js src/tests/order.test.js --silent`
  - Result: passed. 3 suites passed; 73 tests passed.
- `npm.cmd test -- --runInBand --silent`
  - Result: passed. 20 suites passed; 650 tests passed; 0 failed.
- Module load with test `MONGO_URI` and `JWT_SECRET`
  - Result: passed.
- App load with test `MONGO_URI` and `JWT_SECRET`
  - Result: passed. Emits existing duplicate Mongoose `slug` index warning.
- `git diff --check`
  - Result: passed. Git emitted only checkout line-ending warnings and an unrelated safe.directory warning.

## Exact Test Results

Final full suite:

- Test Suites: 20 passed, 20 total.
- Tests: 650 passed, 650 total.
- Snapshots: 0 total.
- Time: 125.732 s.

Focused Xena adapter suite:

- Test Suites: 1 passed, 1 total.
- Tests: 5 passed, 94 skipped, 99 total.

Dedicated Xena backend suite:

- Test Suites: 1 passed, 1 total.
- Tests: 34 passed, 34 total.

Provider suite:

- Test Suites: 1 passed, 1 total.
- Tests: 56 passed, 56 total.

Fulfillment/order/polling targeted run:

- Test Suites: 3 passed, 3 total.
- Tests: 73 passed, 73 total.

## Security Verification

- No automated test calls the live Digiteech API; Xena HTTP behavior is mocked/faked.
- Xena passwords and verification codes are not persisted.
- Connection responses do not expose credentials.
- Provider serializers redact secret fields.
- Blank provider credential updates preserve encrypted stored credentials.
- Existing plaintext credentials remain readable only for migration compatibility.
- Audit metadata redacts password/code/credential fields.
- No frontend files were modified.

## Financial Safety Verification

- Xena target verification is proven to occur before wallet debit.
- Invalid UID, missing target, timeout, 429, 502, and disconnected provider paths block debit and order creation where applicable.
- Stable idempotency key, client reference, connection id, target UID, amount, and request body are reused across retries.
- Timeout, 429, ambiguous 502, unknown, and manual-review uncertainty never refund automatically.
- Definite failed Xena outcomes refund exactly once.
- Repeated failed polling and cron/admin races do not double refund.
- Processing and unknown Xena outcomes can later complete or fail safely.
- Repeated unknown reaches `MANUAL_REVIEW` without refund.
- Simultaneous fulfillment does not create duplicate logical Xena recharges.
- Polling concurrency is bounded.
- Synthetic Xena product sync creates exactly one provider product.
- Decimal unit prices including `0.00001` are accepted and safely represented.

## Remaining Warnings And Limitations

- `npm run lint` is unavailable because no lint script exists.
- App/module load emits an existing duplicate Mongoose `slug` index warning.
- Jest still runs with the repository's existing `--forceExit` test script and prints the standard open-handle suggestion.
- `git diff --check` emits CRLF checkout warnings in this Windows working tree and an unrelated safe.directory warning, but no whitespace errors.
- Mongo leases protect workers sharing the same MongoDB deployment; multi-datacenter behavior requires a single authoritative Mongo write path and clock discipline.

## Manual Xena Sandbox Verification Checklist

- Configure a sandbox Xena provider with encrypted credentials.
- Start challenge and confirm no password is stored or returned.
- Verify challenge using the backend-stored connection id.
- Confirm only `connected` status enables fulfillment.
- Sync products and confirm exactly one synthetic Xena provider product.
- Verify a valid Xena UID before order creation.
- Attempt invalid UID, timeout, 429, and 502 verification responses and confirm no wallet debit.
- Place a sandbox recharge and capture stable idempotency key/client reference.
- Retry timeout/429/502 cases and confirm identical request body/key.
- Poll succeeded, failed, processing, and unknown outcomes.
- Confirm failed outcomes refund once.
- Confirm unknown/repeated uncertain outcomes reach manual review without refund.
- Run two workers against the same MongoDB and confirm no duplicate Xena recharge or refund.

READY FOR FRONTEND PHASE
