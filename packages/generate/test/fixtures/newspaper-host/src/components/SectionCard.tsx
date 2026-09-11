/** An existing host component: the idiom a draft is expected to match. */
export function SectionCard({ kicker, headline }: { kicker: string; headline: string }) {
  return (
    <article className="bt-card">
      <p className="bt-kicker">{kicker}</p>
      <h2 className="bt-headline">{headline}</h2>
    </article>
  );
}
