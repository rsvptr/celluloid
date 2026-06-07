export default function Loading() {
  return (
    <div>
      <div className="mb-5 h-7 w-32 rounded bg-surface-2 shimmer" />
      <div className="mb-5 h-10 w-full rounded-lg bg-surface-2 shimmer" />
      <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
        {Array.from({ length: 14 }).map((_, i) => (
          <div key={i} className="aspect-[2/3] w-full rounded-lg bg-surface-2 shimmer" />
        ))}
      </div>
    </div>
  );
}
