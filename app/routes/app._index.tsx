import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { requireAdmin } from "../services/admin/context.server";

// The admin home is the tickets list (Rails `root "tickets#index"`); keeps
// ?setup_step= for the first-run setup.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  const { search } = new URL(request.url);
  return redirect(`/app/tickets${search}`);
};
