# ShopCare — Product Roadmap

> Personal project of Asam Shah (Partner org *Hype Park*). A footwear brand is the
> first pilot customer, not the owner. Last updated **15-10-2026**.
>
> Related docs: [`MERCHANT-ADMIN-SPEC.md`](MERCHANT-ADMIN-SPEC.md) covers the Stage-1 repairs
> admin, which is mostly built. [`GOING-LIVE.md`](GOING-LIVE.md) is the wiring checklist.
> Spec §9 (Remix/Prisma) is out of date: the app is **Rails 8 + `shopify_app` + Polaris web
> components** (see README).

---

## 1. Vision

**Aftercare for Shopify brands: repairs, cover and trade-in on one platform.**

Brands that make durable goods (footwear first, then bags, outerwear, outdoor gear and
furniture) want to look after a product after it's sold. Today that takes one app per job,
or an ERP like Odoo that's far bigger than the job. ShopCare gives a brand:

- **Repairs:** customers request a repair, staff quote and fix it, and the customer pays
  through Shopify.
- **Cover:** a free warranty and **paid Care plans** (AppleCare-style, offered on the
  product page), both honoured as repair tickets.
- **Trade-in:** credit for items that are beyond repair, which feeds resale and repeat
  purchase.

**Why it's different:** competitors sell one of these at most, and insurance-backed
protection apps pay out to third-party repairers. ShopCare is built for brands that repair their
**own** products in their own workshop. That gives better margins, and it's the only setup
where Care plans can sit outside insurance regulation (see §7).

**Why merchants will pay:** Care plans and repairs are **revenue**, not a cost. The pitch is
"earn £X per order with Care", not "pay $Y for a ticketing tool".

---

## 2. The core idea: every product a customer owns gets one Item record

Everything hangs off one record per physical product a customer owns:

```
Buy ──► Item record created (from the order, or registered manually)
         │
         ├── Cover: warranty (free) and/or Care plan (paid), with start and end dates
         │
         ├── Repairs: tickets → quote, or £0 if covered → workshop → completed
         │
         └── End of life: trade-in offer → credit → resale
```

- **A warranty claim and a Care claim are both just a repair ticket** where the cover sets
  the price (free, discounted, or normal).
- **Registration** creates an Item for products bought outside Shopify (in a shop, from a
  stockist or as a gift). This is proof of purchase, and it brings in customers the brand
  wouldn't otherwise have.
- The Item's history (repairs, cover, trade-in) is the product's life record and could later
  become a "digital product passport".

---

## 3. Modules

### 3.1 Repairs (V1, mostly built)
Intake form via a Theme App Extension and App Proxy → ticket workbench → quotation builder →
Shopify draft order + invoice email (the invoice is the quote) → customer pays (accepts) or
declines on the review page → `orders/paid` → status sync. See MERCHANT-ADMIN-SPEC.

**Still to add:**
- Repair **services** come from the merchant's existing repair products (e.g. a "Repairs"
  collection). Each service gets a **recipe of parts** (§3.3).
- Custom line items replace the "£10/£20/… CUSTOM" placeholder-product workaround.
- Customer-facing status portal (the incumbent's biggest gap): a first **Repair status**
  block lists a logged-in customer's repairs with "Quote ready – review" / "Pay now" links.

### 3.2 Cover: warranty and Care plans (V1 warranty, V2 Care)
**Warranty (V1):** merchant-set rules for the cover period, covered faults, outcome (free
repair, discounted repair, replace or decline) and eligible products. Registration form for
purchases made outside Shopify.

**Care plans (V2), merchant-configurable through a plan builder:**

| Setting | Options |
|---|---|
| Price and billing | one-off (V2); annual or monthly renewing (later, needs Shopify subscription APIs) |
| Cover period | e.g. 12 / 24 / 36 months from purchase |
| Covered repairs | **all repairs** (no per-service choice or fair-use limits; decided 16-10-2026) |
| Excess per repair | optional, e.g. return postage |
| Exclusions | misuse, deliberate damage (always included) |
| Eligible products | collections, product types or tags |
| Bonus perks | priority turnaround, guaranteed trade-in credit |

**Guardrails the builder enforces (§7):** the brand repairs or replaces its own goods; no
theft, loss or accidental-damage cover; no cash payouts.

**Storefront flow:**
1. A product-page block offers "Add Care / No thanks" (Theme App Extension).
2. The Care product is added to the cart linked to the shoe, so it can't be bought alone and
   comes off if the shoe is removed.
3. `orders/paid` creates the Item and its Care cover, and the confirmation is sent.
4. Customers who skipped Care get an "add Care within N days" email after purchase.
5. Refunding the item automatically cancels and refunds the Care plan.
6. Claiming: the customer picks the Item, sees their cover and when it ends, and a
   £0 (plus any excess) ticket is created.

**Plan economics view:** for each plan, show attach rate, claims, and the real cost of claims
(parts + labour + postage) against plan revenue, so merchants can price from data.

### 3.3 Parts and services (V1)
A workshop parts store small enough to replace Odoo for repairs, not a full ERP. Merchants
see it as **Workshop inventory** (nav, Settings, setup), so it isn't confused with their
Shopify product inventory; the things in it are still parts.

- **Part:** name, SKU, **unit of measure** (each / pair / metre / ml / g / pack of N, with
  conversion), cost, reorder level.
- **Part variants:** a matrix of attributes such as **model × size × colour**. For example,
  outsoles come per sole model, per size and per sole colour.
- **Compatibility:** which products, ranges or sole models a part fits.
- **Service recipe:** a repair service = parts × quantities + labour minutes. Parts are
  **matched automatically** from the Item: size from the order's variant, sole model from a
  product metafield (e.g. `footwear.sole`), colour chosen by staff if needed.
- **Stock:** on-hand stock per part variant at one location in V1. Stock movements are
  received / consumed (on ticket completion) / adjusted / stock_count (set from an imported
  spreadsheet).
- **Buying:** low-stock alerts and a "parts to reorder" list with CSV export. **No purchase
  orders in V1**, because the merchant's product team buys parts themselves.
- **Margin:** each completed ticket records real parts cost plus labour against the price
  charged.
- **Later:** ERP integrations (Odoo first) for merchants whose repair parts share stock with
  production.
- **Pilot stock answers (16-10-2026):** stock is **shared with production**, there is **one
  workshop**, and the **source of truth is a spreadsheet** kept by the product team. So now:
  **CSV import / export** of parts and stock counts (Workshop inventory → Import parts; export parts and
  stock used). Later: sync with **Shopify inventory** or a **Google Sheet** instead of files.
- **Still open with the pilot:**
  - How parts arrive: units and pack sizes, checked against a real supplier invoice.
  - When parts are consumed: on accepting the quote, on starting the repair, or on completion
    (currently completion).
  - What happens when a part runs out (block the quote, warn, or allow negative stock as now).
  - Cost per part, and labour minutes per repair service.

### 3.4 Trade-in (V3)
> **Parked for V2 (16-10-2026).** V1 is repairs + warranty + Care plans. The trade-in code
> (models, services, admin, proxy endpoints, tests) stays in the app behind a per-shop flag,
> `Shop#trade_in_enabled?` (`settings["trade_in_enabled"]`, default off): with it off there's
> no Trade-ins nav item or settings section, the admin pages redirect to Tickets and the proxy
> endpoints answer `404 { ok: false, available: false }`. The theme blocks (*Trade-in offer*,
> *Trade-in request*, *Trade-in request button*) and the trade-in parts of `shopcare-pdp.js`,
> `repair-intake.js`, the request-form snippet and CSS were removed from the extension so
> merchants never see them; they live in git at `aaac133` (e.g.
> `git show aaac133:extensions/repair-intake/blocks/trade_in_offer.liquid`). The Flow trigger
> was moved to `parked/shopcare-flow-trade-in-status`, outside `extensions/`, so `shopify app
> deploy` doesn't pick it up; move it back to re-enable.

Merchant-configurable trade-in plans:
- credit rules (fixed £ per product type, or % of original price by condition grade);
- condition grading questions;
- store credit or gift card issued on receipt.

Option to **integrate** with an existing trade-in platform (e.g. Tern) before building
resale and logistics in-house. Shown on the product page like Apple's "Add a trade-in /
No trade-in".

---

## 4. Data model (additions to the Stage-1 schema)

```
Item                (shop, shopify_customer_id, email, product_id, variant_id,
                     order_id, order_line_id, purchased_at, source: order|registration,
                     attributes jsonb {size, sole_model, colour}, status)
Coverage            (item, kind: warranty|care, care_plan_id?, starts_at, ends_at,
                     status: active|expired|cancelled, usage jsonb)
WarrantyPolicy      (shop, months, covered_faults, outcome rules, eligibility)
CarePlan            (shop, name, price, billing: one_off|annual|monthly, term_months,
                     excess, perks jsonb, exclusions,
                     eligibility jsonb, shopify_product_id/variant_id, active)
Registration        (shop, item, proof_of_purchase attachment, retailer, verified_at)

RepairService       (shop, title, price, shopify_variant_id, labour_minutes, active)
Part                (shop, name, sku, unit, pack_size, cost, reorder_level)
PartVariant         (part, attributes jsonb {model, size, colour}, sku, on_hand)
ServiceComponent    (repair_service, part, quantity, match jsonb {size: :item, model: :item})
StockMovement       (part_variant, quantity, reason: received|consumed|adjusted,
                     repair_ticket_id?, note, created_by)

RepairTicket        + item_id, coverage_id   (in_warranty becomes derived from coverage)

TradeInPlan / TradeIn   (V3)
```

---

## 5. Phases

| # | Phase | What "done" looks like |
|---|---|---|
| 0 | **Housekeeping** | Repo on personal GitHub, first commit, CI green, `.gitignore` covers secrets ✅ |
| 1 | **Item + warranty** | Tickets link to Items; warranty policy settings; registration form; £0 path driven by cover rather than a flag ✅ built 15-10-2026 (needs live-store testing) |
| 2 | **Parts + services** | Parts with units and size/model/colour variants; service recipes; auto-matching; stock deducted on completion; reorder list ✅ built 15-10-2026; parts CSV import / export for the pilot's spreadsheet ✅ 16-10-2026 (§3.3) |
| 3 | **Pilot: the first merchant moves off its ERP for repairs** | The pilot workshop runs repairs entirely in ShopCare for 4+ weeks |
| 4 | **Care plans** | Plan builder; product-page block; cart linking; cover created on payment; claims; refund cancellation; plan economics view. Piloted with the first merchant ✅ built 15-10-2026 (solicitor review of terms still required before selling) |
| 6 | **Trade-in** | Trade-in plans, product-page block, credit issuance; Tern integration first ✅ built 15-10-2026 (in-house, ahead of the App Store launch; Tern integration not built). ⏸️ Parked for V2 behind a flag, 16-10-2026 (§3.4) |
| 5 → last | **App Store launch** | Shopify Billing, `read_all_orders` approved, GDPR webhooks, listing, Built for Shopify standards, solicitor-reviewed terms templates |
| later | | Renewing Care subscriptions · ERP connectors · multi-location · multi-language · status portal v2 · product passport |

---

## 6. Pricing (draft, to validate with brands)

Two-part pricing: a platform fee that grows with usage, plus a share of Care revenue.

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | Up to 10 repairs/mo, so brands can try it and leave reviews |
| Growth | $49/mo | Up to 100 repairs/mo, warranty rules and registration, branded emails |
| Pro | $149/mo | Unlimited repairs, workshop inventory, webhooks/API |
| **Care** | **+10–15% of plan sales** | Care plan builder and product-page block (any paid plan) |
| Trade-in (V3) | +$99–149/mo | Benchmark: Tern charges ~$299/mo for trade-in alone |

**Still to validate:** talk to 5+ brands that offer repairs about what they spend today on
Odoo, spreadsheets and staff time, and whether they'd accept a revenue share on Care.

---

## 7. Risks and open items

- **Care plans and insurance law (UK):** FCA guidance (PERG 6) treats a supplier's own
  repair/maintenance service for its own goods as unlikely to be insurance. Accident, theft
  or loss cover (like AppleCare+) *is* insurance. The plan builder must enforce the
  guardrails in §3.2. **Get a solicitor to review the terms templates before Phase 4.**
- **`read_all_orders`:** Shopify must approve it, otherwise customers can only see orders
  from the last 60 days. See GOING-LIVE.md.
- **Care economics:** with full repair cover, most buyers will claim a resole. Prices must
  come from real repair cost data (the Phase 3 pilot provides it).

---

## 8. Decisions log

| Date | Decision |
|---|---|
| 09-06-2026 | Lead with repairs, positioned as aftercare. Trade-in stays on Tern for now |
| 15-10-2026 | Warranty is part of the Cover module, not a separate product. V1 = repairs + warranty |
| 15-10-2026 | Add Care plans (AppleCare-style, on the product page). **Full repair cover**, plans **set by the merchant** |
| 15-10-2026 | Trade-in plans are also set by the merchant |
| 15-10-2026 | Parts live in ShopCare (not as Shopify products): units, size/model/colour variants, service recipes. No POs in V1 |
| 15-10-2026 | Fixed-term one-off Care plans first; renewing subscriptions later |
| 15-10-2026 | Personal project: personal GitHub, personal git identity |
| 15-10-2026 | Items are created for **every physical line item** on a paid order (not just eligible products), so repair history exists for everything; eligibility only decides cover. One Item per unit (qty 2 = 2 Items). Repair-quote orders, gift cards and non-shipping lines are skipped |
| 15-10-2026 | Backfill: the last 60 days on first install (and on demand from Items); older orders are imported one at a time when a customer picks them in the repair form |
| 15-10-2026 | **Several warranty policies** per shop, each filtered by all / tag / collection / product type; first active match by priority wins. Cover snapshots the terms, so editing a policy never changes existing cover |
| 15-10-2026 | Registrations are **accepted straight away** (cover starts at the stated purchase date) and flagged `unverified`; staff verify or reject (reject voids the item and cancels cover). Proof upload optional by default, can be made required in Settings |
| 15-10-2026 | Cover is a % off the whole quote (free = 100%). Staff can remove it on a ticket when the fault isn't covered. Refunds cancel the refunded units' cover |
| 15-10-2026 | Model named `Cover` (not `Coverage`, which clashes with Ruby's stdlib) |
| 15-10-2026 | Phase 2 defaults, pending the pilot merchant's answers: ShopCare owns repair stock at **one location**; stock is counted in the part's unit and received in packs; reorder level is per part and applies to each variant; stock may go negative (shown, not blocked) |
| 15-10-2026 | Recipe matching: each part option (model / size / colour) is matched "from the item", "staff choose" or "always X". Item size/colour come from variant options (names set in Settings), sole model from a product metafield; read from Shopify once per item |
| 15-10-2026 | Product renamed **Fixby → ShopCare** (app `handle` stays `fixby` so the admin URL doesn't change) |
| 15-10-2026 | Care products are **created by the merchant** in Shopify and linked to a plan (no `write_products`). Care is added as a **nested cart line** under the product, tagged `_shopcare_for`; "add Care later" lines are tagged `_shopcare_item`. Care runs from the item's purchase date |
| 15-10-2026 | When an item with Care is refunded, the merchant chooses: **refund the plan** (`write_orders`), give a **credit code** for its value usable on Care plans (move Care to another product / upgrade) or the whole store (`write_discounts`), or handle it manually |
| 15-10-2026 | Customer emails go through the merchant's tools: **Shopify Flow triggers** (which also drive Shopify Email automations) and **Klaviyo** events if connected. ShopCare sends no email itself |
| 15-10-2026 | Care pricing on quotes is per line: covered services free (within fair-use limits), the plan's perk % off everything else, excess added once per claim. Warranty stays a flat % on every line |
| 15-10-2026 | **Phase 5 (App Store launch) moves to the end**; trade-in built next |
| 15-10-2026 | Product page upsells: a **Care** block and a **Trade-in** block, both joining one Add to cart (product + Care nested line + trade-in property in a single cart add) |
| 15-10-2026 | Customers request a repair **or** a trade-in from one form, as a page block or a floating **app embed** |
| 15-10-2026 | Trade-in credit is **estimated** at request and **issued on receipt** after staff grade the item: Shopify **store credit** (default; `write_store_credit_account_transactions`) or a discount code (guests always get a code). Built in-house rather than integrating Tern |
| 16-10-2026 | **V1 = repairs + warranty + Care plans. Trade-in parked for V2** behind a per-shop flag (off by default); its theme blocks and Flow trigger are out of the deployable extension (§3.4) |
| 16-10-2026 | **Shared product groups**: the merchant defines groups once (all products, any of some collections chosen with the resource picker, any of some tags, or a product type); warranty policies and Care plans point at a group, or none for all products. Existing per-policy/plan filters were migrated to groups |
| 16-10-2026 | Settings simplified to Repairs, Care (once a plan exists), Notifications and a collapsed Advanced section. New shops get a **3-step setup** on the home page (product groups → repair services → warranty and Care), skippable, stamped `setup_completed_at` |
| 16-10-2026 | **Generated Care plan terms** (`Care::PlanTerms`): term, covered repairs and limits, excess, perks, the fixed exclusions plus the merchant's own, and always “in addition to, and does not affect, your statutory rights”. Shown as a preview on the plan form, in the product page's “What's covered” panel and frozen on each Care cover. Warranty summaries shown to customers end with the same sentence. Still needs the solicitor review (§7) |
| 16-10-2026 | **Paid quotes need the customer's decision** before anything is created in Shopify: Send quote issues a random, expiring link (Settings → Repairs, default 14 days) to a decision page in the merchant's theme (App Proxy, guests included). Accept → draft order + invoice; decline (optional reason) or expiry → ticket `quote_declined`, staff revise and re-send. £0 covered quotes skip it. Quote sent / accepted / declined go out as Flow triggers and Klaviyo events |
| 16-10-2026 | **The Shopify invoice is the quote** (supersedes the decision step above): Send quote creates the draft order and Shopify emails its invoice from the store (guests included), with the validity, "Pay to accept" and a decline link to the review page. Paying accepts (`draft → sent → paid`); decline or expiry deletes the draft order; revise deletes it and the revision gets a new one. No Flow/Klaviyo needed for the customer email; Flow triggers **Repair quote paid / declined / expired** are staff alerts (no customer reference) |
| 16-10-2026 | **Care = full repair cover**: a plan covers every repair for its term except the fixed exclusions (and the merchant's own). Per-service choice, fair-use limits and the "% off non-covered repairs" perk are gone; quotes under Care are free on every line, plus the excess once per repair. Terms read "All repairs to your <product> for <N> years, except: …". Supersedes the 15-10 per-line Care pricing |
| 16-10-2026 | Pilot stock is shared with production, one workshop, and a spreadsheet is the source of truth: **parts CSV import / export** now (preview before applying; stock counts recorded as `stock_count` movements); Shopify inventory or Google Sheets sync later (§3.3) |
| 15-10-2026 | Parts are planned from the quote's services (re-planning keeps hand-added parts) and taken from stock when the ticket moves to **completed**; the ticket stores parts + labour cost and margin (labour rate in Settings) |
