export type VenueType = "conference" | "journal" | "preprint" | "unknown";
export type PublicationStatus = "published" | "preprint" | "workshop" | "unknown";

export type VenueTier = 0 | 1 | 2 | 3;

export interface ClassicSeed {
  title: string;
  year: number;
  venue: string;
  venueType: VenueType;
  arxivId?: string;
  doi?: string;
  directions: string[];
}

export const CLASSIC_SEEDS: ClassicSeed[] = [
  {
    title: "Attention Is All You Need",
    year: 2017,
    venue: "NeurIPS 2017",
    venueType: "conference",
    arxivId: "1706.03762",
    directions: ["e2e", "world_model", "llm_driving"],
  },
  {
    title: "End to End Learning for Self-Driving Cars",
    year: 2016,
    venue: "arXiv technical report",
    venueType: "preprint",
    arxivId: "1604.07316",
    directions: ["e2e", "control"],
  },
  {
    title: "VectorNet: Encoding HD Maps and Agent Dynamics From Vectorized Representation",
    year: 2020,
    venue: "CVPR 2020",
    venueType: "conference",
    arxivId: "2005.04259",
    directions: ["prediction", "planning", "e2e"],
  },
  {
    title: "Trajectron++: Dynamically-Feasible Trajectory Forecasting With Heterogeneous Data",
    year: 2020,
    venue: "ECCV 2020",
    venueType: "conference",
    arxivId: "2001.03093",
    directions: ["prediction", "planning"],
  },
  {
    title: "BEVFormer: Learning Bird's-Eye-View Representation from Multi-Camera Images via Spatiotemporal Transformers",
    year: 2022,
    venue: "ECCV 2022",
    venueType: "conference",
    arxivId: "2203.17270",
    directions: ["perception", "e2e"],
  },
  {
    title: "Planning-Oriented Autonomous Driving",
    year: 2023,
    venue: "CVPR 2023",
    venueType: "conference",
    arxivId: "2212.10156",
    directions: ["e2e", "planning", "perception", "prediction"],
  },
  {
    title: "World Models",
    year: 2018,
    venue: "arXiv technical report",
    venueType: "preprint",
    arxivId: "1803.10122",
    directions: ["world_model", "rl_driving"],
  },
  {
    title: "Learning by Cheating",
    year: 2019,
    venue: "CoRL 2019",
    venueType: "conference",
    arxivId: "1912.12294",
    directions: ["e2e", "planning", "control", "safety"],
  },
  {
    title: "ChauffeurNet: Learning to Drive by Imitating the Best and Synthesizing the Worst",
    year: 2019,
    venue: "RSS 2019",
    venueType: "conference",
    arxivId: "1812.03079",
    directions: ["e2e", "planning", "control", "safety"],
  },
];

const VENUE_TIERS: Array<{ tier: VenueTier; labels: string[] }> = [
  {
    tier: 3,
    labels: [
      "neurips", "nips", "icml", "iclr", "cvpr", "iccv", "eccv", "corl", "rss",
      "icra", "iros", "cdc", "acc", "aamas", "aaai", "ijcai", "uai", "kdd",
      "t-ro", "transactions on robotics", "t-its", "transactions on intelligent vehicles",
    ],
  },
  {
    tier: 2,
    labels: [
      "iv", "intelligent vehicles", "itsc", "its world congress", "ral", "ra-l", "robotics and automation letters",
      "t-ase", "t-cyb", "t-rob", "pattern recognition", "ijcv", "jmlr", "tmlr",
    ],
  },
  {
    tier: 1,
    labels: ["arxiv", "technical report", "workshop", "symposium", "conference", "journal"],
  },
];

export function normalizeTitle(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "")
    .slice(0, 300);
}

export function getClassicSeed(title: string) {
  const normalized = normalizeTitle(title);
  return CLASSIC_SEEDS.find((seed) => normalizeTitle(seed.title) === normalized) || null;
}

export function classifyVenue(venue: string | null | undefined, publicationChannel?: string | null) {
  const value = `${venue || ""} ${publicationChannel || ""}`.toLowerCase().trim();
  const matchesShortToken = (token: string) => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(value);
  const conferenceName = ["conference", "cvpr", "iccv", "eccv", "neurips", "nips", "icml", "iclr", "corl", "icra", "iros", "aaai", "ijcai", "itsc"]
    .some((label) => value.includes(label)) || ["rss", "cdc", "acc", "iv", "uai", "kdd"].some(matchesShortToken);
  const venueType: VenueType = value.includes("arxiv") || value.includes("preprint")
    ? "preprint"
    : conferenceName
      ? "conference"
      : value.includes("journal") || value.includes("transactions") || value.includes("letters") || value.includes("tmlr") || value.includes("jmlr")
        ? "journal"
        : value
          ? "unknown"
          : "unknown";

  const matchesLabel = (label: string) => {
    if (label.length > 3) return value.includes(label);
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(value);
  };
  for (const candidate of VENUE_TIERS) {
    if (candidate.labels.some(matchesLabel)) {
      return {
        venueType,
        venueTier: candidate.tier,
        publicationStatus: value.includes("workshop") ? "workshop" as PublicationStatus : venueType === "preprint" ? "preprint" as PublicationStatus : "published" as PublicationStatus,
      };
    }
  }
  return {
    venueType,
    venueTier: 0 as VenueTier,
    publicationStatus: value.includes("workshop")
      ? "workshop" as PublicationStatus
      : venueType === "preprint"
        ? "preprint" as PublicationStatus
        : venueType === "conference" || venueType === "journal"
          ? "published" as PublicationStatus
          : "unknown" as PublicationStatus,
  };
}

export function isFrontierPaper(year: number | null | undefined, publishedDate?: string | null, now = new Date()) {
  const date = publishedDate ? new Date(publishedDate) : null;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - 24);
  if (date && !Number.isNaN(date.getTime())) return date >= cutoff;
  return typeof year === "number" && year >= now.getFullYear() - 2;
}

export function citationQuality(citations: number | null | undefined, citationPercentile?: number | null) {
  if (typeof citationPercentile === "number") {
    const normalized = citationPercentile > 1 ? citationPercentile / 100 : citationPercentile;
    return Math.max(0, Math.min(normalized, 1));
  }
  return Math.min(Math.log10((citations || 0) + 1) / 4, 1);
}

export function recommendationScore(paper: {
  year?: number | null;
  published_date?: string | null;
  citations?: number | null;
  citation_percentile?: number | null;
  venue_tier?: number | null;
  is_classic?: number | boolean | null;
  is_frontier?: number | boolean | null;
}) {
  const frontier = paper.is_frontier === undefined || paper.is_frontier === null
    ? isFrontierPaper(paper.year, paper.published_date)
    : Boolean(paper.is_frontier);
  const classic = Boolean(paper.is_classic);
  const age = Math.max(0, new Date().getFullYear() - (paper.year || new Date().getFullYear()));
  const recency = frontier ? 1 : Math.exp(-0.24 * age);
  const venue = Math.min(Math.max(paper.venue_tier || 0, 0) / 3, 1);
  const impact = citationQuality(paper.citations, paper.citation_percentile);
  const classicAnchor = classic ? 1 : 0;
  return 0.42 * recency + 0.25 * venue + 0.18 * impact + 0.15 * classicAnchor;
}

export function discoveryReason(paper: {
  year?: number | null;
  published_date?: string | null;
  venue_tier?: number | null;
  is_classic?: number | boolean | null;
}) {
  if (paper.is_classic) return "经典必读";
  if (isFrontierPaper(paper.year, paper.published_date)) {
    return (paper.venue_tier || 0) >= 3 ? "顶会前沿" : "近两年前沿";
  }
  return (paper.venue_tier || 0) >= 3 ? "高质量基础" : "方向相关";
}

export function metadataForPaper(paper: {
  title: string;
  year?: number | null;
  published_date?: string | null;
  venue?: string | null;
  publication_channel?: string | null;
  citations?: number | null;
  citation_percentile?: number | null;
  sources?: string[] | null;
}) {
  const seed = getClassicSeed(paper.title);
  const venue = classifyVenue(paper.venue, paper.publication_channel);
  const isClassic = Boolean(seed);
  const isFrontier = !isClassic && isFrontierPaper(paper.year, paper.published_date);
  const enriched = {
    ...venue,
    venueVerified: Boolean(paper.venue && (paper.sources || []).length > 0),
    isClassic,
    isFrontier,
    discoveryReason: discoveryReason({
      year: paper.year,
      published_date: paper.published_date,
      venue_tier: venue.venueTier,
      is_classic: isClassic,
    }),
  };
  return {
    ...enriched,
    qualityScore: 0.6 * (venue.venueTier / 3) + 0.4 * citationQuality(paper.citations, paper.citation_percentile),
    recommendationScore: recommendationScore({
      year: paper.year,
      published_date: paper.published_date,
      citations: paper.citations,
      citation_percentile: paper.citation_percentile,
      venue_tier: venue.venueTier,
      is_classic: isClassic,
      is_frontier: isFrontier,
    }),
  };
}
