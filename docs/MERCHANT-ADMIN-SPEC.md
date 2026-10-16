# Repairs App — Merchant Admin Spec (Stage 1)

> Working repo name `repairs-app` — product name TBD.
> This spec covers the **merchant-facing embedded admin**: the surface that replaces
> the ERP helpdesk UI the pilot merchant's workshop uses today, plus the manual quotation step.
> The customer-facing intake form and the Shopify payment/webhook chain already exist
> (see "Reuse" below) and are out of scope to rebuild.

## 1. What this replaces

In the pilot merchant's current setup, the ERP (Odoo) plays four roles. Stage 1 replaces all four with our own
backend + admin, while **keeping the entire Shopify payment half** that already works:

| Odoo role | Models | Replacement |
|---|---|---|
| Ticketing + staff UI | `helpdesk.ticket/team/stage`, chatter, `ir.attachment` | **This admin app + our DB** |
| Quoting / pricing (manual in Odoo) | `sale.order`, `sale.order.line` | **Quotation builder (this app)** |
| CRM | `res.partner` | Derived from Shopify customer |
| Order state | `sale.order.action_confirm` | Shopify draft-order lifecycle (already built) |

**Removing Odoo also removes a moving part:** the old `quotation-webhook` round-trip
(Odoo → middleware → Shopify draft order) disappears. The quote is built in *this* admin
and creates the Shopify draft order directly.

## 2. Reuse (already built, do not rebuild)

From the pilot's original middleware (`lib/shopify.js`, `api/shopify-webhook.js`) and the theme form:

- ✅ Customer intake form (theme) → repackage as **Theme App Extension** (App Embed block)
- ✅ `createDraftOrder` / `sendDraftOrderInvoice` / `completeDraftOrder`
- ✅ `orders/paid` webhook → confirm + status sync (HMAC verification already correct)
- ✅ Customer metafield status sync (`requested` → `paid`)

The new admin's "Send Quote" button calls the *existing* `createDraftOrder` + invoice logic.

## 3. Data model

```
Shop                      (one per installed merchant)
  id, shopify_domain, access_token (offline OAuth), scopes,
  plan, settings:jsonb, installed_at, uninstalled_at

RepairTicket
  id, shop_id → Shop
  shopify_customer_id, customer_email, customer_name, customer_phone,
  customer_address:jsonb
  product_id, variant_id, product_title, variant_title,
  order_number, order_date, in_warranty:bool, no_order_history:bool
  description:text
  status:enum (see §4)
  assigned_to:nullable (Shopify staff name/id)
  created_at, updated_at

TicketImage
  id, ticket_id → RepairTicket
  url, filename, mimetype, uploaded_at
  # store in object storage (S3 / Shopify Files), NOT base64 in DB
  # — fixes the incumbent's "upload limit" complaints

Quotation
  id, ticket_id → RepairTicket
  status:enum (draft | sent | paid | declined | expired | cancelled)
  currency, subtotal
  shopify_draft_order_id, shopify_draft_order_url, shopify_order_id
  decision_token (encrypted) + decision_token_digest, decision_expires_at,
  decided_at, decided_by, decision_reason, revised_from_id
  sent_at, paid_at, created_at

QuotationLineItem
  id, quotation_id → Quotation
  title, quantity, unit_price, discount

RepairService            (per-merchant catalogue of common repairs — quick-add for quotes)
  id, shop_id → Shop
  name, default_price, active
  # product improvement over Odoo's manual line entry

TicketActivity           (replaces Odoo chatter)
  id, ticket_id → RepairTicket
  type:enum (note | status_change | quote_sent | quote_decision | payment | system)
  body, author:enum (staff | system | customer), created_at
```

## 4. Status pipeline (state machine)

```
new ──▶ assessing ──▶ quoted ──▶ in_repair ──▶ ready ──▶ completed
  │          ▲          │
  │          └── quote_declined (revise → assessing)
  └────────────────▶ cancelled / rejected
```

Quotation (the Shopify invoice is the quote; paying it is accepting it):

```
draft ──Send quote──▶ sent ──invoice paid (orders/paid)──▶ paid
  │   (draft order +    │
  │    invoice emailed) ├──Decline on the review page──▶ declined ─┐ draft order deleted;
  │                     ├──not paid in time──────────▶ expired  ─┤ staff Revise → new draft
  │                     └──ticket cancelled / revised─▶ cancelled ┘ (or Resend an expired one)
  └──£0 covered quote: draft order completed────────▶ paid
```

"In time" is Settings → Repairs → "Quotes valid for" (default 14 days). Declining,
expiry, revising and cancelling all delete the Shopify draft order, so its invoice
link stops working; sending again creates a new one.

- `new` — submitted via intake form, awaiting review
- `assessing` — staff reviewing photos/description
- `quoted` — quote sent: Shopify emailed its invoice; paying it accepts the quote
- `quote_declined` — the customer declined the quote (optional reason) or it expired unpaid; staff revise and re-send
- `in_repair` — payment received (via `orders/paid` webhook), repair underway
- `ready` — repaired, ready to ship / collect
- `completed` — shipped/collected, closed
- `cancelled` / `rejected` — terminal

**Warranty path:** a £0 quote skips payment — auto-completes the draft order (existing
`completeDraftOrder`) and moves ticket straight `quoted → in_repair`, no customer email.

**Customer-facing metafield mapping** (existing sync): `quoted/in_repair → "requested"`,
payment → `"paid"`. Extend to surface full status in the customer portal later.

## 5. Screens

### 5.1 Tickets list (home)
- Table: ID · customer · product · status badge · warranty flag · date · quote value
- Filters: status, warranty/paid, date range; free-text search (customer/order/product)
- Sort: newest, status, value
- Row click → Ticket detail

### 5.2 Ticket detail (the workbench — core screen)
- **Left panel (read):** customer (name/email/phone/address), product + variant,
  order number/date, warranty flag, "no order history" note, **photo gallery** (lightbox)
- **Main panel:**
  - Status control (advance/override pipeline)
  - **Quotation builder** (§5.3)
  - **Activity log** (notes + system events); add-note input
  - Assignee selector
- Actions: change status · build/send quote · add note · assign · cancel

### 5.3 Quotation builder (critical path — replaces manual Odoo quote)
- Add line items: title, qty, unit price, discount% — or **quick-add from RepairService catalogue**
- Live subtotal in shop currency
- "Mark as warranty (£0)" toggle → auto-complete path
- **Send Quote** (paid quote) → the Shopify invoice is the quote:
  1. lock + recalculate; a random review link (`/apps/repairs/quotes/:token`, App Proxy,
     works for guests) and an expiry
  2. create the draft order (or update a reused one) and `sendDraftOrderInvoice`: Shopify
     emails it from the store, subject "Your repair quote from <shop>", message = the
     merchant's intro, the repair, the cover terms, "This quote is valid until <date>",
     "Pay to accept and we'll start your repair" and "Don't want to go ahead? Decline here:
     <review link>". No Flow / Klaviyo needed for the customer email.
  3. quotation → `sent`, ticket → `quoted`; log `quote_sent`; outbound webhook
  4. the **review page** shows the lines, total, expiry, **Pay now** (the invoice) and
     **Decline** (optional reason) → `declined`, ticket → `quote_declined`, draft order
     deleted. Unpaid past its expiry → `expired` the same way (daily job, or when opened).
- **Send Quote** (£0, warranty / Care) → `createDraftOrder` + `completeDraftOrder`, ticket → `in_repair`
- Ticket shows what happened, dates and reason, plus **Resend invoice** (sent or expired;
  an expired quote reopens with a new draft order) and **Revise quote** (new draft from the
  last one; the old draft order is deleted)
- After payment (`orders/paid` webhook): paying accepts — quotation `sent → paid` in one
  step (cover claim counted), ticket → `in_repair`, metafield → `paid`, `payment` activity
  logged, `quote_paid` staff alert
- Staff alerts: Flow triggers **Repair quote paid / declined / expired** (no customer
  reference, so guests too) for a "Send internal email" workflow; Klaviyo events optional

### 5.3a Repair services
- Own nav item, right after Tickets. Lists the repair services (Shopify products in the
  repair collection or with the repair tag): **Import from a collection** (resource picker;
  remembers the collection) or **Sync from Shopify**. Edit a service: active, and — with workshop
  inventory on — its labour time, recipe of parts and cost per repair.

### 5.3b Workshop inventory (optional)
- Merchant-facing name for parts and stock: the parts and materials the workshop uses for
  repairs, separate from the Shopify product inventory (named so merchants don't confuse the
  two). Inside it the things are still **parts**; code, tables, routes (`/parts`) and the
  `parts_enabled` setting keep their names.
- Off for new shops; **Settings → Workshop inventory → “Track workshop inventory”** (helper:
  “Parts and materials your workshop uses for repairs. Separate from your Shopify product
  inventory.”), or the optional “Also track workshop inventory” checkbox on setup step 3. Shops
  that already had parts were switched on by migration.
- Off: no Workshop inventory nav item (parts URLs redirect to Tickets), no Parts section or part planning on
  tickets, no recipes on services, nothing taken from stock on completion, and the labour rate /
  option names / **Model metafield** fields are hidden. On: everything as before, with those
  fields in the Workshop inventory section (no longer under Advanced).
- **Model metafield** (was “Sole model metafield”): `namespace.key` of a product metafield naming
  the model a part must fit. Stored as `parts.model_metafield`; the old `sole_model_metafield`
  key is copied by migration and still read as a fallback.
- **Import parts** (Workshop inventory → Import parts, `/parts/imports/new`): for a pilot whose parts list
  lives in a spreadsheet. Upload a CSV (UTF-8 or Excel; byte-order mark, semicolons and decimal
  commas are fine; up to 2 MB and 5,000 rows); **Download template** (`workshop-inventory-template.csv`) gives the columns, one row
  per variant:

  | Column | Meaning |
  |---|---|
  | `part_name` | Needed for a new part |
  | `part_sku` | Parts match on it, else on name (a part with no SKU yet) |
  | `unit` | each, pair, metre, ml or g |
  | `pack_size` | Units per purchased pack (> 0) |
  | `cost_per_unit`, `reorder_level`, `reorder_quantity` | Numbers ≥ 0 |
  | `model`, `size`, `colour` | The variant's options; blank for a part with no variants. An existing part's options can't change here |
  | `variant_sku` | Variants match on it, else on their options |
  | `on_hand` | Stock count, in the part's unit; blank = not counted |

  Two modes: **Add or update parts only** (stock untouched) and **Also set stock counts from this
  file** (on-hand becomes the file's value; the difference is a `stock_count` stock movement, so
  the history stays). Blank part fields leave what's saved. The **preview** shows parts and
  variants to create / update, each stock change (now → file) and every row error (unknown
  unit, not a number, an option the part doesn't have, a duplicate row or SKU, an ambiguous
  name); nothing is written until **Import** is pressed, and a file with errors can't be applied.
  Applying re-checks the file against the parts as they are then and writes it in one
  transaction. Uploads are kept (`part_imports`) as a record of what was applied.
- **Export parts** (`workshop-inventory-<date>.csv`: same columns, today's on-hand; imports back
  unchanged) and **Export stock used** (`workshop-inventory-used-<from>-to-<to>.csv`: date, part,
  variant, SKUs, quantity, unit, reason, ticket, note for every movement between two dates,
  default the last 30 days), on the same page. The reorder list downloads
  as `workshop-inventory-reorder-<date>.csv`.

### 5.4 Settings
- **Warranty rules:** warranty window, "£0 = warranty" toggle, warranty order tag (was a hardcoded tag)
- **Eligibility:** eligible product types / collections / tags (replaces the theme's hardcoded
  keyword list — `repair-form-products.liquid:52-93`)
- **Repair service catalogue:** CRUD `RepairService` rows
- **Email branding:** subject + body copy for the invoice sent once a quote is accepted (was hardcoded to one brand)
- **Intake form options:** max images, products shown initially
- **Integrations (optional):** outbound webhook on ticket events (generalises a hardcoded
  automation URL — `repair.js:647`)

### 5.5 Onboarding / install
- Standard Shopify OAuth app install (multi-tenant — replaces single-store client-credentials)
- Register `orders/paid` webhook
- Guide to add the Theme App Extension block to the repair page

## 6. Endpoints (absorbed into the app)

| Old middleware route | New |
|---|---|
| `POST /api/repair` (intake) | App Proxy route (signed per-shop) → writes `RepairTicket` |
| — (new) | `GET /proxy/orders`: the logged-in customer's products, cover and open repairs |
| — (new) | `GET /proxy/catalog_search?q=`: name / SKU search of active, published products (public facts only) |
| — (new) | `POST /proxy/order_lookup`: an order by number — guests also give its email; logged-in customers only their own |

**Storefront request form** (extensions/repair-intake/README.md): logged out → *Log in to see
your orders* or *Continue without an account*; logged in → profile + product cards with their
cover (Care / warranty, with its end date, or no cover) and any open repair (blocks a second
request); everyone → *Find the product you bought* (name, SKU or order number) or describe it;
then the issue, details, and a confirmation with a status tracker. The intake re-verifies the
chosen item (the customer's own items, or the signed token from a guest's order lookup) and
refuses unverifiable items and duplicates of an open repair. A catalogue pick is an unverified
purchase (no cover; logged on the ticket). Catalogue search and order lookup are rate-limited
per shop + visitor IP and per shop; every lookup miss is the same “not found”.
| `POST /api/quotation-webhook` | **removed** — quote built in admin, creates draft order directly |
| `POST /api/shopify-webhook` (orders/paid) | App webhook handler → status sync |

## 7. Multi-tenancy / productisation gaps to close (from middleware audit)

- **Auth:** single-store Client-Credentials → standard **OAuth app install** + per-merchant token storage
- **Intake security:** CORS-only → **signed App Proxy** (provably from the shop)
- **Strip merchant specifics:** hardcoded automation webhook, warranty tag, £0-warranty heuristic, brand email copy → all merchant settings
- **Protected customer data:** flow reads order history + customer PII → needs Shopify protected-data approval

## 8. Out of scope for Stage 1
- Customer-facing status portal (the #1 incumbent gap) — adjacent Theme App Extension, build next
- Multi-language (Stage 1.5 — incumbent's other big gap)
- Trade-in / warranty-registration pillars (Stage 3 — keep Tern for trade-in)
- Analytics dashboard

## 9. Suggested stack
- Shopify **Remix app template** (official) + **Polaris** (admin UI)
- **Prisma + Postgres**
- Port `lib/shopify.js` into the app's services
- Object storage for images (S3 or Shopify Files)
- Deploy Vercel / Fly

## 10. Stage-1 effort
| Workstream | Effort |
|---|---|
| Ticket DB + App Proxy intake | S–M |
| Shopify draft-order/payment/webhook chain (port existing) | ~free |
| **Merchant admin (workbench + quotation builder)** | **L — critical path** |
| Multi-tenant OAuth + settings | M |
| Theme form → Theme App Extension | S |

The dominant cost is the admin — because Odoo *was* the admin. Everything else is extraction
or already built.
