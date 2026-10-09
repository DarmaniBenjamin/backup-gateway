// Placeholder for pages that are built in later steps.

export default function ComingSoon({ title, step }) {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-dim">This page is built in step {step}.</p>
    </div>
  );
}