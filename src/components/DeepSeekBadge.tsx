export default function DeepSeekBadge() {
  return (
    <div className="flex items-center gap-2 rounded-full border border-sky-100 bg-white px-3 py-1.5 text-xs font-medium text-sky-700" title="论文分类与中文解读由 DeepSeek 辅助">
      <img src="/deepseek-logo.png" alt="DeepSeek" className="h-5 w-auto" />
      <span>Powered by DeepSeek</span>
    </div>
  );
}
