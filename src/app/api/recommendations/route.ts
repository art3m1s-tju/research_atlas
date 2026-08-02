import { NextRequest, NextResponse } from "next/server";
import { papers } from "@/lib/demo-data";

/**
 * GET /api/recommendations?directions=repr,embodied&limit=10
 * 基于用户兴趣方向的论文推荐（按引用量 + 时间衰减加权排序）
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const dirsParam = searchParams.get("directions") || "";
  const limit = Math.min(parseInt(searchParams.get("limit") || "10"), 50);

  const userDirs = dirsParam.split(",").filter(Boolean);

  // 推荐算法：方向匹配度 × 引用量 × 时间衰减 × 会议等级
  const scored = papers.map((paper) => {
    // 方向匹配度：用户选的方向中有多少匹配
    const directionMatch = userDirs.length > 0
      ? paper.directions.filter((d) => userDirs.includes(d)).length / Math.max(userDirs.length, 1)
      : 1;

    // 引用量评分：log10(citations + 1) / 10
    const citations = typeof paper.semanticScholarCitations === "number"
      ? paper.semanticScholarCitations
      : 0;
    const citationScore = Math.log10(citations + 1) / 10;

    // 时间衰减：exp(-0.15 * years_since_publication)
    const currentYear = 2026;
    const yearsSince = currentYear - paper.year;
    const recencyScore = Math.exp(-0.15 * yearsSince);

    // 会议等级加成
    let venueMultiplier = 1.0;
    if (paper.publicationChannel === "CCF A") venueMultiplier = 1.5;
    else if (paper.publicationChannel === "CCF B") venueMultiplier = 1.2;
    else if (paper.publicationChannel.includes("同行评议")) venueMultiplier = 1.1;

    // 前沿/当前加成
    const frontierBonus = (paper.isFrontier ? 1.3 : 1) * (paper.isCurrent ? 1.2 : 1);

    const totalScore = directionMatch * citationScore * recencyScore * venueMultiplier * frontierBonus;

    return { ...paper, score: totalScore };
  });

  // 排序取 top N
  scored.sort((a, b) => b.score - a.score);
  const recommended = scored.slice(0, limit);

  return NextResponse.json({
    papers: recommended,
    algorithm: "direction_match × log10(citations) × time_decay × venue_rank × frontier_bonus",
    total: recommended.length,
  });
}
