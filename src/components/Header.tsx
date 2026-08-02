"use client";

import React from "react";

interface HeaderProps {
  activeTab?: string;
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
}

export default function Header({ activeTab = "map", searchQuery = "", onSearchChange }: HeaderProps) {
  const [searchOpen, setSearchOpen] = React.useState(false);

  const tabs = [
    { key: "map", label: "论文地图" },
    { key: "transformer", label: "Transformer 3D" },
    { key: "evidence", label: "证据与评分" },
  ];

  return (
    <header className="w-full bg-white border-b border-border-soft px-6 py-3.5 flex items-center justify-between flex-shrink-0">
      {/* Logo + Title */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-brand-dark flex items-center justify-center shadow-sm">
          <span className="text-white font-bold text-lg">AI</span>
        </div>
        <div className="flex flex-col">
          <span className="text-text-primary font-semibold text-lg leading-tight">
            AI Research Atlas
          </span>
          <span className="text-text-secondary text-xs">AI 论文知识图谱</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex items-center gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`px-4 py-2 rounded-button font-medium text-sm transition-colors ${
              activeTab === tab.key
                ? "bg-brand-dark text-white"
                : "text-text-secondary hover:text-text-primary hover:bg-chip-bg"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Actions */}
      <div className="flex items-center gap-3">
        {searchOpen ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange?.(e.target.value)}
              placeholder="搜索论文标题、作者、标签…"
              className="px-3 py-1.5 rounded-lg border border-border-soft text-sm text-text-primary bg-chip-bg/50 focus:outline-none focus:ring-2 focus:ring-brand-dark/20 focus:border-brand-dark w-64"
              autoFocus
            />
            <button
              onClick={() => { setSearchOpen(false); onSearchChange?.(""); }}
              className="text-text-secondary hover:text-text-primary text-sm"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            onClick={() => setSearchOpen(true)}
            className="w-10 h-10 rounded-full bg-chip-bg hover:bg-gray-200 flex items-center justify-center transition-colors"
          >
            <svg className="w-5 h-5 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
        )}
        <button className="px-4 py-2 rounded-full border border-border-soft text-text-secondary hover:text-text-primary hover:border-text-secondary text-sm font-medium transition-colors">
          在 Obsidian 打开
        </button>
      </div>
    </header>
  );
}
