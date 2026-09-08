import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <section className="space-y-4 px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-espresso)]">
        Page not found
      </h1>
      <p className="text-[var(--color-ink-muted)]">
        The page you are looking for does not exist.
      </p>
      <Link
        to="/"
        className="inline-block font-medium text-[var(--color-sage-deep)] underline"
      >
        Back to home
      </Link>
    </section>
  )
}
