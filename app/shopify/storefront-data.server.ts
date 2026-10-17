/**
 * Writes the storefront data (app/services/storefront/storefront-sync.server.ts)
 * to an app-data metafield on the app installation, which the theme blocks
 * read as `app.metafields.shopcare.storefront.value`. Like the customer
 * signing key (customer-signing-key.server.ts), it's visible only to this
 * app: not in the admin, the Storefront API or other apps.
 */
import { CURRENT_APP_INSTALLATION_QUERY } from "./customer-signing-key.server";
import {
  adminGraphql,
  assertNoUserErrors,
  type AdminGraphqlClient,
  type UserError,
} from "./graphql.server";

export const STOREFRONT_DATA_NAMESPACE = "shopcare";
export const STOREFRONT_DATA_KEY = "storefront";

export const SET_STOREFRONT_DATA_MUTATION = `#graphql
  mutation SetStorefrontData($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

export async function publishStorefrontData(client: AdminGraphqlClient, data: unknown): Promise<void> {
  const installation = await adminGraphql<{ currentAppInstallation: { id: string } }>(
    client,
    CURRENT_APP_INSTALLATION_QUERY,
  );
  const result = await adminGraphql<{ metafieldsSet: { userErrors: UserError[] } }>(
    client,
    SET_STOREFRONT_DATA_MUTATION,
    {
      metafields: [
        {
          ownerId: installation.currentAppInstallation.id,
          namespace: STOREFRONT_DATA_NAMESPACE,
          key: STOREFRONT_DATA_KEY,
          type: "json",
          value: JSON.stringify(data),
        },
      ],
    },
  );
  assertNoUserErrors("metafieldsSet", result.metafieldsSet);
}
