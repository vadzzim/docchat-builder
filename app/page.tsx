import { Card } from "@/components/ui/card";

const primaryLink = "inline-flex items-center justify-center rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac focus-visible:ring-offset-2";
const secondaryLink = "inline-flex items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-ink ring-1 ring-slate-200 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac focus-visible:ring-offset-2";

function PlanLimits({ pro = false }: { pro?: boolean }) {
  const limits = pro
    ? [["Bots", "1"], ["Documents", "25"], ["Source text", "2,500 KiB"], ["Each file", "100 KiB"], ["AI requests", "1,000 / UTC month"]]
    : [["Bots", "1"], ["Documents", "5"], ["Source text", "500 KiB"], ["Each file", "100 KiB"], ["AI requests", "100 / UTC month"]];

  return (
    <dl className="mt-6 space-y-3 text-sm">
      {limits.map(([label, value]) => (
        <div className="flex items-center justify-between gap-4" key={label}>
          <dt className="text-slate-500">{label}</dt>
          <dd className="text-right font-semibold text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function HomePage() {
  return (
    <main id="top" className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <nav className="flex flex-wrap items-center justify-between gap-4" aria-label="Primary navigation">
        <a className="text-lg font-bold tracking-tight text-ink" href="#top" aria-label="DocChat home">doc<span className="text-lilac">chat</span></a>
        <div className="flex flex-wrap items-center justify-end gap-1 sm:gap-2">
          <a className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" href="#how-it-works">How it works</a>
          <a className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" href="#pricing">Pricing</a>
          <a className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" href="/auth">Sign in</a>
          <a className={primaryLink} href="/auth?mode=signup">Get started</a>
        </div>
      </nav>

      <section className="grid flex-1 items-center gap-12 py-16 sm:py-20 lg:grid-cols-[1.1fr_.9fr]" aria-labelledby="hero-title">
        <div>
          <p className="mb-4 text-xs font-bold uppercase tracking-[0.18em] text-lilac">Answers from your docs</p>
          <h1 id="hero-title" className="max-w-2xl text-4xl font-bold tracking-tight text-ink sm:text-6xl sm:leading-[1.05]">A helpful chatbot, built from what you already know.</h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-slate-600">Upload your support docs, check the answers, and add a grounded chat to your site when it is ready.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a className={primaryLink} href="/auth?mode=signup">Try DocChat free</a>
            <a className={secondaryLink} href="#how-it-works">See how it works</a>
          </div>
          <p className="mt-4 text-sm text-slate-500">No card required. Start with a private workspace.</p>
        </div>

        <Card className="overflow-hidden p-5 sm:p-6">
          <div className="border-b border-slate-100 pb-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-lilac">Example conversation</p>
            <div className="mt-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">Northstar support</p>
                <p className="text-xs text-slate-500">Example · 3 source documents</p>
              </div>
              <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">Private by default</span>
            </div>
          </div>
          <div className="space-y-4 py-5 text-sm leading-6">
            <div className="ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-lilac px-4 py-3 text-white">What does standard shipping cost?</div>
            <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3 text-slate-700">Standard shipping costs $8 and takes 3–5 business days. <span className="font-semibold">[SOURCE 1]</span></div>
          </div>
          <p className="px-1 text-xs text-slate-500">Source · shipping.md</p>
        </Card>
      </section>

      <section id="how-it-works" className="border-t border-slate-200/80 py-16 sm:py-20" aria-labelledby="how-title">
        <div className="max-w-2xl">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-lilac">A simple path to publish</p>
          <h2 id="how-title" className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Upload, test, then decide when to share.</h2>
          <p className="mt-4 text-base leading-7 text-slate-600">Your workspace starts private. You control the documents, answer review, and websites that can use the published chat.</p>
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <Card className="p-5"><p className="text-sm font-bold text-lilac">01</p><h3 className="mt-4 font-semibold text-ink">Upload</h3><p className="mt-2 text-sm leading-6 text-slate-500">Add TXT or Markdown support policies, FAQs, and product guides.</p></Card>
          <Card className="p-5"><p className="text-sm font-bold text-lilac">02</p><h3 className="mt-4 font-semibold text-ink">Test</h3><p className="mt-2 text-sm leading-6 text-slate-500">Ask real questions and inspect the source excerpts behind each answer.</p></Card>
          <Card className="p-5"><p className="text-sm font-bold text-lilac">03</p><h3 className="mt-4 font-semibold text-ink">Publish</h3><p className="mt-2 text-sm leading-6 text-slate-500">When answers look right, choose the website origins that may use your chat.</p></Card>
        </div>
      </section>

      <section id="pricing" className="border-t border-slate-200/80 py-16 sm:py-20" aria-labelledby="pricing-title">
        <div className="max-w-3xl">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-lilac">Simple test plans</p>
          <h2 id="pricing-title" className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Room to try it, with no payment step.</h2>
          <p className="mt-4 text-base leading-7 text-slate-600">Free and Pro are local mock plans for this MVP. No payment is collected, no card is required, and changing plans does not reset your data or monthly usage.</p>
        </div>
        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <Card className="p-6 sm:p-7">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-lilac">Start here</p>
            <div className="mt-3 flex items-end justify-between gap-3"><h3 className="text-2xl font-bold text-ink">Free</h3><p className="text-2xl font-bold text-ink">$0</p></div>
            <PlanLimits />
            <a className={`${secondaryLink} mt-7 w-full`} href="/auth?mode=signup">Start free</a>
          </Card>
          <Card className="bg-lilac/5 p-6 ring-lilac/30 sm:p-7">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-lilac">More room to test</p>
            <div className="mt-3 flex items-end justify-between gap-3"><h3 className="text-2xl font-bold text-ink">Pro</h3><p className="text-right text-2xl font-bold text-ink">$19 <span className="block text-xs font-medium text-slate-500">/ month (illustrative)</span></p></div>
            <PlanLimits pro />
            <a className={`${primaryLink} mt-7 w-full`} href="/auth?mode=signup">Explore Pro</a>
            <p className="mt-3 text-center text-xs text-slate-500">Mock plan · no live charge</p>
          </Card>
        </div>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200/80 py-6 text-xs text-slate-500">
        <div className="flex flex-wrap gap-4"><a className="hover:text-ink" href="#how-it-works">How it works</a><a className="hover:text-ink" href="#pricing">Pricing</a><a className="hover:text-ink" href="/auth">Sign in</a></div>
        <span>Private source files · answers with citations</span>
      </footer>
    </main>
  );
}
