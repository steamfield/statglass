import { Fragment, type ReactElement } from "react";

export interface ReorderListProps<T> {
  data: readonly T[];
  keyOf(item: T): string;
  itemLabel(item: T): string;
  nested?: boolean;
  renderItem(info: { item: T; index: number; isActive: boolean }): ReactElement;
  onReorder(ids: string[]): void;
  onReleaseWithoutMove?(id: string): void;
}

export function ReorderList<T>({
  data,
  keyOf,
  renderItem,
}: ReorderListProps<T>) {
  return (
    <>
      {data.map((item, index) => (
        <Fragment key={keyOf(item)}>
          {renderItem({ item, index, isActive: false })}
        </Fragment>
      ))}
    </>
  );
}
