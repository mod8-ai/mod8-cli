# Proxy billing contract

The CLI (`mod8 topup`, `mod8 balance`, `/topup`, `/balance`,
low-balance nudge) talks to two new proxy endpoints. The proxy team
owns the Stripe integration — the CLI never sees a Stripe key.

All endpoints use `Authorization: Bearer <sk-mod8-...>` (same scheme as
`/v1/chat`).

---

## `GET /v1/me`

Returns the authenticated user's email + current credit balance.

**Response 200**

```json
{
  "email": "user@example.com",
  "availableMicros": 4287000
}
```

- `email` — optional. Shown next to the balance in `mod8 balance`.
- `availableMicros` — integer. $1.00 = 1_000_000 micros. Required.

**Response 401** — bearer token rejected. CLI tells user to re-login.

**Response 404 / 501** — endpoint not deployed yet. CLI tells user the
proxy needs to be upgraded; BYOK still works.

---

## `POST /v1/billing/checkout`

Creates a Stripe Checkout session for the requested top-up amount.

**Request**

```json
{ "amountUsd": 50 }
```

- `amountUsd` — integer dollars. Minimum 5. The CLI enforces this
  client-side too, but the server should re-validate.

**Response 200**

```json
{
  "url": "https://checkout.stripe.com/c/pay/cs_test_a1b2c3...",
  "sessionId": "cs_test_a1b2c3..."
}
```

- `url` — the Checkout URL. The CLI opens this in the user's browser.
- `sessionId` — the Stripe session id. Returned for debugging/support
  but not currently displayed.

**Response 401** — bearer token rejected.

**Response 404 / 501** — endpoint not deployed yet. Surfaced cleanly.

---

## Stripe webhook (proxy-side, no CLI involvement)

When Stripe fires `checkout.session.completed`, credit the user's
account by `amountUsd * 1_000_000` micros. From then on `GET /v1/me`
returns the new balance and `done` SSE events on `/v1/chat` include the
post-charge balance via `balanceAfterMicros` (see `proxy.ts` wire
format).

The 15% markup is applied **at chat time** in `chargedMicros`, not at
top-up time. So if a user pays $100, they get exactly $100 of credit;
mod8's margin comes from the markup on each `/v1/chat` call.

---

## SSE addition (already wired in the CLI as of 0.5.30)

The `done` event on `/v1/chat` already includes `balanceAfterMicros`
when the request was proxy-charged. The CLI now reads that value into
`StreamUsage.balanceAfterMicros` and uses it for the in-REPL low-balance
nudge. No change needed on the proxy if you already emit this field.

---

## Test plan (proxy side)

1. `GET /v1/me` without bearer → 401.
2. `GET /v1/me` with valid bearer for new user → balance 0.
3. `POST /v1/billing/checkout` with `amountUsd=50` → returns a usable
   Stripe Checkout URL.
4. Pay with Stripe test card `4242 4242 4242 4242` → webhook credits
   the account → next `GET /v1/me` returns balance 50_000_000.
5. Run `mod8 'hi'` proxied → `done` event includes
   `balanceAfterMicros` reflecting the charge.
