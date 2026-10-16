/**
 * Stand-in for the Admin GraphQL client (`admin.graphql`), ported from the
 * Rails FakeGraphqlApi. Responses are matched by a substring of the query
 * (e.g. "product(id:"), every call is recorded for assertions, and a missing
 * match throws so tests never silently hit a default.
 */
type Responder = unknown | ((variables: Record<string, unknown>) => unknown);

export class FakeGraphql {
  readonly calls: { query: string; variables: Record<string, unknown> }[] = [];

  constructor(private responses: Record<string, Responder> = {}) {}

  /** Same shape as the library's client: returns a Response with `{ data }` JSON. */
  graphql = async (
    query: string,
    options: { variables?: Record<string, unknown> } = {},
  ) => {
    const variables = options.variables ?? {};
    this.calls.push({ query, variables });
    const match = Object.entries(this.responses).find(([fragment]) =>
      query.includes(fragment),
    );
    if (!match)
      throw new Error(
        `FakeGraphql: no response for query ${JSON.stringify(query.slice(0, 60))}`,
      );
    const responder = match[1];
    const data =
      typeof responder === "function"
        ? (responder as (v: Record<string, unknown>) => unknown)(variables)
        : responder;
    return new Response(JSON.stringify({ data }), {
      headers: { "content-type": "application/json" },
    });
  };
}
