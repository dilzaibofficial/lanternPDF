import type { ReactNode } from "react";
import { Icon } from "../ui/Icon";

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel" aria-label={title}>
      <h2 className="panel__title">{title}</h2>
      {children}
    </section>
  );
}

/** The standard "your files stay here" line under a drop zone. */
export function LocalNote() {
  return (
    <>
      <Icon name="shield" size={16} />
      Processed in your browser. Your files are not uploaded.
    </>
  );
}
