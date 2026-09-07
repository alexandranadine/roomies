import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-stone-600">
        The page you are looking for does not exist.
      </p>
      <Link to="/" className="inline-block text-stone-900 underline">
        Back to home
      </Link>
    </section>
  )
}
