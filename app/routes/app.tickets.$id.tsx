import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import { selectedIf } from "../components/attrs";
import { DownloadButton } from "../components/download-button";
import { parseId, requireAdmin } from "../services/admin/context.server";
import { type Flash, redirectWithFlash } from "../services/admin/flash.server";
import { field, parse, readForm, zDecimal, zOptionalId, zText } from "../services/admin/form.server";
import {
  addLineItem,
  addNote,
  addTicketPart,
  declineTicketQuote,
  linkTicketItem,
  markTicketReceived,
  planParts,
  removeLineItem,
  removeTicketPart,
  resendTicketInvoice,
  resendTicketPostageEmail,
  reviseTicketQuote,
  sendTicketQuote,
  ticketDetail,
  updateQuoteCover,
  updateStatus,
  updateTicketPart,
} from "../services/admin/tickets.server";

// GET /app/tickets/:id — the ticket detail workbench (Rails TicketsController#show).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop, admin } = await requireAdmin(request);
  return ticketDetail(shop, admin, parseId(params.id));
};

const INTENTS = [
  "status", "note", "link_item", "add_line", "remove_line", "send", "resend", "revise", "decline", "cover",
  "plan_parts", "add_part", "update_part", "remove_part", "mark_received", "resend_postage",
] as const;

const zQuantity = z
  .string()
  .trim()
  .transform((v) => (v === "" ? "1" : v))
  .pipe(z.string().regex(/^\d{1,6}$/, "must be a whole number"))
  .transform(Number);

// Every action on a ticket, by `intent` (Rails tickets/quotations/line_items/ticket_parts actions).
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop, admin } = await requireAdmin(request);
  const id = parseId(params.id);
  const form = await readForm(request);
  const intent = parse(z.enum(INTENTS), field(form, "intent"));
  const f = (name: string) => field(form, name);
  let flash: Flash;

  switch (intent) {
    case "status":
      flash = await updateStatus(shop, id, parse(zText(40), f("status")));
      break;
    case "note":
      flash = await addNote(shop, id, parse(zText(10_000), f("body")));
      break;
    case "link_item":
      flash = await linkTicketItem(shop, id, parse(zOptionalId, f("item_id")));
      break;
    case "add_line": {
      const input = parse(
        z.object({
          kind: z.enum(["repair", "extra"]).catch("extra"),
          variantId: z.string().trim().regex(/^\d{0,20}$/),
          title: zText(255),
          quantity: zQuantity,
          unitPrice: zDecimal,
          discount: zDecimal,
        }),
        {
          kind: f("kind"),
          variantId: f("shopify_variant_id"),
          title: f("title"),
          quantity: f("quantity"),
          unitPrice: f("unit_price"),
          discount: f("discount"),
        },
      );
      flash = await addLineItem(shop, admin, id, { ...input, variantId: input.variantId || null });
      break;
    }
    case "remove_line":
      flash = await removeLineItem(shop, id, parseId(f("line_id")));
      break;
    case "send":
      flash = await sendTicketQuote(shop, id);
      break;
    case "resend":
      flash = await resendTicketInvoice(shop, id);
      break;
    case "revise":
      flash = await reviseTicketQuote(shop, id);
      break;
    case "decline":
      flash = await declineTicketQuote(shop, id, parse(zText(1000), f("reason")));
      break;
    case "cover":
      flash = await updateQuoteCover(shop, id, f("apply") === "1");
      break;
    case "plan_parts":
      flash = await planParts(shop, admin, id);
      break;
    case "add_part":
      flash = await addTicketPart(shop, id, {
        partId: parseId(f("part_id")),
        variantId: parse(zOptionalId, f("part_variant_id")),
        quantity: parse(zDecimal, f("quantity")),
      });
      break;
    case "update_part":
      flash = await updateTicketPart(shop, id, parseId(f("ticket_part_id")), {
        variantId: parse(zOptionalId, f("part_variant_id")),
        quantity: parse(zDecimal, f("quantity")),
      });
      break;
    case "remove_part":
      flash = await removeTicketPart(shop, id, parseId(f("ticket_part_id")));
      break;
    case "mark_received":
      flash = await markTicketReceived(shop, id);
      break;
    case "resend_postage":
      flash = await resendTicketPostageEmail(shop, id);
      break;
  }
  return redirectWithFlash(`/app/tickets/${id}`, flash);
};

function Intent({ value }: { value: string }) {
  return <input type="hidden" name="intent" value={value} />;
}

export default function Ticket() {
  const d = useLoaderData<typeof loader>();
  const { ticket, quotation } = d;

  return (
    <s-page heading={`Ticket #${ticket.id}`}>
      <s-link slot="breadcrumb-actions" href="/app/tickets">
        Tickets
      </s-link>
      <s-badge slot="accessory" tone={ticket.tone}>
        {ticket.statusLabel}
      </s-badge>
      {ticket.coverName ? (
        <s-badge slot="accessory" tone="info">
          {ticket.coverName}
        </s-badge>
      ) : ticket.inWarranty ? (
        <s-badge slot="accessory" tone="info">
          Warranty
        </s-badge>
      ) : null}

      <s-grid grid-template-columns="2fr 1fr" gap="base">
        <s-stack direction="block" gap="base">
          <s-section heading="Status">
            <Form method="post">
              <Intent value="status" />
              <s-stack direction="inline" gap="small-200" align-items="end">
                <s-select label="Move to" name="status">
                  {d.statuses.map((s) => (
                    <s-option key={s.value} value={s.value} {...selectedIf(s.value === ticket.status)}>
                      {s.label}
                    </s-option>
                  ))}
                </s-select>
                <s-button variant="primary" type="submit">
                  Update
                </s-button>
              </s-stack>
            </Form>
          </s-section>

          <PostageSection d={d} />

          <s-section heading="Quotation">
            <s-stack direction="block" gap="base">
              {quotation ? (
                <>
                  <s-stack direction="inline" gap="small-200" align-items="center">
                    <s-badge tone={quotation.tone}>{quotation.statusLabel}</s-badge>
                    {quotation.draftOrderUrl ? (
                      <s-link href={quotation.draftOrderUrl} target="_blank">
                        View draft order
                      </s-link>
                    ) : null}
                  </s-stack>
                  {quotation.decision ? <QuoteDecision decision={quotation.decision} /> : null}
                </>
              ) : null}

              {d.lineItems.length && quotation ? (
                <>
                  <s-table variant="auto">
                    <s-table-header-row>
                      <s-table-header list-slot="primary">Item</s-table-header>
                      <s-table-header>Type</s-table-header>
                      <s-table-header format="numeric">Qty</s-table-header>
                      <s-table-header format="currency">Unit</s-table-header>
                      <s-table-header format="currency">Discount</s-table-header>
                      <s-table-header format="currency">Total</s-table-header>
                      <s-table-header></s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {d.lineItems.map((line) => (
                        <s-table-row key={line.id}>
                          <s-table-cell>{line.title}</s-table-cell>
                          <s-table-cell>
                            <s-badge tone={line.kind === "repair" ? "info" : "neutral"}>
                              {line.kind === "repair" ? "Repair" : "Extra"}
                            </s-badge>
                          </s-table-cell>
                          <s-table-cell>{line.quantity}</s-table-cell>
                          <s-table-cell>{line.unitPrice}</s-table-cell>
                          <s-table-cell>{line.discount}</s-table-cell>
                          <s-table-cell>{line.total}</s-table-cell>
                          <s-table-cell>
                            {quotation.draft ? (
                              <Form method="post">
                                <Intent value="remove_line" />
                                <input type="hidden" name="line_id" value={line.id} />
                                <s-button
                                  variant="tertiary"
                                  tone="critical"
                                  type="submit"
                                  icon="delete"
                                  accessibility-label="Remove line item"
                                ></s-button>
                              </Form>
                            ) : null}
                          </s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>

                  {quotation.coverApplied ? (
                    <>
                      <s-stack direction="inline" gap="small-200" align-items="center">
                        <s-text>{quotation.coverLabel}</s-text>
                        <s-text>−{quotation.coverDiscount}</s-text>
                      </s-stack>
                      {quotation.coverExcess ? (
                        <s-stack direction="inline" gap="small-200" align-items="center">
                          <s-text>Care excess</s-text>
                          <s-text>{quotation.coverExcess}</s-text>
                        </s-stack>
                      ) : null}
                    </>
                  ) : null}
                  <s-stack direction="inline" gap="small-200" align-items="center">
                    <s-text type="strong">Subtotal</s-text>
                    <s-text type="strong">{quotation.subtotal}</s-text>
                  </s-stack>

                  {quotation.draft && d.ticketCoverName ? (
                    <Form method="post">
                      <Intent value="cover" />
                      <input type="hidden" name="apply" value={quotation.coverApplied ? "0" : "1"} />
                      <s-button variant="tertiary" type="submit">
                        {quotation.coverApplied
                          ? "Fault not covered: charge in full"
                          : `Apply ${d.ticketCoverName}`}
                      </s-button>
                    </Form>
                  ) : null}
                </>
              ) : (
                <s-paragraph color="subdued">
                  No line items yet. Add the repair product, plus any extra parts.
                </s-paragraph>
              )}

              {d.canEditQuote ? (
                <>
                  <s-divider></s-divider>
                  {d.repairVariants.length ? (
                    <Form method="post">
                      <Intent value="add_line" />
                      <input type="hidden" name="kind" value="repair" />
                      <s-stack direction="block" gap="small-200">
                        <s-grid grid-template-columns="3fr 1fr" gap="small-200">
                          <s-select label="Add repair product" name="shopify_variant_id">
                            {d.repairVariants.map((v) => (
                              <s-option key={v.id} value={v.id}>
                                {v.label}
                              </s-option>
                            ))}
                          </s-select>
                          <s-number-field label="Qty" name="quantity" value="1" min={1} input-mode="numeric"></s-number-field>
                        </s-grid>
                        <s-stack direction="inline">
                          <s-button variant="primary" type="submit" icon="plus">
                            Add product
                          </s-button>
                        </s-stack>
                      </s-stack>
                    </Form>
                  ) : (
                    <s-paragraph color="subdued">
                      No repair products found. Set a repair tag or collection in{" "}
                      <s-link href="/app/settings">Settings</s-link>, then add the products in Shopify.
                    </s-paragraph>
                  )}

                  <Form method="post">
                    <Intent value="add_line" />
                    <input type="hidden" name="kind" value="extra" />
                    <s-stack direction="block" gap="small-200">
                      <s-text-field
                        label="Add extra (parts / labour)"
                        name="title"
                        placeholder="e.g. Replacement lace hook"
                        required
                      ></s-text-field>
                      <s-grid grid-template-columns="1fr 1fr 1fr" gap="small-200">
                        <s-number-field label="Quantity" name="quantity" value="1" min={1} input-mode="numeric"></s-number-field>
                        <s-money-field label="Unit price" name="unit_price" min={0}></s-money-field>
                        <s-money-field label="Discount" name="discount" min={0}></s-money-field>
                      </s-grid>
                      <s-stack direction="inline">
                        <s-button variant="secondary" type="submit" icon="plus">
                          Add extra
                        </s-button>
                      </s-stack>
                    </s-stack>
                  </Form>

                  {d.lineItems.length ? (
                    <Form method="post">
                      <Intent value="send" />
                      <s-button variant="primary" type="submit" icon="send">
                        Send quote
                      </s-button>
                    </Form>
                  ) : null}
                </>
              ) : null}
            </s-stack>
          </s-section>

          {d.partsEnabled ? <PartsSection d={d} /> : null}

          <s-section heading="Activity">
            <s-stack direction="block" gap="base">
              <Form method="post">
                <Intent value="note" />
                <s-stack direction="block" gap="small-200">
                  <s-text-area label="Add a note" name="body" rows={2} placeholder="Internal note…"></s-text-area>
                  <s-stack direction="inline">
                    <s-button variant="secondary" type="submit">
                      Add note
                    </s-button>
                  </s-stack>
                </s-stack>
              </Form>
              {d.activities.length ? (
                <s-stack direction="block" gap="small-200">
                  {d.activities.map((a) => (
                    <s-box key={a.id} padding="small-200" border="base" border-radius="base">
                      <s-stack direction="block" gap="small-500">
                        <s-stack direction="inline" gap="small-200" align-items="center">
                          <s-badge tone="neutral">{a.type}</s-badge>
                          <s-text color="subdued">
                            {a.when} · {a.author}
                          </s-text>
                        </s-stack>
                        {a.body ? <s-paragraph>{a.body}</s-paragraph> : null}
                      </s-stack>
                    </s-box>
                  ))}
                </s-stack>
              ) : (
                <s-paragraph color="subdued">No activity yet.</s-paragraph>
              )}
            </s-stack>
          </s-section>
        </s-stack>

        <s-stack direction="block" gap="base">
          {d.costs ? (
            <s-section heading="Repair cost">
              <s-stack direction="block" gap="small-500">
                <s-text>Charged {d.costs.price}</s-text>
                <s-text>Parts {d.costs.parts}</s-text>
                <s-text>
                  Labour {d.costs.labour} ({d.costs.labourMinutes} min)
                </s-text>
                <s-text type="strong">Margin {d.costs.margin}</s-text>
              </s-stack>
            </s-section>
          ) : null}

          <s-section heading="Item & cover">
            {d.item ? (
              <s-stack direction="block" gap="small-200">
                <s-link href={`/app/items/${d.item.id}`}>
                  Item #{d.item.id}: {d.item.label}
                </s-link>
                {d.cover ? (
                  <>
                    <s-badge tone="success">{d.cover.name}</s-badge>
                    <s-text>
                      {d.cover.outcome} · until {d.cover.until}
                    </s-text>
                    {d.cover.faults.length ? (
                      <s-text color="subdued">Covers: {d.cover.faults.join(", ")}</s-text>
                    ) : null}
                  </>
                ) : (
                  <s-text color="subdued">No cover in force when this was raised.</s-text>
                )}
                {d.item.registration ? (
                  <s-badge tone={d.item.registration.tone}>Registration {d.item.registration.status}</s-badge>
                ) : null}
                <Form method="post">
                  <Intent value="link_item" />
                  <input type="hidden" name="item_id" value="" />
                  <s-button variant="tertiary" type="submit">
                    Unlink item
                  </s-button>
                </Form>
              </s-stack>
            ) : d.itemCandidates.length ? (
              <Form method="post">
                <Intent value="link_item" />
                <s-stack direction="block" gap="small-200">
                  <s-paragraph color="subdued">Not linked to an item yet. Link it to apply the item&apos;s cover.</s-paragraph>
                  <s-select label="Customer's items" name="item_id">
                    {d.itemCandidates.map((c) => (
                      <s-option key={c.id} value={String(c.id)}>
                        {c.label}
                      </s-option>
                    ))}
                  </s-select>
                  <s-stack direction="inline">
                    <s-button type="submit">Link item</s-button>
                  </s-stack>
                </s-stack>
              </Form>
            ) : (
              <s-paragraph color="subdued">No items found for this customer.</s-paragraph>
            )}
          </s-section>

          <s-section heading="Customer">
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">{ticket.customerName}</s-text>
              {ticket.customerEmail ? <s-text>{ticket.customerEmail}</s-text> : null}
              {ticket.customerPhone ? <s-text>{ticket.customerPhone}</s-text> : null}
              {ticket.address ? <s-text color="subdued">{ticket.address}</s-text> : null}
            </s-stack>
          </s-section>

          <s-section heading="Product">
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">{ticket.productTitle}</s-text>
              {ticket.variantTitle ? <s-text color="subdued">{ticket.variantTitle}</s-text> : null}
              {ticket.orderNumber ? (
                <s-text color="subdued">
                  Order {ticket.orderNumber}
                  {ticket.orderDate ? ` · ${ticket.orderDate}` : ""}
                </s-text>
              ) : null}
              {ticket.noOrderHistory ? <s-badge tone="caution">No order history</s-badge> : null}
            </s-stack>
          </s-section>

          {ticket.description ? (
            <s-section heading="Issue described">
              <s-paragraph>{ticket.description}</s-paragraph>
            </s-section>
          ) : null}

          <s-section heading="Photos">
            {d.images.length ? (
              <s-grid grid-template-columns="1fr 1fr" gap="small-200">
                {d.images.map((image) => (
                  <s-image
                    key={image.id}
                    src={image.src}
                    alt={image.alt}
                    aspect-ratio="1/1"
                    object-fit="cover"
                    loading="lazy"
                  ></s-image>
                ))}
              </s-grid>
            ) : (
              <s-paragraph color="subdued">No photos uploaded.</s-paragraph>
            )}
          </s-section>
        </s-stack>
      </s-grid>
    </s-page>
  );
}

type Detail = ReturnType<typeof useLoaderData<typeof loader>>;
type Decision = NonNullable<NonNullable<Detail["quotation"]>["decision"]>;

/** A sent quote: what the customer did, and what staff can do next (Rails tickets/_quote_decision). */
function QuoteDecision({ decision }: { decision: Decision }) {
  return (
    <s-stack direction="block" gap="small-200">
      <s-stack direction="block" gap="small-500">
        <s-text color="subdued">
          Invoice sent {decision.sentAt}
          {decision.validUntil
            ? ` · ${decision.stillValid ? "valid until" : "was valid until"} ${decision.validUntil}`
            : ""}
        </s-text>
        {decision.decided ? <s-text>{decision.decided}</s-text> : null}
        {decision.reason ? <s-text>Reason: {decision.reason}</s-text> : null}
        {decision.reviewUrl ? (
          <>
            <s-text color="subdued">
              The customer&apos;s review page (pay or decline), also linked from the invoice email:
            </s-text>
            <s-text>{decision.reviewUrl}</s-text>
          </>
        ) : null}
      </s-stack>
      <s-stack direction="inline" gap="small-200">
        {decision.canResend ? (
          <Form method="post">
            <Intent value="resend" />
            <s-button type="submit" icon="send">
              Resend invoice
            </s-button>
          </Form>
        ) : null}
        {decision.canRevise ? (
          <Form method="post">
            <Intent value="revise" />
            <s-button type="submit" icon="edit">
              Revise quote
            </s-button>
          </Form>
        ) : null}
      </s-stack>
      {decision.canDecline ? (
        <Form method="post">
          <Intent value="decline" />
          <s-stack direction="inline" gap="small-200" align-items="end">
            <s-text-field label="Declined by the customer? Reason (optional)" name="reason"></s-text-field>
            <s-button tone="critical" variant="secondary" type="submit">
              Decline on their behalf
            </s-button>
          </s-stack>
        </Form>
      ) : null}
    </s-stack>
  );
}

/** The customer posts the item: postage slip, resend, and "Mark received". */
function PostageSection({ d }: { d: Detail }) {
  const { postage, ticket } = d;
  if (!postage.awaiting && !postage.receivedAt && !postage.canMarkReceived) return null;
  return (
    <s-section heading="Item">
      <s-stack direction="block" gap="small-200">
        {postage.receivedAt ? (
          <s-text>Received at the workshop {postage.receivedAt}.</s-text>
        ) : postage.awaiting ? (
          <s-text>
            Waiting for the customer to post the item
            {postage.emailsSent > 0
              ? `. Postage slip emailed${postage.emailsSent > 1 ? ` ${postage.emailsSent} times` : ""}.`
              : "."}
          </s-text>
        ) : (
          <s-text color="subdued">
            Not received yet. Once the quote is paid the customer is emailed a postage slip; if the item is already
            here, mark it received and paying starts the repair.
          </s-text>
        )}
        {postage.workshopAddress ? null : (
          <s-banner tone="warning">
            No postage slips until your workshop address is set.{" "}
            <s-link href="/app/settings">Add it in Settings → Repairs</s-link>.
          </s-banner>
        )}
        <s-stack direction="inline" gap="small-200">
          {postage.canMarkReceived ? (
            <Form method="post">
              <Intent value="mark_received" />
              <s-button type="submit" variant={postage.awaiting ? "primary" : "secondary"} icon="check">
                Mark received
              </s-button>
            </Form>
          ) : null}
          {postage.canDownload ? (
            <DownloadButton href={`/app/tickets/${ticket.id}/postage_slip`}>Download postage slip</DownloadButton>
          ) : null}
          {postage.canResend && postage.workshopAddress ? (
            <Form method="post">
              <Intent value="resend_postage" />
              <s-button type="submit" icon="email">
                Resend postage email
              </s-button>
            </Form>
          ) : null}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

/** Parts planned from the quote's service recipes, used on completion (Workshop inventory). */
function PartsSection({ d }: { d: Detail }) {
  return (
    <s-section heading="Parts">
      <s-stack direction="block" gap="base">
        {d.ticketParts.length ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header list-slot="primary">Part</s-table-header>
              <s-table-header>Variant</s-table-header>
              <s-table-header format="numeric">Qty</s-table-header>
              <s-table-header format="currency">Cost</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.ticketParts.map((tp) => (
                <s-table-row key={tp.id}>
                  <s-table-cell>
                    <s-link href={`/app/parts/${tp.partId}`}>{tp.partName}</s-link>
                    {tp.consumed ? <s-badge tone="success">Used</s-badge> : null}
                  </s-table-cell>
                  <s-table-cell>
                    {tp.consumed || !tp.varies ? (
                      tp.variantLabel
                    ) : (
                      <>
                        <Form method="post">
                          <Intent value="update_part" />
                          <input type="hidden" name="ticket_part_id" value={tp.id} />
                          <s-stack direction="inline" gap="small-300" align-items="end">
                            <s-select label="Variant" label-accessibility-visibility="exclusive" name="part_variant_id">
                              {tp.variantId ? null : <s-option value="">Choose…</s-option>}
                              {tp.variants.map((v) => (
                                <s-option key={v.id} value={String(v.id)} {...selectedIf(v.id === tp.variantId)}>
                                  {v.label}
                                </s-option>
                              ))}
                            </s-select>
                            <s-button type="submit" variant="tertiary">
                              Save
                            </s-button>
                          </s-stack>
                        </Form>
                        {tp.variantId ? null : <s-badge tone="caution">Choose a variant</s-badge>}
                      </>
                    )}
                  </s-table-cell>
                  <s-table-cell>{tp.quantity}</s-table-cell>
                  <s-table-cell>{tp.cost}</s-table-cell>
                  <s-table-cell>
                    {tp.consumed ? null : (
                      <Form method="post">
                        <Intent value="remove_part" />
                        <input type="hidden" name="ticket_part_id" value={tp.id} />
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          type="submit"
                          icon="delete"
                          accessibility-label="Remove part"
                        ></s-button>
                      </Form>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph color="subdued">
            No parts planned. Plan them from the quote&apos;s services, or add them by hand. They&apos;re taken from
            stock when the ticket is completed.
          </s-paragraph>
        )}

        {d.ticket.completed ? null : (
          <>
            <s-stack direction="inline" gap="small-200">
              <Form method="post">
                <Intent value="plan_parts" />
                <s-button type="submit">{d.ticketParts.length ? "Re-plan from services" : "Plan from services"}</s-button>
              </Form>
            </s-stack>
            {d.parts.length ? (
              <Form method="post">
                <Intent value="add_part" />
                <s-grid grid-template-columns="3fr 1fr auto" gap="small-200" align-items="end">
                  <s-select label="Add a part" name="part_id">
                    {d.parts.map((p) => (
                      <s-option key={p.id} value={String(p.id)}>
                        {p.label}
                      </s-option>
                    ))}
                  </s-select>
                  <s-number-field label="Qty" name="quantity" value="1" min={0.001} step={0.001}></s-number-field>
                  <s-button type="submit" icon="plus">
                    Add
                  </s-button>
                </s-grid>
              </Form>
            ) : null}
          </>
        )}
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
