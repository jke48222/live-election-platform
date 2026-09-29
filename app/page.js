import Link from "next/link";

/**
 * Landing page: a simple front door that points hosts to the dashboard and
 * shows the voter URL shape (/<org>/<election>).
 */
export default function Home() {
  // The seeded demo exists only in local development, or where DEMO_ELECTION
  // ("<org>/<election>") names one on purpose.
  const demo =
    process.env.DEMO_ELECTION || (process.env.NODE_ENV !== "production" ? "demo/spring-2026" : "");
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
        <p className="mt-5 text-lg text-slate-600 leading-relaxed">
          Presenter-paced voting with instant results and a choice of how voters prove they can
          vote. You host it yourself, and it calls no third-party services.
        </p>
        <div className="mt-8 flex flex-wrap gap-3 justify-center">
          <Link
            href="/admin"
            className="h-12 px-6 inline-flex items-center rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 transition-colors"
          >
            Create an election
          </Link>
          {demo && (
            <Link
              href={`/${demo.replace(/^\/+/, "")}`}
              className="h-12 px-6 inline-flex items-center rounded-xl border-2 border-slate-200 text-slate-900 font-bold hover:bg-white transition-colors"
            >
              View the demo ballot
            </Link>
          )}
        </div>
        <p className="mt-10 text-sm text-slate-600">
          Voters join at{" "}
          <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
            /your-org/your-election
          </code>
        </p>
      </section>
    </main>
  );
}
