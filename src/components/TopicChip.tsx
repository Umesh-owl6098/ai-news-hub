export function TopicChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
      {label}
    </span>
  );
}
