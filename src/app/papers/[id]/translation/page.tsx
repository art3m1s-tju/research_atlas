import TranslationReader from "@/components/TranslationReader";

export default async function TranslationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TranslationReader id={id} />;
}
