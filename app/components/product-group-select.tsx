import { selectedIf } from "./attrs";

export interface GroupOption {
  id: number;
  name: string;
  summary: string | null;
}

/** The product group a warranty policy or Care plan applies to (blank = all products). */
export function ProductGroupSelect({
  label,
  name,
  selected,
  groups,
}: {
  label: string;
  name: string;
  selected: number | null;
  groups: GroupOption[];
}) {
  return (
    <s-stack direction="block" gap="small-300">
      <s-select label={label} name={name}>
        <s-option value="" {...selectedIf(!selected)}>
          All products
        </s-option>
        {groups.map((group) => (
          <s-option key={group.id} value={String(group.id)} {...selectedIf(group.id === selected)}>
            {group.name} ({group.summary})
          </s-option>
        ))}
      </s-select>
      <s-link href="/app/product_groups">Manage product groups</s-link>
    </s-stack>
  );
}
