/**
 * The per-shop secret the theme blocks sign the logged-in customer's id with
 * (customer-token.server.ts). It's kept encrypted on the shop and copied to an
 * app-data metafield on the app installation, which Liquid reads as
 * `app.metafields.shopcare.customer_signing_key`. App-data metafields are
 * visible only to this app: not in the Shopify admin, the Storefront API or
 * other apps. Ported from Rails `Shopify::CustomerSigningKey`.
 *
 *   ensureCustomerSigningKey  after auth: create the key if missing, publish it if unpublished
 *   rotateCustomerSigningKey  replace it; tokens signed with the old key stop verifying
 *
 * Storage is the caller's: they pass the shop's current state and a `save`
 * callback (which encrypts and persists it). A new key is saved before it is
 * published, so a failed publish is retried with the same key next time.
 */
import { randomBytes } from "node:crypto";
import {
  adminGraphql,
  assertNoUserErrors,
  type AdminGraphqlClient,
  type UserError,
} from "./graphql.server";

export const SIGNING_KEY_NAMESPACE = "shopcare";
export const SIGNING_KEY_KEY = "customer_signing_key";

export const CURRENT_APP_INSTALLATION_QUERY = `#graphql
  query CurrentAppInstallation {
    currentAppInstallation { id }
  }
`;

export const SET_SIGNING_KEY_MUTATION = `#graphql
  mutation SetCustomerSigningKey($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

export interface SigningKeyState {
  key: string | null;
  /** ISO timestamp of the last successful publish; null if never published. */
  publishedAt: string | null;
}

export type SaveSigningKey = (state: SigningKeyState) => Promise<void>;

/** 32 random bytes, hex (64 characters). */
export function generateSigningKey(): string {
  return randomBytes(32).toString("hex");
}

export async function ensureCustomerSigningKey(
  client: AdminGraphqlClient,
  state: SigningKeyState,
  save: SaveSigningKey,
  now: () => Date = () => new Date(),
): Promise<SigningKeyState> {
  if (!state.key) return rotateCustomerSigningKey(client, save, now);
  if (!state.publishedAt) return publish(client, state.key, save, now);
  return state;
}

export async function rotateCustomerSigningKey(
  client: AdminGraphqlClient,
  save: SaveSigningKey,
  now: () => Date = () => new Date(),
): Promise<SigningKeyState> {
  const key = generateSigningKey();
  await save({ key, publishedAt: null });
  return publish(client, key, save, now);
}

/** Writes the key to the app installation's app-data metafield. */
export async function publishCustomerSigningKey(
  client: AdminGraphqlClient,
  key: string,
): Promise<void> {
  const installation = await adminGraphql<{
    currentAppInstallation: { id: string };
  }>(client, CURRENT_APP_INSTALLATION_QUERY);
  const data = await adminGraphql<{
    metafieldsSet: { userErrors: UserError[] };
  }>(client, SET_SIGNING_KEY_MUTATION, {
    metafields: [
      {
        ownerId: installation.currentAppInstallation.id,
        namespace: SIGNING_KEY_NAMESPACE,
        key: SIGNING_KEY_KEY,
        type: "single_line_text_field",
        value: key,
      },
    ],
  });
  assertNoUserErrors("metafieldsSet", data.metafieldsSet);
}

async function publish(
  client: AdminGraphqlClient,
  key: string,
  save: SaveSigningKey,
  now: () => Date,
): Promise<SigningKeyState> {
  await publishCustomerSigningKey(client, key);
  const state = { key, publishedAt: now().toISOString() };
  await save(state);
  return state;
}
