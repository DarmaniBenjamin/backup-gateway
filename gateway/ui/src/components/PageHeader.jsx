// Page title with an optional action button on the right.

export default function PageHeader({ title, children, action }) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {children && <div className="mt-1 text-dim">{children}</div>}
      </div>
      {action}
    </div>
  );
}