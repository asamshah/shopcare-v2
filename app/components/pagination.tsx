/** Previous / Next links for the paged lists (Rails `page` param, no COUNT). */
export function Pagination({
  page,
  hasNextPage,
  href,
}: {
  page: number;
  hasNextPage: boolean;
  href: (page: number) => string;
}) {
  if (page <= 1 && !hasNextPage) return null;
  return (
    <s-section padding="base">
      <s-stack direction="inline" gap="small-200" justify-content="center">
        {page > 1 ? (
          <s-button variant="secondary" href={href(page - 1)}>
            Previous
          </s-button>
        ) : null}
        {hasNextPage ? (
          <s-button variant="secondary" href={href(page + 1)}>
            Next
          </s-button>
        ) : null}
      </s-stack>
    </s-section>
  );
}
