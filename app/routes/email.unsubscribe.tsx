import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  unsubscribe,
  unsubscribeForm,
} from "../services/notifications/unsubscribe-request.server";

/**
 * /email/unsubscribe?token=… — the signed link in ShopCare's marketing email
 * ("Add Care to your purchase"). GET confirms, POST (the form, or a mail
 * client's RFC 8058 one-click POST) unsubscribes. See
 * app/services/notifications/unsubscribe-request.server.ts.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => unsubscribeForm(request);

export const action = async ({ request }: ActionFunctionArgs) => unsubscribe(request);
