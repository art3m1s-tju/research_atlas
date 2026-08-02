import PaperCard from "./PaperCard";

interface Paper {
  id: string;
  title: string;
  authors: string;
  year: number;
  venue: string;
  citations: number;
  abstract: string;
  direction: string;
  doi: string | null;
  pdfUrl: string | null;
}

export default function PaperGrid({ papers }: { papers: Paper[] }) {
  if (papers.length === 0) {
    return (
      <div className="text-center py-20">
        <div className="text-6xl mb-4">📚</div>
        <p className="text-gray-500 text-lg">暂无论文</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {papers.map((paper) => (
        <PaperCard key={paper.id} paper={paper} />
      ))}
    </div>
  );
}
