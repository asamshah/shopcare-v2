/** Rails form error banner ("Please fix the following"). */
export function ErrorBanner({ errors }: { errors?: string[] | null }) {
  if (!errors?.length) return null;
  return (
    <s-banner tone="critical" heading="Please fix the following">
      <s-unordered-list>
        {errors.map((message) => (
          <s-list-item key={message}>{message}</s-list-item>
        ))}
      </s-unordered-list>
    </s-banner>
  );
}
