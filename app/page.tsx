import { Card } from "@/components/ui/card";

const primaryLink = "inline-flex items-center justify-center rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac focus-visible:ring-offset-2";
const secondaryLink = "inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-ink ring-1 ring-slate-200 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac focus-visible:ring-offset-2";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 lg:px-10">
      <nav className="flex items-center justify-between">
        <a className="text-lg font-bold tracking-tight" href="#top" aria-label="DocChat home">doc<span className="text-lilac">chat</span></a>
        <a className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 transition hover:bg-white hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lilac" href="/auth">Sign in</a>
      </nav>
      <section id="top" className="grid flex-1 items-center gap-12 py-20 lg:grid-cols-[1.1fr_.9fr]">
        <div>
          <p className="mb-5 text-sm font-semibold uppercase tracking-[0.2em] text-lilac">Answers from your docs</p>
          <h1 className="max-w-2xl text-5xl font-bold leading-[1.05] tracking-tight text-ink sm:text-6xl">A helpful chatbot, built from what you already know.</h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600">Upload your support docs, check the answers, and add a grounded chat to your site when it is ready.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a className={primaryLink} href="/auth?mode=signup">Try DocChat</a>
            <a className={secondaryLink} href="#how-it-works">See how it works</a>
          </div>
        </div>
        <Card className="overflow-hidden p-5">
          <div className="mb-5 flex items-center justify-between border-b border-slate-100 pb-4">
            <div><p className="font-semibold">Northstar support</p><p className="text-xs text-slate-400">Grounded in 3 documents</p></div>
            <span className="h-3 w-3 rounded-full bg-emerald-400" aria-label="Online" />
          </div>
          <div className="space-y-4 text-sm">
            <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-lilac px-4 py-3 text-white">How long does shipping take?</div>
            <div className="max-w-[88%] rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3 leading-6 text-slate-700">Standard shipping takes 3–5 business days in the contiguous US. Orders of $100 or more ship free.</div>
            <p className="px-1 text-xs text-slate-400">Sources · shipping.md</p>
          </div>
        </Card>
      </section>
      <section id="how-it-works" className="grid gap-4 border-t border-slate-200 py-10 sm:grid-cols-3">
        <div><p className="text-sm font-semibold text-lilac">01 · Upload</p><p className="mt-2 text-sm leading-6 text-slate-600">Add the TXT and Markdown files your support team already trusts.</p></div>
        <div><p className="text-sm font-semibold text-lilac">02 · Test</p><p className="mt-2 text-sm leading-6 text-slate-600">Ask real questions and inspect the source excerpts behind each answer.</p></div>
        <div><p className="text-sm font-semibold text-lilac">03 · Publish later</p><p className="mt-2 text-sm leading-6 text-slate-600">Keep the bot private while you review it, then connect it to an allowed site.</p></div>
      </section>
      <footer className="flex flex-wrap gap-6 border-t border-slate-200 py-6 text-sm text-slate-500"><span>Private source files</span><span>Answers with citations</span><span>Free to test</span></footer>
    </main>
  );
}
