import Link from "next/link";

/**
 * Landing page. A full marketing site comes in Phase 7; for now this is a
 * simple front door pointing hosts to the dashboard and explaining the
 * canonical voter URL shape (/<org>/<election>).
 */
export default function Home() {
  return (
    <main className="min-h-dvh bg-slate-50 flex flex-col">
      <header className="px-6 py-4 flex items-center justify-between max-w-5xl mx-auto w-full">
        <span className="font-display font-black text-lg text-slate-900">Live Election Platform</span>
        <Link
          href="/admin"
          className="text-sm font-bold text-white bg-slate-900 px-4 py-2 rounded-lg hover:bg-slate-700 transition-colors"
        >
          Host sign in
        </Link>
      </header>

      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 max-w-2xl mx-auto">
        <h1 className="font-display font-black text-4xl sm:text-5xl text-slate-900 leading-tight">
          Run live, real-time elections for any organization.
        </h1>
        <p className="mt-5 text-lg text-slate-500 leading-relaxed">
          Presenter-paced voting with instant results, configurable eligibility, and your own
          branding — fully self-hosted, no third-party services.
        </p>
        <div className="mt-8 flex flex-wrap gap-3 justify-center">
          <Link
            href="/admin"
            className="h-12 px-6 inline-flex items-center rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 transition-colors"
          >
            Create an election
          </Link>
          <Link
            href="/demo/spring-2026"
            className="h-12 px-6 inline-flex items-center rounded-xl border-2 border-slate-200 text-slate-900 font-bold hover:bg-white transition-colors"
          >
            View the demo ballot
          </Link>
        </div>
        <p className="mt-10 text-sm text-slate-400">
          Voters join at{" "}
          <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">
            /your-org/your-election
          </code>
        </p>
      </section>

      <footer className="px-6 py-6 text-center text-xs text-slate-400">
        Free in beta.
      </footer>
    </main>
  );
}
